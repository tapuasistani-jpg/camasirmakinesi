import {
  DEPO_AISLES,
  DEPO_QUERIES,
  aisleEntryUrl,
  aisleStartUrls,
  continueResultsUrl,
  depoQueryLabel,
  depoSearchUrl,
  elektronikPageUrl,
  isBlocked,
  keywordAisleUrl,
  nameSearchUrl,
  nextSearchPage,
  nodeFromUrl,
  nodeListingUrl,
  pageFlipUrl,
  pageSummary,
  parseSearchPage,
  scrollMoreUrl,
  seeAllResultsUrl,
  titleFits,
} from "@/lib/amazon";
import type { ProductCard } from "@/lib/amazon";
import {
  addLog,
  applyWatchHunt,
  enqueuePending,
  getConfig,
  insertAlert,
  listWatchQueries,
  needsFreshVerdict,
  readAisleCursors,
  readSetting,
  readState,
  tagAisle,
  upsertProduct,
  watchDrop,
  watchedAsins,
  writeAisle,
  writeAisleCursor,
  writeSetting,
  writeState,
} from "@/lib/db";
import { judgeOne, sendOne } from "@/lib/scan";
import { percentOff } from "@/lib/verdict";

// GitHub tarafı sayfayı indirir, burası sadece okur ve sıradaki adresi söyler.
export type Target = {
  kind: "tur" | "reyon" | "takip";
  label: string;
  url: string;
};

const TOUR_PAGE_CAP = 200;
const AISLE_PAGE_CAP = 40;
const FAST_AISLES = ["Yeni Gelenler", "Günün Fırsatları"];

function fingerprint(items: ProductCard[]): string {
  return items.map((item) => item.asin).sort().join(",").slice(0, 3000);
}

async function tourTarget(): Promise<Target> {
  const state = await readState();
  const query = state.queryText || DEPO_QUERIES[state.queryIndex % DEPO_QUERIES.length] || DEPO_QUERIES[0];
  const flip = /elektronik/i.test(query);
  let url = state.nextUrl;
  if (flip && url && !/[?&](?:page|pg)=\d/.test(url) && !/sr_pg_\d/.test(url)) url = null;
  if (!url) url = flip ? elektronikPageUrl(state.page) : depoSearchUrl(query, 1);
  return { kind: "tur", label: depoQueryLabel(query), url };
}

async function fastStart(label: string): Promise<Target> {
  return { kind: "reyon", label, url: aisleStartUrls(label)[0] };
}

async function aisleTarget(): Promise<Target> {
  const state = await readState();
  const aisle = DEPO_AISLES[state.aisleIndex % DEPO_AISLES.length];
  const cursors = await readAisleCursors();
  const saved = cursors[aisle.label];
  const tries = Number(await readSetting(`aisle_try_${aisle.label}`)) || 0;
  const candidates = aisleStartUrls(aisle.label);
  const url = saved?.url && !keywordAisleUrl(saved.url)
    ? saved.url
    : candidates[tries % candidates.length];
  return { kind: "reyon", label: aisle.label, url };
}

async function huntTarget(): Promise<Target> {
  const hunts = await listWatchQueries();
  if (!hunts.length) return tourTarget();
  const cursor = Number(await readSetting("watch_turn")) || 0;
  const hunt = hunts[cursor % hunts.length];
  await writeSetting("watch_turn", String((cursor + 1) % 1000));
  const depo = cursor % 2 === 1;
  return {
    kind: "takip",
    label: hunt.query,
    url: nameSearchUrl(hunt.query, depo),
  };
}

export async function nextTarget(): Promise<Target> {
  const turn = (Number(await readSetting("feed_turn")) || 0) + 1;
  await writeSetting("feed_turn", String(turn % 1000));
  const slot = turn % 6;
  if (slot === 0 || slot === 3) return fastStart(FAST_AISLES[0]);
  if (slot === 1 || slot === 4) return fastStart(FAST_AISLES[1]);
  if (slot === 2) return huntTarget();
  const slow = Number(await readSetting("slow_turn")) || 0;
  await writeSetting("slow_turn", String((slow + 1) % 1000));
  return slow % 2 === 0 ? aisleTarget() : tourTarget();
}

async function pingHunts(items: ProductCard[]): Promise<void> {
  const hunts = await listWatchQueries();
  if (!hunts.length) return;
  for (const hunt of hunts) {
    const matches = items.filter((item) => titleFits(item.title, hunt.query));
    if (!matches.length) continue;
    const cheapest = matches.reduce((best, item) => (item.price < best.price ? item : best));
    const drop = await applyWatchHunt(hunt.query, cheapest);
    if (!drop.hit) continue;
    const reference = drop.target && cheapest.price <= drop.target ? drop.target : drop.base;
    await insertAlert({
      asin: cheapest.asin,
      title: cheapest.title,
      url: cheapest.url,
      image: cheapest.image,
      price: cheapest.price,
      listPrice: cheapest.listPrice,
      highestPrice: reference,
      notify: true,
      verdict: {
        verdict: "evet",
        discount: Math.round(percentOff(cheapest.price, reference ?? cheapest.price) * 10) / 10,
        marketMedian: null,
        marketSamples: 0,
        detail: `Takip: "${hunt.query}" için Amazon'daki en ucuz satıcı ${Math.round(cheapest.price)} TL.`,
      },
    });
    await addLog("bilgi", `Takip "${hunt.query}" düştü: ${Math.round(cheapest.price)} TL.`);
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
      if (drop.hit) {
        const reference = drop.target && item.price <= drop.target ? drop.target : drop.base;
        await insertAlert({
          asin: item.asin,
          title: item.title,
          url: item.url,
          image: item.image,
          price: item.price,
          listPrice: item.listPrice,
          highestPrice: memory.highest,
          notify: true,
          verdict: {
            verdict: "evet",
            discount: Math.round(percentOff(item.price, reference ?? memory.highest) * 10) / 10,
            marketMedian: null,
            marketSamples: 0,
            detail: `Takip listendeki ürün düştü. Şimdi ${Math.round(item.price)} TL.`,
          },
        });
        await addLog("bilgi", `Takip: ${item.title.slice(0, 70)} düştü.`);
      }
    }
    const listOff = percentOff(item.price, item.listPrice);
    const memoryOff = memory.samples >= 2 ? percentOff(item.price, memory.trustedHigh) : 0;
    if (Math.max(listOff, memoryOff) < minDiscount) continue;
    if (!(await needsFreshVerdict(item.asin, item.price))) continue;
    await enqueuePending(item, memory);
  }
  await pingHunts(items);
  return count;
}

async function eatHunt(label: string, html: string, items: ProductCard[]): Promise<void> {
  const matches = items.filter((item) => titleFits(item.title, label));
  const config = await getConfig();
  if (matches.length) await remember(matches, config.minDiscount);
  const cheapest = matches.reduce((best: ProductCard | null, item) => (!best || item.price < best.price ? item : best), null);
  if (!cheapest) {
    await addLog("uyari", `Takip · "${label}" aramasında uygun ürün yok. ${pageSummary(html)}`);
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

  async function nextCategory(why: string): Promise<void> {
    await addLog("bilgi", `Amazon Depo "${label}" ${why} Sonraki kategori.`);
    await writeSetting("tour_mark", "");
    const index = state.queryText ? state.queryIndex : (state.queryIndex + 1) % DEPO_QUERIES.length;
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
  const generated = flip ? elektronikPageUrl(page + 1) : "";
  const more = flip
    ? (pageFlipUrl(html, url) || generated)
    : (continueResultsUrl(html, url) || nextSearchPage(url));
  if (!more || page >= TOUR_PAGE_CAP) {
    await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: ${seen} ürün. Kategori bitti, sonraki kategori.`);
    await writeSetting("tour_mark", "");
    const index = state.queryText ? state.queryIndex : (state.queryIndex + 1) % DEPO_QUERIES.length;
    await writeState(1, index, null, null, null);
    return;
  }
  await addLog("bilgi", `Amazon Depo "${label}" sayfa ${page}: ${seen} ürün. Sayfa ${page + 1}'e geçiliyor.`);
  await writeState(page + 1, state.queryIndex, null, flip && more === generated ? null : more, state.queryText);
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
  if (fast) {
    await addLog("bilgi", `Reyon · ${aisle.label} taze sayfa: ${seen} ürün. Biraz sonra yine bakılacak.`);
    await writeAisleCursor(aisle.label, { page: 1, url: null });
    return;
  }
  const more = page >= AISLE_PAGE_CAP ? null : (scrollMoreUrl(html, url) || nextSearchPage(url));
  if (!more) {
    await addLog("bilgi", `Reyon · ${aisle.label} sayfa ${page}: ${seen} ürün. Sonuna geldi, baştan bakacak.`);
    await nextAisle();
    return;
  }
  await addLog("bilgi", `Reyon · ${aisle.label} sayfa ${page}: ${seen} ürün. Aşağı iniliyor.`);
  await writeAisleCursor(aisle.label, { page: page + 1, url: more });
  await writeAisle((index + 1) % DEPO_AISLES.length, page + 1, null);
}

export async function eatPage(input: { kind: string; url: string; html: string; label?: string }): Promise<{
  ok: boolean;
  blocked: boolean;
  items: number;
  judged: number;
  sent: number;
  next: Target;
}> {
  const html = input.html || "";
  const url = input.url || "";
  let items: ProductCard[] = [];
  let blocked = false;
  if (!html || html.length < 500 || isBlocked(html)) {
    blocked = true;
    await addLog("uyari", `Sayfa okunamadı. ${pageSummary(html)}`);
  } else {
    items = parseSearchPage(html);
    if (input.kind === "takip") await eatHunt(input.label || "", html, items);
    else if (input.kind === "reyon") await eatAisle(url, html, items, input.label);
    else await eatTour(url, html, items);
  }
  const judged = await judgeOne();
  const sent = await sendOne();
  const extraJudged = await judgeOne();
  const extraSent = await sendOne();
  return { ok: !blocked, blocked, items: items.length, judged: judged + extraJudged, sent: sent + extraSent, next: await nextTarget() };
}
