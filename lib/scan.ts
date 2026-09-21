import { DEPO_QUERIES, USER_AGENT, depoQueryLabel, depoSearchUrl, isBlocked, parseSearchPage } from "@/lib/amazon";
import {
  addLog,
  bumpPending,
  dropPending,
  enqueuePending,
  getConfig,
  insertAlert,
  markNotified,
  needsFreshVerdict,
  nextUnsent,
  readState,
  takePending,
  upsertProduct,
  writeState,
} from "@/lib/db";
import { searchPrices } from "@/lib/market";
import { formatAlert, sendMessage } from "@/lib/telegram";
import { decide, percentOff } from "@/lib/verdict";

async function fetchAmazon(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.5",
      Accept: "text/html,application/xhtml+xml",
      Referer: "https://www.amazon.com.tr/",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Amazon ${response.status}`);
  return response.text();
}

async function judgeOne(): Promise<number> {
  const pending = await takePending();
  if (!pending) return 0;
  const asin = String(pending.asin);
  const tries = await bumpPending(asin);
  const price = Number(pending.price);
  const listPrice = pending.list_price == null ? null : Number(pending.list_price);
  const highest = pending.highest_price == null ? null : Number(pending.highest_price);
  const samples = Number(pending.samples ?? 1);
  const config = await getConfig();
  if (tries >= 3) {
    await insertAlert({
      asin,
      title: String(pending.title ?? ""),
      url: String(pending.url ?? ""),
      image: pending.image ? String(pending.image) : null,
      price,
      listPrice,
      highestPrice: highest,
      notify: false,
      verdict: {
        verdict: "kararsiz",
        discount: Math.round(percentOff(price, listPrice) * 10) / 10,
        marketMedian: null,
        marketSamples: 0,
        detail: "Net değil. Piyasa araması üç kez sonuç vermedi.",
      },
    });
    await dropPending(asin);
    return 1;
  }
  let marketPrices: number[] = [];
  try {
    marketPrices = await searchPrices(String(pending.title ?? ""), price);
  } catch (error) {
    const message = error instanceof Error ? error.message : "arama bozuldu";
    await addLog("uyari", `Piyasa araması bozuldu: ${message}`);
    return 0;
  }
  const verdict = decide({
    price,
    listPrice,
    highestPrice: highest,
    samples,
    marketPrices,
    threshold: config.minDiscount,
  });
  await dropPending(asin);
  if (!verdict) return 0;
  const notify = verdict.verdict === "evet" || (verdict.verdict === "hayir" && config.notifySuspicious);
  await insertAlert({
    asin,
    title: String(pending.title ?? ""),
    url: String(pending.url ?? ""),
    image: pending.image ? String(pending.image) : null,
    price,
    listPrice,
    highestPrice: highest,
    verdict,
    notify,
  });
  const label = verdict.verdict === "evet" ? "EVET" : verdict.verdict === "hayir" ? "HAYIR" : "NET DEĞİL";
  await addLog("bilgi", `${label}: ${String(pending.title ?? "").slice(0, 90)}`);
  return 1;
}

async function sendOne(): Promise<number> {
  const config = await getConfig();
  const alert = await nextUnsent();
  if (!alert) return 0;
  if (!config.token || !config.chatId) {
    await addLog("uyari", "Fırsat var ama Telegram ayarı boş.");
    return 0;
  }
  try {
    await sendMessage(config.token, config.chatId, formatAlert({
      title: String(alert.title ?? ""),
      verdict: String(alert.verdict ?? ""),
      price: Number(alert.price),
      list_price: alert.list_price == null ? null : Number(alert.list_price),
      highest_price: alert.highest_price == null ? null : Number(alert.highest_price),
      discount: Number(alert.discount),
      market_median: alert.market_median == null ? null : Number(alert.market_median),
      market_samples: Number(alert.market_samples ?? 0),
      detail: String(alert.detail ?? ""),
      url: String(alert.url ?? ""),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram gitmedi";
    await addLog("hata", `Telegram gitmedi: ${message}`);
    return 0;
  }
  await markNotified(Number(alert.id));
  await addLog("bilgi", `Telegram gitti: ${String(alert.title ?? "").slice(0, 80)}`);
  return 1;
}

function nextSearch(page: number, queryIndex: number, finished: boolean) {
  if (!finished && page < 20) return { page: page + 1, queryIndex };
  return { page: 1, queryIndex: (queryIndex + 1) % DEPO_QUERIES.length };
}

export async function scanOnce() {
  const config = await getConfig();
  const state = await readState();
  const page = state.page;
  const queryIndex = state.queryIndex % DEPO_QUERIES.length;
  const query = DEPO_QUERIES[queryIndex] ?? "";
  const label = depoQueryLabel(query);
  const url = depoSearchUrl(query, page);
  let html = "";
  try {
    html = await fetchAmazon(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "sayfa açılmadı";
    await addLog("hata", `Amazon Depo araması "${label}" sayfa ${page} açılmadı: ${message}`);
    await writeState(page, queryIndex, "Amazon sayfası açılmadı");
    return { ok: false, blocked: false, page, seen: 0, judged: 0, sent: 0 };
  }
  if (isBlocked(html)) {
    await addLog("hata", "Amazon erişimi kesti. Sonraki tura kalındı.");
    await writeState(page, queryIndex, "Amazon robot kontrolü gösterdi.");
    return { ok: true, blocked: true, page, seen: 0, judged: 0, sent: 0 };
  }
  const items = parseSearchPage(html);
  if (!items.length) {
    const next = nextSearch(page, queryIndex, true);
    await addLog("uyari", `Amazon Depo "${label}" sayfa ${page} boş. Sıradaki aramaya geçildi.`);
    await writeState(next.page, next.queryIndex, "Bu aramada başka ürün çıkmadı");
    return { ok: true, blocked: false, page, seen: 0, judged: 0, sent: 0 };
  }
  for (const item of items) {
    const memory = await upsertProduct(item);
    const listOff = percentOff(item.price, item.listPrice);
    const memoryOff = memory.samples >= 2 ? percentOff(item.price, memory.highest) : 0;
    if (Math.max(listOff, memoryOff) < config.minDiscount) continue;
    if (!(await needsFreshVerdict(item.asin, item.price))) continue;
    await enqueuePending(item, memory);
  }
  const judged = await judgeOne();
  const sent = await sendOne();
  const next = nextSearch(page, queryIndex, false);
  await writeState(next.page, next.queryIndex, null);
  await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: ${items.length} ürün, ${judged} karar.`);
  return { ok: true, blocked: false, page, seen: items.length, judged, sent };
}
