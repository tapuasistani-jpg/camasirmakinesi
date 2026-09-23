import {
  DEPO_AISLES,
  DEPO_QUERIES,
  aisleEntryUrl,
  aisleStartUrls,
  continueResultsUrl,
  depoQueryLabel,
  depoSearchUrl,
  elektronikPageUrl,
  hasNextPage,
  isBlocked,
  keywordAisleUrl,
  huntAsinsFromHtml,
  huntFloor,
  huntPick,
  nameSearchUrl,
  nextSearchPage,
  nodeFromUrl,
  nodeListingUrl,
  pageFlipUrl,
  pageSummary,
  parseProductPage,
  parseSearchPage,
  scrollMoreUrl,
  seeAllResultsUrl,
} from "@/lib/amazon";
import type { ProductCard } from "@/lib/amazon";
import {
  addLog,
  abandonWatchSeed,
  applyWatchHunt,
  enqueuePending,
  getConfig,
  openBak,
  listWatchQueries,
  needsFreshVerdict,
  nextRechecks,
  readAisleCursors,
  seedWatchAsin,
  readSetting,
  readState,
  tagAisle,
  touchLastScan,
  touchWatchHunt,
  upsertProduct,
  watchDrop,
  watchedAsins,
  writeAisle,
  writeAisleCursor,
  writeSetting,
  writeState,
} from "@/lib/db";
import { judgeOne, sendOne } from "@/lib/scan";
import { dealThreshold, deepMemoryDeal, percentOff } from "@/lib/verdict";

// GitHub tarafı sayfayı indirir, burası sadece okur ve sıradaki adresi söyler.
export type Target = {
  kind: "tur" | "reyon" | "takip" | "urun";
  label: string;
  url: string;
  extra?: Target[];
};

const TOUR_PAGE_CAP = 200;
const TOUR_STINT = 6;
const AISLE_PAGE_CAP = 40;
const FAST_AISLES = ["Yeni Gelenler", "Günün Fırsatları"];

function fingerprint(items: ProductCard[]): string {
  return items.map((item) => item.asin).sort().join(",").slice(0, 3000);
}

async function tourTarget(): Promise<Target> {
  const state = await readState();
  const query = state.queryText || DEPO_QUERIES[state.queryIndex % DEPO_QUERIES.length] || DEPO_QUERIES[0];
  const flip = /elektronik/i.test(query);
  let page = state.page;
  if (page <= 1 && !state.nextUrl) {
    const resume = Number(await readSetting(`tour_resume_${depoQueryLabel(query)}`)) || 0;
    if (resume > 1) {
      page = resume;
      await writeSetting("tour_resumed", "1");
      await writeSetting("tour_stint", "0");
      await writeState(page, state.queryIndex, null, null, state.queryText);
    }
  }
  let url = state.nextUrl;
  if (flip && url && !/[?&](?:page|pg)=\d/.test(url) && !/sr_pg_\d/.test(url)) url = null;
  if (!url) url = flip ? elektronikPageUrl(page) : depoSearchUrl(query, page);
  return { kind: "tur", label: depoQueryLabel(query), url };
}

async function fastStart(label: string): Promise<Target> {
  return { kind: "reyon", label, url: aisleStartUrls(label)[0] };
}

async function aisleByLabel(label: string): Promise<Target> {
  const cursors = await readAisleCursors();
  const saved = cursors[label];
  const tries = Number(await readSetting(`aisle_try_${label}`)) || 0;
  const candidates = aisleStartUrls(label);
  const url = saved?.url && !keywordAisleUrl(saved.url)
    ? saved.url
    : candidates[tries % candidates.length];
  return { kind: "reyon", label, url };
}

async function aisleTarget(): Promise<Target> {
  const state = await readState();
  const aisle = DEPO_AISLES[state.aisleIndex % DEPO_AISLES.length];
  return aisleByLabel(aisle.label);
}

async function huntTarget(): Promise<Target> {
  const hunts = await listWatchQueries();
  if (!hunts.length) return tourTarget();
  const fresh = Date.now() - 45 * 60 * 1000;
  const missing = hunts.filter((hunt) => {
    const empty = hunt.price == null || hunt.price < huntFloor(hunt.query);
    return empty && (hunt.triedAt == null || hunt.triedAt < fresh);
  });
  if (!missing.length) return tourTarget();
  const cursor = Number(await readSetting("watch_turn")) || 0;
  const seen = new Set<string>();
  const batch: { query: string }[] = [];
  for (let step = 0; step < missing.length && batch.length < 2; step += 1) {
    const hunt = missing[(cursor + step) % missing.length];
    if (seen.has(hunt.query)) continue;
    seen.add(hunt.query);
    batch.push(hunt);
  }
  await writeSetting("watch_turn", String((cursor + batch.length) % Math.max(missing.length, 1)));
  const pack: Target[] = [];
  for (const hunt of batch) {
    pack.push({ kind: "takip", label: hunt.query, url: nameSearchUrl(hunt.query, false) });
    pack.push({ kind: "takip", label: hunt.query, url: nameSearchUrl(hunt.query, true) });
  }
  const main = pack[0];
  main.extra = pack.slice(1);
  return main;
}

async function recheckTarget(): Promise<Target> {
  const batch = await nextRechecks(3);
  if (!batch.length) return tourTarget();
  const pack: Target[] = batch.map((item) => ({
    kind: "urun",
    label: item.title.slice(0, 50) || item.asin,
    url: item.url,
  }));
  const main = pack[0];
  main.extra = pack.slice(1);
  return main;
}

export async function nextTarget(): Promise<Target> {
  const turn = (Number(await readSetting("feed_turn")) || 0) + 1;
  await writeSetting("feed_turn", String(turn % 1000));
  const slot = turn % 8;
  if (slot === 0) return recheckTarget();
  if (slot === 1) return huntTarget();
  if (slot === 2) return fastStart("Yeni Gelenler");
  if (slot === 3) return tourTarget();
  if (slot === 4) return tourTarget();
  if (slot === 5) return aisleByLabel("Outlet");
  if (slot === 6) return fastStart("Günün Fırsatları");
  return tourTarget();
}

async function pingHunts(items: ProductCard[]): Promise<void> {
  const hunts = await listWatchQueries();
  if (!hunts.length) return;
  for (const hunt of hunts) {
    const matches = huntPick(items, hunt.query);
    if (!matches.length) continue;
    const cheapest = matches.reduce((best, item) => (item.price < best.price ? item : best));
    const drop = await applyWatchHunt(hunt.query, cheapest);
    if (!drop.hit || !drop.base) continue;
    await openBak(cheapest, drop.base);
    await enqueuePending(cheapest, { highest: drop.base, samples: 3 }, 2);
    await addLog("bilgi", `BAK takip "${hunt.query}" ${Math.round(cheapest.price)} TL, piyasa bakılacak.`);
  }
}

async function remember(items: ProductCard[], minDiscount: number): Promise<number> {
  let count = 0;
  const watched = await watchedAsins();
  for (const item of items) {
    const memory = await upsertProduct(item);
    count += 1;
    if (watched.has(item.asin)) {
      const drop = await watchDrop(item);
      if (drop.hit && drop.base) {
        await openBak(item, drop.base);
        await enqueuePending(item, { highest: drop.base, samples: 3 }, 2);
      }
    }
    const listOff = percentOff(item.price, item.listPrice);
    const memoryOff = memory.samples >= 2 ? percentOff(item.price, memory.trustedHigh) : 0;
    const gate = dealThreshold(memory.trustedHigh || item.listPrice || item.price, minDiscount, item.title);
    if (Math.max(listOff, memoryOff) < gate) continue;
    if (!(await needsFreshVerdict(item.asin, item.price))) continue;
    if (memoryOff >= gate && memory.trustedHigh && deepMemoryDeal(memoryOff, memory.samples, minDiscount)) {
      await openBak(item, memory.trustedHigh);
      await enqueuePending(item, memory, 2);
      await addLog("bilgi", `BAK hafıza: ${item.title.slice(0, 70)} ${Math.round(memory.trustedHigh)}→${Math.round(item.price)}`);
      continue;
    }
    await enqueuePending(item, memory, memoryOff >= gate ? 2 : listOff >= minDiscount ? 1 : 0);
  }
  await pingHunts(items);
  return count;
}

function huntMatches(items: ProductCard[], query: string): ProductCard[] {
  return huntPick(items, query);
}

async function eatHunt(label: string, html: string, items: ProductCard[]): Promise<void> {
  await touchWatchHunt(label);
  const matches = huntMatches(items, label);
  const config = await getConfig();
  if (matches.length) await remember(matches, config.minDiscount);
  const cheapest = matches.reduce((best: ProductCard | null, item) => (!best || item.price < best.price ? item : best), null);
  if (!cheapest) {
    const bare = huntAsinsFromHtml(html, label);
    if (bare[0]) {
      await seedWatchAsin(label, bare[0]);
      await addLog("bilgi", `Takip · "${label}" ürün bulundu, fiyat kartta yok. Ürün sayfasına bakılacak.`);
      return;
    }
    await addLog("uyari", `Takip · "${label}" ${items.length} ürün okundu, uygun yok. ${pageSummary(html)}`);
    return;
  }
  await addLog("bilgi", `Takip · "${label}" en ucuz satıcı ${Math.round(cheapest.price)} TL · ${matches.length} ilan.`);
}

async function eatTour(url: string, html: string, items: ProductCard[]): Promise<void> {
  const state = await readState();
  const query = state.queryText || DEPO_QUERIES[state.queryIndex % DEPO_QUERIES.length] || DEPO_QUERIES[0];
  const label = depoQueryLabel(query);
  const flip = /elektronik/i.test(query);
  const page = state.page;
  const mark = fingerprint(items);
  const sameAsBefore = mark.length > 0 && mark === (await readSetting("tour_mark"));

  async function nextCategory(why: string, resumePage = 1): Promise<void> {
    await addLog("bilgi", `Amazon Depo "${label}" ${why} Sonraki kategori.`);
    await writeSetting("tour_mark", "");
    await writeSetting("tour_stint", "0");
    await writeSetting("tour_resumed", "");
    await writeSetting(`tour_resume_${label}`, String(resumePage > 1 ? resumePage : 1));
    const current = DEPO_QUERIES.findIndex((name) => name.toLowerCase() === label.toLowerCase());
    const index = (current >= 0 ? current + 1 : state.queryIndex + 1) % DEPO_QUERIES.length;
    await writeState(1, index, null, null, null);
  }

  if (!items.length) {
    await nextCategory(`sayfa ${page}: ürün yok. ${pageSummary(html)}`);
    return;
  }
  if (sameAsBefore) {
    await nextCategory(`sayfa ${page}: aynı ürünler geldi, kategori bitti.`);
    return;
  }
  const config = await getConfig();
  const seen = await remember(items, config.minDiscount);
  await writeSetting("tour_mark", mark);
  const more = flip
    ? (pageFlipUrl(html, url) || (hasNextPage(html) ? elektronikPageUrl(page + 1) : null))
    : (continueResultsUrl(html, url) || nextSearchPage(url));
  if (!more || page >= TOUR_PAGE_CAP) {
    await nextCategory(`sayfa ${page}: ${seen} ürün. Kategori bitti.`, 1);
    return;
  }
  const stint = (Number(await readSetting("tour_stint")) || 0) + 1;
  await writeSetting("tour_stint", String(stint));
  const resumed = (await readSetting("tour_resumed")) === "1";
  if (stint >= TOUR_STINT || (!resumed && page >= TOUR_STINT)) {
    await nextCategory(`sayfa ${page}: ${seen} ürün. Altı sayfa bakıldı, sıradaki kategoriye geçiliyor.`, page + 1);
    return;
  }
  await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: ${seen} ürün. Sayfa ${page + 1}'e geçiliyor.`);
  await writeState(page + 1, state.queryIndex, null, flip && more === elektronikPageUrl(page + 1) ? null : more, state.queryText);
}

async function eatAisle(url: string, html: string, items: ProductCard[], labelHint?: string): Promise<void> {
  const state = await readState();
  const hinted = DEPO_AISLES.find((row) => row.label === labelHint);
  const index = hinted
    ? DEPO_AISLES.findIndex((row) => row.label === hinted.label)
    : state.aisleIndex % DEPO_AISLES.length;
  const aisle = DEPO_AISLES[index] || DEPO_AISLES[0];
  const cursors = await readAisleCursors();
  const page = cursors[aisle.label]?.page || 1;
  const tryKey = `aisle_try_${aisle.label}`;
  const fast = FAST_AISLES.includes(aisle.label);

  async function nextAisle(): Promise<void> {
    await writeAisleCursor(aisle.label, { page: 1, url: null });
    await writeAisle((index + 1) % DEPO_AISLES.length, 1, null);
  }

  if (!items.length) {
    const node = nodeFromUrl(url);
    const deeper = seeAllResultsUrl(html)
      || (node ? nodeListingUrl(html, node) : null)
      || aisleEntryUrl(html, aisle.match);
    if (deeper && deeper !== url) {
      await addLog("bilgi", `Reyon · ${aisle.label} ürün listesine giriliyor.`);
      await writeAisleCursor(aisle.label, { page: 1, url: deeper });
      if (!fast) await writeAisle((index + 1) % DEPO_AISLES.length, 1, null);
      return;
    }
    const tries = (Number(await readSetting(tryKey)) || 0) + 1;
    await writeSetting(tryKey, String(tries % aisleStartUrls(aisle.label).length));
    await addLog("uyari", `Reyon · ${aisle.label} sayfa ${page}: ürün kartı yok. ${pageSummary(html)} Başka adres denenecek.`);
    if (!fast) await nextAisle();
    return;
  }
  const config = await getConfig();
  const seen = await remember(items, config.minDiscount);
  await tagAisle(items.map((item) => item.asin), aisle.label);
  let pageNo = 1;
  try {
    pageNo = Number(new URL(url).searchParams.get("page") || String(page)) || page;
  } catch {
    pageNo = page;
  }
  const firstPage = pageNo <= 1;
  if (firstPage && fast) {
    const more = nextSearchPage(url) || scrollMoreUrl(html, url);
    const saved = cursors[aisle.label];
    if (more && (!saved?.url || (saved.page || 1) <= 1)) {
      await writeAisleCursor(aisle.label, { page: 2, url: more });
    }
    await addLog("bilgi", `Reyon · ${aisle.label} sayfa 1: ${seen} ürün. Taze bakıldı, arka sayfalar sırayla taranacak.`);
    return;
  }
  const more = pageNo >= AISLE_PAGE_CAP ? null : (scrollMoreUrl(html, url) || nextSearchPage(url));
  if (!more) {
    await addLog("bilgi", `Reyon · ${aisle.label} sayfa ${pageNo}: ${seen} ürün. Sonuna geldi, baştan bakacak.`);
    await writeAisleCursor(aisle.label, { page: 1, url: null });
    return;
  }
  await addLog("bilgi", `Reyon · ${aisle.label} sayfa ${pageNo}: ${seen} ürün. Sayfa ${pageNo + 1}'e iniliyor.`);
  await writeAisleCursor(aisle.label, { page: pageNo + 1, url: more });
}

export async function eatPage(input: { kind: string; url: string; html: string; label?: string; quiet?: boolean }): Promise<{
  ok: boolean;
  blocked: boolean;
  items: number;
  judged: number;
  sent: number;
  next: Target;
}> {
  const html = input.html || "";
  const url = input.url || "";
  await touchLastScan();
  const kindName = input.kind === "tur" ? "Tur" : input.kind === "reyon" ? "Reyon" : input.kind === "takip" ? "Takip" : input.kind === "urun" ? "Ürün" : "Tarama";
  await writeSetting("now_kind", input.kind || "tur");
  await writeSetting("now_label", input.label || kindName);
  if (input.kind === "tur" || input.kind === "reyon") {
    const state = await readState();
    await writeSetting("now_page", String(input.kind === "tur" ? state.page : state.aislePage));
  } else {
    await writeSetting("now_page", "");
  }
  let items: ProductCard[] = [];
  let blocked = false;
  if (!html || html.length < 500 || isBlocked(html)) {
    blocked = true;
    await addLog("uyari", `Sayfa okunamadı. ${pageSummary(html)}`);
  } else {
    items = parseSearchPage(html);
    if (input.kind === "urun") {
      const one = parseProductPage(html, url);
      items = one ? [one] : [];
      if (one) {
        const config = await getConfig();
        await remember([one], config.minDiscount);
        await addLog("bilgi", `Tekrar bakıldı: ${one.title.slice(0, 70)} · ${Math.round(one.price)} TL`);
        if (one.price < 3000) await abandonWatchSeed(one.asin);
      } else {
        const broken = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
        if (broken) await abandonWatchSeed(broken.toUpperCase());
        await addLog("uyari", `Ürün sayfası okunamadı. ${pageSummary(html)}`);
      }
    } else if (input.kind === "takip") await eatHunt(input.label || "", html, items);
    else if (input.kind === "reyon") await eatAisle(url, html, items, input.label);
    else await eatTour(url, html, items);
  }
  const rushed = (await sendOne()) + (await sendOne());
  const judged = (await judgeOne()) + (await judgeOne()) + (await judgeOne());
  const sent = rushed + (await sendOne()) + (await sendOne());
  return { ok: !blocked, blocked, items: items.length, judged, sent, next: input.quiet ? { kind: "tur", label: "", url: "" } : await nextTarget() };
}
