import { DEPO_AISLES, DEPO_QUERIES, USER_AGENT, aisleEntryUrl, aisleStartUrls, continueResultsUrl, continueTarget, depoQueryLabel, depoSearchUrl, elektronikPageUrl, isBlocked, keywordAisleUrl, nextSearchPage, pageFlipUrl, pageSummary, pageTurnUrl, parseSearchPage, scrollMoreUrl, seeAllResultsUrl } from "@/lib/amazon";
import type { ProductCard } from "@/lib/amazon";
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
  readAisleCursors,
  readRuntime,
  readState,
  setCooldown,
  writeCookies,
  tagAisle,
  takePending,
  writeAisle,
  writeAisleCursor,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Amazon peş peşe isteklerde 503 veriyor. Biraz bekleyip yeniden soruyoruz.
async function fetchAmazon(url: string, cookies: string): Promise<{ html: string; detail: string; cookies: string }> {
  let page = await requestAmazon(url, cookies, "https://www.amazon.com.tr/");
  for (let tries = 0; page.status >= 500 && tries < 2; tries += 1) {
    await sleep(1500 + tries * 2500);
    page = await requestAmazon(url, page.cookies, "https://www.amazon.com.tr/");
  }
  if (page.status >= 400 || isBlocked(page.html)) {
    const gate = continueTarget(page.html);
    if (gate.url && !gate.captcha) page = await requestAmazon(gate.url, page.cookies, url);
  }
  if (page.status >= 400 && !page.html.includes("data-asin=")) throw new Error(`Amazon ${page.status}`);
  await sleep(700);
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
// Reyonda çok derine inip tepedeki yeni fırsatları kaçırmasın.
const AISLE_PAGE_CAP = 40;
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
  const seenUrls = new Set<string>();
  let elektronikNode = true;
  let seen = 0;
  let pages = 0;
  let label = depoQueryLabel(DEPO_QUERIES[queryIndex] ?? "");

  // Amazon kapıyı kapattıysa üstüne gitmeyelim, blok uzuyor.
  const runtime = await readRuntime();
  if (!manual && runtime.coolUntil > Date.now()) {
    const left = Math.ceil((runtime.coolUntil - Date.now()) / 60000);
    return { ok: true, blocked: true, page, seen: 0, pages: 0, judged: await judgeOne(), sent: await sendOne(), wait: left };
  }
  let cookies = runtime.cookies;
  if (!cookies || Date.now() - runtime.cookiesAt > 30 * 60 * 1000) {
    const home = await requestAmazon("https://www.amazon.com.tr/", "", "https://www.amazon.com.tr/");
    cookies = home.cookies;
    await writeCookies(cookies);
  }

  async function coolDown(minutes: number, why: string): Promise<void> {
    await setCooldown(Date.now() + minutes * 60_000);
    await addLog("uyari", `Amazon kapıyı kapattı (${why}). ${minutes} dakika ara veriliyor, sonra devam.`);
  }

  async function remember(items: ProductCard[]): Promise<number> {
    let count = 0;
    for (const item of items) {
      const memory = await upsertProduct(item);
      count += 1;
      const listOff = percentOff(item.price, item.listPrice);
      const memoryOff = memory.samples >= 2 ? percentOff(item.price, memory.highest) : 0;
      if (Math.max(listOff, memoryOff) < config.minDiscount) continue;
      if (!(await needsFreshVerdict(item.asin, item.price))) continue;
      await enqueuePending(item, memory);
    }
    return count;
  }

  const aisleIndex = state.aisleIndex % DEPO_AISLES.length;
  if (!manual) {
    const aisle = DEPO_AISLES[aisleIndex];
    const cursors = await readAisleCursors();
    const saved = cursors[aisle.label];
    const seenHere = new Set<string>();
    let page = saved && saved.page > 0 ? saved.page : 1;
    let url: string | null = saved?.url && !keywordAisleUrl(saved.url) ? saved.url : null;
    let steps = 0;
    let restart = false;
    if (!url) {
      page = 1;
      let lastError = "";
      for (const candidate of aisleStartUrls(aisle.label)) {
        if (Date.now() - started > 15_000) break;
        try {
          const trial = await fetchAmazon(candidate, cookies);
          cookies = trial.cookies;
          if (isBlocked(trial.html) || parseSearchPage(trial.html).length === 0) continue;
          url = candidate;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : "açılmadı";
          continue;
        }
      }
      if (!url && /Amazon 5\d\d/.test(lastError)) {
        await coolDown(10, lastError);
      } else if (!url) {
        await addLog("uyari", `Reyon · ${aisle.label} şu an açılmıyor. Sıradaki reyon.`);
      } else {
        await addLog("bilgi", `Reyon · ${aisle.label} baştan açıldı.`);
      }
    }
    while (url && Date.now() - started < 18_000 && steps < 3) {
      try {
        const loaded = await fetchAmazon(url, cookies);
        cookies = loaded.cookies;
        if (isBlocked(loaded.html)) {
          await addLog("uyari", `Reyon · ${aisle.label} açılmadı. ${loaded.detail}`);
          break;
        }
        const deals = parseSearchPage(loaded.html);
        const fresh = deals.filter((item) => !seenHere.has(item.asin));
        fresh.forEach((item) => seenHere.add(item.asin));
        if (!deals.length) {
          const deeper = aisleEntryUrl(loaded.html, aisle.match);
          if (deeper && deeper !== url) {
            await addLog("bilgi", `Reyon · ${aisle.label} içine giriliyor.`);
            url = deeper;
            steps += 1;
            continue;
          }
          await addLog("uyari", `Reyon · ${aisle.label} sayfa ${page}: ürün kartı yok. Baştan bakacak.`);
          restart = true;
          break;
        }
        seen += await remember(fresh);
        await tagAisle(fresh.map((item) => item.asin), aisle.label);
        steps += 1;
        const more: string | null = page >= AISLE_PAGE_CAP
          ? null
          : (scrollMoreUrl(loaded.html, url) || nextSearchPage(url));
        if (!more) {
          await addLog("bilgi", `Reyon · ${aisle.label} sonuna geldi. Baştan bakacak.`);
          restart = true;
          break;
        }
        await addLog("bilgi", `Reyon · ${aisle.label} sayfa ${page}: ${fresh.length} ürün. Aşağı iniliyor.`);
        page += 1;
        url = more;
      } catch (error) {
        const message = error instanceof Error ? error.message : "açılmadı";
        if (/Amazon 5\d\d/.test(message)) await coolDown(10, message);
        else await addLog("uyari", `Reyon · ${aisle.label} açılmadı: ${message}`);
        break;
      }
    }
    await writeAisleCursor(aisle.label, restart ? { page: 1, url: null } : { page, url });
    await writeAisle((aisleIndex + 1) % DEPO_AISLES.length, page, null);
  }

  while (Date.now() - started < TIME_BUDGET_MS && pages < 6) {
    const query = pinned || (DEPO_QUERIES[queryIndex] ?? "");
    label = depoQueryLabel(query);
    const flip = /elektronik/i.test(query);
    if (flip && nextUrl && !/[?&](?:page|pg)=\d/.test(nextUrl) && !/sr_pg_\d/.test(nextUrl)) nextUrl = null;
    const url = flip
      ? (nextUrl || (elektronikNode ? elektronikPageUrl(page) : pageTurnUrl(query, page)))
      : (nextUrl || depoSearchUrl(query, 1));
    let html = "";
    let detail = "";
    try {
      const loaded = await fetchAmazon(url, cookies);
      html = loaded.html;
      detail = loaded.detail;
      cookies = loaded.cookies;
    } catch (error) {
      const message = error instanceof Error ? error.message : "sayfa açılmadı";
      if (/Amazon 5\d\d/.test(message)) await coolDown(10, message);
      else await addLog("hata", `Amazon Depo "${label}" açılmadı: ${message}`);
      await writeCookies("");
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
    seenUrls.add(url);
    if (flip && elektronikNode && page === 1 && items.length === 0) {
      elektronikNode = false;
      await addLog("uyari", `Elektronik kategori listesi açılmadı. ${detail} Arama kutusundan devam.`);
      pages += 1;
      continue;
    }
    const generatedNext = flip ? (elektronikNode ? elektronikPageUrl(page + 1) : pageTurnUrl(query, page + 1)) : "";
    let more = flip ? (pageFlipUrl(html, url) || (fresh.length > 0 && page < PAGE_CAP ? generatedNext : null)) : continueResultsUrl(html, url);
    const seeAll = seeAllResultsUrl(html);
    if (!flip && items.length > 0 && fresh.length === 0 && seeAll && seeAll !== url && !seenUrls.has(seeAll)) {
      await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: aynı ürünler geldi. Tüm sonuçları gör var, listeye giriliyor.`);
      nextUrl = seeAll;
      page += 1;
      pages += 1;
      continue;
    }
    if (!more && items.length > 0 && fresh.length > 0) more = nextSearchPage(url);
    if (items.length > 0 && fresh.length === 0) {
      await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: yeni ürün kalmadı. Bu kategori bitti, sonraki kategori.`);
      if (pinned) pinned = null;
      else queryIndex = (queryIndex + 1) % DEPO_QUERIES.length;
      page = 1;
      nextUrl = null;
      seenAsins.clear();
      seenUrls.clear();
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
      seenUrls.clear();
      pages += 1;
      continue;
    }
    seen += await remember(fresh);
    pages += 1;
    if (more && page < PAGE_CAP) {
      const turned = generatedNext;
      await addLog("bilgi", flip
        ? `Amazon Depo "${label}" sayfa ${page}: ${fresh.length} ürün. Sayfa ${page + 1}'e geçiliyor.`
        : `Amazon Depo "${label}" sayfa ${page}: ${fresh.length} ürün. Sonraki sayfa var, iniliyor.`);
      nextUrl = flip && more === turned ? null : more;
      page += 1;
      continue;
    }
    await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: ${fresh.length} ürün. Bu kategori bitti, sonraki kategori.`);
    if (pinned) pinned = null;
    else queryIndex = (queryIndex + 1) % DEPO_QUERIES.length;
    page = 1;
    nextUrl = null;
    seenAsins.clear();
    seenUrls.clear();
  }

  const judged = await judgeOne();
  const sent = await sendOne();
  await writeCookies(cookies);
  await writeState(page, queryIndex, null, nextUrl, pinned);
  await addLog("bilgi", `Tur bitti. "${label}" sayfa ${page}. Bu çağrıda ${pages} sayfa, ${seen} ürün. Kategori bitene kadar devam eder.`);
  return { ok: true, blocked: false, page, seen, pages, judged, sent };
}
