import { DEPO_QUERIES, USER_AGENT, continueResultsUrl, continueTarget, depoQueryLabel, depoSearchUrl, isBlocked, nextSearchPage, pageSummary, parseSearchPage } from "@/lib/amazon";
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

const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "sec-ch-ua": '"Chromium";v="128", "Google Chrome";v="128", "Not;A=Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

function mergeCookies(existing: string, response: Response): string {
  const jar = new Map<string, string>();
  for (const part of existing.split(";").map((item) => item.trim()).filter(Boolean)) {
    const cut = part.indexOf("=");
    if (cut > 0) jar.set(part.slice(0, cut), part.slice(cut + 1));
  }
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const baked = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const rows = baked.length ? baked : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
  for (const raw of rows) {
    const pair = raw.split(";")[0] || "";
    const cut = pair.indexOf("=");
    if (cut > 0) jar.set(pair.slice(0, cut).trim(), pair.slice(cut + 1).trim());
  }
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function requestAmazon(url: string, cookies: string, referer: string): Promise<{ html: string; status: number; cookies: string }> {
  const response = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Cookie: cookies, Referer: referer },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  const html = await response.text();
  return { html, status: response.status, cookies: mergeCookies(cookies, response) };
}

async function fetchAmazon(url: string, cookies: string): Promise<{ html: string; detail: string; cookies: string }> {
  let page = await requestAmazon(url, cookies, "https://www.amazon.com.tr/");
  if (page.status >= 400 || isBlocked(page.html)) {
    const gate = continueTarget(page.html);
    if (gate.url && !gate.captcha) page = await requestAmazon(gate.url, page.cookies, url);
  }
  if (page.status >= 400 && !page.html.includes("data-asin=")) throw new Error(`Amazon ${page.status}`);
  return { html: page.html, detail: pageSummary(page.html), cookies: page.cookies };
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

const PAGE_CAP = 200;
const TIME_BUDGET_MS = 45_000;

function manualQuery(raw: string | undefined): string {
  const text = (raw || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!text || /[<>]/.test(text) || /^https?:/i.test(text)) return "";
  return text;
}

export async function scanOnce(onlyRaw?: string) {
  const manual = manualQuery(onlyRaw);
  const config = await getConfig();
  const state = await readState();
  let page = manual ? 1 : state.page;
  let queryIndex = state.queryIndex % DEPO_QUERIES.length;
  let nextUrl = manual ? null : state.nextUrl;
  let pinned = manual || state.queryText;
  const started = Date.now();
  const seenAsins = new Set<string>();
  let seen = 0;
  let pages = 0;
  let label = depoQueryLabel(DEPO_QUERIES[queryIndex] ?? "");
  const home = await requestAmazon("https://www.amazon.com.tr/", "", "https://www.amazon.com.tr/");
  let cookies = home.cookies;

  while (Date.now() - started < TIME_BUDGET_MS && pages < 10) {
    const query = pinned || (DEPO_QUERIES[queryIndex] ?? "");
    label = depoQueryLabel(query);
    const url = nextUrl || depoSearchUrl(query, 1);
    let html = "";
    let detail = "";
    try {
      const loaded = await fetchAmazon(url, cookies);
      html = loaded.html;
      detail = loaded.detail;
      cookies = loaded.cookies;
    } catch (error) {
      const message = error instanceof Error ? error.message : "sayfa açılmadı";
      await addLog("hata", `Amazon Depo "${label}" açılmadı: ${message}`);
      await writeState(page, queryIndex, "Amazon sayfası açılmadı", nextUrl, pinned);
      return { ok: false, blocked: true, page, seen, pages, judged: 0, sent: 0 };
    }
    if (isBlocked(html)) {
      await addLog("hata", `Amazon robot sayfası verdi, liste sayılmadı. ${detail}`);
      await writeState(page, queryIndex, "Amazon robot kontrolü gösterdi.", nextUrl, pinned);
      return { ok: true, blocked: true, page, seen, pages, judged: 0, sent: 0 };
    }
    const items = parseSearchPage(html);
    const fresh = items.filter((item) => !seenAsins.has(item.asin));
    fresh.forEach((item) => seenAsins.add(item.asin));
    let more = continueResultsUrl(html, url);
    if (!more && items.length > 0 && fresh.length > 0) more = nextSearchPage(url);
    if (items.length > 0 && fresh.length === 0) {
      await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: yeni ürün kalmadı. Bu kategori bitti, sonraki kategori.`);
      if (pinned) pinned = null;
      else queryIndex = (queryIndex + 1) % DEPO_QUERIES.length;
      page = 1;
      nextUrl = null;
      seenAsins.clear();
      pages += 1;
      continue;
    }
    if (!items.length && !more) {
      await addLog("uyari", `"${label}" ürün listesi değil ve sonraki sayfa yok. ${detail} Sonraki kategoriye geçildi.`);
      if (pinned) pinned = null;
      else queryIndex = (queryIndex + 1) % DEPO_QUERIES.length;
      page = 1;
      nextUrl = null;
      seenAsins.clear();
      pages += 1;
      continue;
    }
    for (const item of fresh) {
      const memory = await upsertProduct(item);
      seen += 1;
      const listOff = percentOff(item.price, item.listPrice);
      const memoryOff = memory.samples >= 2 ? percentOff(item.price, memory.highest) : 0;
      if (Math.max(listOff, memoryOff) < config.minDiscount) continue;
      if (!(await needsFreshVerdict(item.asin, item.price))) continue;
      await enqueuePending(item, memory);
    }
    pages += 1;
    if (more && page < PAGE_CAP) {
      await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: ${fresh.length} ürün. Sonraki sayfa var, iniliyor.`);
      nextUrl = more;
      page += 1;
      continue;
    }
    await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: ${fresh.length} ürün. Bu kategori bitti, sonraki kategori.`);
    if (pinned) pinned = null;
    else queryIndex = (queryIndex + 1) % DEPO_QUERIES.length;
    page = 1;
    nextUrl = null;
    seenAsins.clear();
  }

  const judged = await judgeOne();
  const sent = await sendOne();
  await writeState(page, queryIndex, null, nextUrl, pinned);
  await addLog("bilgi", `Tur bitti. "${label}" sayfa ${page}. Bu çağrıda ${pages} sayfa, ${seen} ürün. Kategori bitene kadar devam eder.`);
  return { ok: true, blocked: false, page, seen, pages, judged, sent };
}
