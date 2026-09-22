import {
  DEPO_AISLES,
  DEPO_QUERIES,
  aisleStartUrls,
  continueResultsUrl,
  depoQueryLabel,
  depoSearchUrl,
  elektronikPageUrl,
  isBlocked,
  keywordAisleUrl,
  nextSearchPage,
  pageFlipUrl,
  pageSummary,
  parseSearchPage,
  scrollMoreUrl,
} from "@/lib/amazon";
import type { ProductCard } from "@/lib/amazon";
import {
  addLog,
  enqueuePending,
  getConfig,
  needsFreshVerdict,
  readAisleCursors,
  readSetting,
  readState,
  tagAisle,
  upsertProduct,
  writeAisle,
  writeAisleCursor,
  writeSetting,
  writeState,
} from "@/lib/db";
import { judgeOne, sendOne } from "@/lib/scan";
import { percentOff } from "@/lib/verdict";

// GitHub tarafı sayfayı indirir, burası sadece okur ve sıradaki adresi söyler.
export type Target = {
  kind: "tur" | "reyon";
  label: string;
  url: string;
};

const TOUR_PAGE_CAP = 200;
const AISLE_PAGE_CAP = 40;
const AISLE_EVERY = 4;

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

export async function nextTarget(): Promise<Target> {
  const turn = (Number(await readSetting("feed_turn")) || 0) + 1;
  await writeSetting("feed_turn", String(turn % 1000));
  return turn % AISLE_EVERY === 0 ? aisleTarget() : tourTarget();
}

async function remember(items: ProductCard[], minDiscount: number): Promise<number> {
  let count = 0;
  for (const item of items) {
    const memory = await upsertProduct(item);
    count += 1;
    const listOff = percentOff(item.price, item.listPrice);
    const memoryOff = memory.samples >= 2 ? percentOff(item.price, memory.highest) : 0;
    if (Math.max(listOff, memoryOff) < minDiscount) continue;
    if (!(await needsFreshVerdict(item.asin, item.price))) continue;
    await enqueuePending(item, memory);
  }
  return count;
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

async function eatAisle(url: string, html: string, items: ProductCard[]): Promise<void> {
  const state = await readState();
  const index = state.aisleIndex % DEPO_AISLES.length;
  const aisle = DEPO_AISLES[index];
  const cursors = await readAisleCursors();
  const page = cursors[aisle.label]?.page || 1;
  const tryKey = `aisle_try_${aisle.label}`;

  async function nextAisle(): Promise<void> {
    await writeAisleCursor(aisle.label, { page: 1, url: null });
    await writeAisle((index + 1) % DEPO_AISLES.length, 1, null);
  }

  if (!items.length) {
    const tries = (Number(await readSetting(tryKey)) || 0) + 1;
    await writeSetting(tryKey, String(tries % aisleStartUrls(aisle.label).length));
    await addLog("uyari", `Reyon · ${aisle.label} sayfa ${page}: ürün kartı yok. Başka adres denenecek.`);
    await nextAisle();
    return;
  }
  const config = await getConfig();
  const seen = await remember(items, config.minDiscount);
  await tagAisle(items.map((item) => item.asin), aisle.label);
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

export async function eatPage(input: { kind: string; url: string; html: string }): Promise<{
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
    if (input.kind === "reyon") await eatAisle(url, html, items);
    else await eatTour(url, html, items);
  }
  const judged = await judgeOne();
  const sent = await sendOne();
  return { ok: !blocked, blocked, items: items.length, judged, sent, next: await nextTarget() };
}
