import { neon } from "@neondatabase/serverless";

import { DEPO_AISLES, DEPO_QUERIES, SEARCH_URL, depoQueryLabel, fakeListPrice, huntFloor, keepNewPrice, priceBelongs, titleFits } from "@/lib/amazon";
import type { ProductCard } from "@/lib/amazon";
import type { Status } from "@/lib/types";
import { cameBackToOldPrice, dealThreshold, realSaleHigh, percentOff, type Verdict } from "@/lib/verdict";

type Sql = ReturnType<typeof neon>;
type Row = Record<string, unknown>;

let schema: Promise<void> | null = null;

export function databaseUrl(): string | null {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || null;
}

function db(): Sql {
  const url = databaseUrl();
  if (!url) throw new Error("POSTGRES_URL yok");
  return neon(url);
}

export async function ensureSchema(): Promise<void> {
  if (!schema) {
    schema = migrate().catch((error) => {
      schema = null;
      throw error;
    });
  }
  await schema;
}

async function migrate(): Promise<void> {
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS products (
    asin TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    image TEXT,
    condition TEXT,
    last_price DOUBLE PRECISION,
    list_price DOUBLE PRECISION,
    highest_price DOUBLE PRECISION,
    lowest_price DOUBLE PRECISION,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS price_points (
    id BIGSERIAL PRIMARY KEY,
    asin TEXT,
    price DOUBLE PRECISION,
    list_price DOUBLE PRECISION,
    seen_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS alerts (
    id BIGSERIAL PRIMARY KEY,
    asin TEXT,
    title TEXT,
    url TEXT,
    image TEXT,
    price DOUBLE PRECISION,
    list_price DOUBLE PRECISION,
    highest_price DOUBLE PRECISION,
    discount DOUBLE PRECISION,
    market_median DOUBLE PRECISION,
    market_samples INT,
    verdict TEXT,
    detail TEXT,
    wants_notify INT DEFAULT 0,
    notified INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS pending (
    asin TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    image TEXT,
    price DOUBLE PRECISION,
    list_price DOUBLE PRECISION,
    highest_price DOUBLE PRECISION,
    samples INT,
    tries INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS scan_log (
    id BIGSERIAL PRIMARY KEY,
    level TEXT,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS scan_state (
    id INT PRIMARY KEY,
    page INT NOT NULL,
    last_error TEXT,
    last_scan_at TIMESTAMPTZ
  )`;
  await sql`INSERT INTO scan_state (id, page) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`;
  await sql`ALTER TABLE scan_state ADD COLUMN IF NOT EXISTS query_index INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE scan_state ADD COLUMN IF NOT EXISTS next_url TEXT`;
  await sql`ALTER TABLE scan_state ADD COLUMN IF NOT EXISTS query_text TEXT`;
  await sql`ALTER TABLE scan_state ADD COLUMN IF NOT EXISTS aisle_index INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE scan_state ADD COLUMN IF NOT EXISTS aisle_page INT NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE scan_state ADD COLUMN IF NOT EXISTS aisle_url TEXT`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS aisle TEXT`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS aisle_seen TIMESTAMPTZ`;
  await sql`CREATE TABLE IF NOT EXISTS watch (
    asin TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    image TEXT,
    target_price DOUBLE PRECISION,
    base_price DOUBLE PRECISION,
    added_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS watch_query (
    query TEXT PRIMARY KEY,
    target_price DOUBLE PRECISION,
    base_price DOUBLE PRECISION,
    cheapest_asin TEXT,
    cheapest_price DOUBLE PRECISION,
    title TEXT,
    url TEXT,
    image TEXT,
    added_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`ALTER TABLE watch ADD COLUMN IF NOT EXISTS highest_price DOUBLE PRECISION`;
  await sql`ALTER TABLE watch_query ADD COLUMN IF NOT EXISTS highest_price DOUBLE PRECISION`;
  await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS dismissed INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE pending ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE watch ADD COLUMN IF NOT EXISTS high_samples INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE watch_query ADD COLUMN IF NOT EXISTS high_samples INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE watch_query ADD COLUMN IF NOT EXISTS hunt_tried_at TIMESTAMPTZ`;
  await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS telegram_id TEXT`;
}

export async function addWatch(asin: string, targetPrice: number | null): Promise<void> {
  const sql = db();
  const rows = (await sql`SELECT title, url, image, last_price FROM products WHERE asin = ${asin}`) as Row[];
  const row = rows[0];
  await sql`INSERT INTO watch (asin, title, url, image, target_price, base_price)
    VALUES (
      ${asin},
      ${row ? String(row.title ?? "") : ""},
      ${row ? String(row.url ?? `https://www.amazon.com.tr/dp/${asin}`) : `https://www.amazon.com.tr/dp/${asin}`},
      ${row?.image ? String(row.image) : null},
      ${targetPrice},
      ${num(row?.last_price)}
    )
    ON CONFLICT (asin) DO UPDATE SET target_price = EXCLUDED.target_price`;
}

export async function removeWatch(asin: string): Promise<void> {
  await db()`DELETE FROM watch WHERE asin = ${asin}`;
}

export async function addWatchQuery(query: string, targetPrice: number | null): Promise<void> {
  const name = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (name.length < 3) throw new Error("ürün adını biraz daha uzun yaz");
  await db()`INSERT INTO watch_query (query, target_price)
    VALUES (${name}, ${targetPrice})
    ON CONFLICT (query) DO UPDATE SET target_price = EXCLUDED.target_price`;
}

export async function removeWatchQuery(query: string): Promise<void> {
  await db()`DELETE FROM watch_query WHERE query = ${query}`;
}

export async function listWatchQueries(): Promise<{
  query: string;
  target: number | null;
  base: number | null;
  price: number | null;
  triedAt: number | null;
}[]> {
  const rows = (await db()`SELECT query, target_price, base_price, cheapest_price, hunt_tried_at FROM watch_query ORDER BY added_at ASC`) as Row[];
  return rows.map((row) => ({
    query: String(row.query),
    target: num(row.target_price),
    base: num(row.base_price),
    price: num(row.cheapest_price),
    triedAt: row.hunt_tried_at ? new Date(String(row.hunt_tried_at)).getTime() : null,
  }));
}

export async function touchWatchHunt(query: string): Promise<void> {
  await db()`UPDATE watch_query SET hunt_tried_at = NOW() WHERE query = ${query}`;
}

export async function abandonWatchSeed(asin: string): Promise<void> {
  await db()`UPDATE watch_query SET cheapest_asin = NULL
    WHERE cheapest_asin = ${asin} AND (cheapest_price IS NULL OR cheapest_price <= 0)`;
}

export async function applyWatchHunt(query: string, item: ProductCard): Promise<{ hit: boolean; base: number | null; target: number | null }> {
  if (!titleFits(item.title, query) || !priceBelongs(item.title, item.price)) {
    return { hit: false, base: null, target: null };
  }
  const sql = db();
  const rows = (await sql`SELECT highest_price, base_price, cheapest_price, high_samples FROM watch_query WHERE query = ${query}`) as Row[];
  if (!rows.length) return { hit: false, base: null, target: null };
  const seen = await observedHigh(item.asin);
  const prevHigh = seen.high;
  const config = await getConfig();
  const gate = prevHigh != null ? dealThreshold(prevHigh, config.minDiscount, item.title) : config.minDiscount;
  const drop = prevHigh != null ? percentOff(item.price, prevHigh) : 0;
  const hit = Boolean(prevHigh && drop >= gate && seen.samples >= 2);
  await sql`UPDATE watch_query SET
    cheapest_asin = ${item.asin},
    cheapest_price = ${item.price},
    title = ${item.title},
    url = ${item.url},
    image = COALESCE(${item.image}, image),
    base_price = LEAST(COALESCE(base_price, ${item.price}), ${item.price}),
    highest_price = ${prevHigh ?? item.price},
    high_samples = ${seen.samples}
    WHERE query = ${query}`;
  return { hit, base: prevHigh, target: null };
}

export async function watchedAsins(): Promise<Set<string>> {
  const rows = (await db()`SELECT asin FROM watch`) as Row[];
  return new Set(rows.map((row) => String(row.asin)));
}

// Takip edilen ürün düştü mü: hedefin altına indi ya da gördüğümüz en iyi fiyatı geçti.
export async function watchDrop(item: ProductCard): Promise<{ hit: boolean; base: number | null; target: number | null }> {
  const sql = db();
  const rows = (await sql`SELECT highest_price, base_price, high_samples FROM watch WHERE asin = ${item.asin}`) as Row[];
  if (!rows.length) return { hit: false, base: null, target: null };
  const seen = await observedHigh(item.asin);
  const prevHigh = seen.high;
  const config = await getConfig();
  const gate = prevHigh != null ? dealThreshold(prevHigh, config.minDiscount, item.title) : config.minDiscount;
  const drop = prevHigh != null ? percentOff(item.price, prevHigh) : 0;
  const hit = Boolean(prevHigh && drop >= gate && seen.samples >= 2);
  await sql`UPDATE watch SET
    title = COALESCE(NULLIF(${item.title}, ''), title),
    url = ${item.url},
    image = COALESCE(${item.image}, image),
    base_price = LEAST(COALESCE(base_price, ${item.price}), ${item.price}),
    highest_price = ${prevHigh ?? item.price},
    high_samples = ${seen.samples}
    WHERE asin = ${item.asin}`;
  return { hit, base: prevHigh, target: null };
}

export async function priceHistory(asin: string): Promise<{ price: number; seenAt: string | null }[]> {
  const rows = (await db()`SELECT price, seen_at FROM price_points WHERE asin = ${asin} ORDER BY id DESC LIMIT 30`) as Row[];
  return rows.map((row) => ({ price: num(row.price) ?? 0, seenAt: iso(row.seen_at) }));
}

export async function pinCategory(category: string): Promise<void> {
  const state = await readState();
  await db()`UPDATE settings SET value = '' WHERE key = 'tour_mark'`;
  await writeState(1, state.queryIndex, null, null, category);
  await addLog("bilgi", `Sıraya alındı: "${category}". Sıradaki sayfa bu kategoriden çekilecek.`);
}

export type AisleCursor = { page: number; url: string | null };

export async function readAisleCursors(): Promise<Record<string, AisleCursor>> {
  const map = await settingsMap();
  try {
    const parsed = JSON.parse(map.aisle_cursor || "{}") as Record<string, AisleCursor>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeAisleCursor(label: string, cursor: AisleCursor): Promise<void> {
  const all = await readAisleCursors();
  all[label] = { page: cursor.page, url: cursor.url };
  await putSetting("aisle_cursor", JSON.stringify(all).slice(0, 4000));
}

export async function readRuntime(): Promise<{ cookies: string; cookiesAt: number; coolUntil: number }> {
  const map = await settingsMap();
  return {
    cookies: map.amazon_cookies || "",
    cookiesAt: Number(map.amazon_cookies_at || 0) || 0,
    coolUntil: Number(map.cool_until || 0) || 0,
  };
}

export async function writeCookies(cookies: string): Promise<void> {
  await putSetting("amazon_cookies", cookies.slice(0, 3000));
  await putSetting("amazon_cookies_at", String(Date.now()));
}

export async function readSetting(key: string): Promise<string> {
  const map = await settingsMap();
  return map[key] || "";
}

export async function writeSetting(key: string, value: string): Promise<void> {
  await putSetting(key, value.slice(0, 4000));
}

export async function setCooldown(untilMs: number): Promise<void> {
  await putSetting("cool_until", String(Math.round(untilMs)));
}

export async function tagAisle(asins: string[], label: string): Promise<void> {
  if (!asins.length) return;
  await db()`UPDATE products SET aisle = ${label}, aisle_seen = NOW() WHERE asin = ANY(${asins})`;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function mask(token: string): string {
  if (!token) return "";
  if (token.length < 10) return "kayıtlı";
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

export function validTemplate(value: string | null | undefined): string | null {
  const url = (value || "").trim();
  if (!url.startsWith("https://www.amazon.com.tr/") || !url.includes("{page}")) return null;
  return url;
}

async function settingsMap(): Promise<Record<string, string>> {
  const rows = (await db()`SELECT key, value FROM settings`) as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value ?? "")]));
}

export async function getConfig() {
  await ensureSchema();
  const map = await settingsMap();
  const min = Number(map.min_discount || process.env.MIN_DISCOUNT || 50);
  return {
    token: map.bot_token || process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: map.chat_id || process.env.TELEGRAM_CHAT_ID || "",
    minDiscount: Math.min(95, Math.max(20, Number.isFinite(min) ? min : 50)),
    notifySuspicious: map.notify_suspicious === "1",
    urlTemplate: validTemplate(map.url_template) || SEARCH_URL,
  };
}

async function putSetting(key: string, value: string): Promise<void> {
  await db()`INSERT INTO settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

export async function saveSettings(input: {
  botToken?: string;
  clearToken?: boolean;
  chatId?: string;
  minDiscount?: number;
  notifySuspicious?: boolean;
  urlTemplate?: string;
}): Promise<void> {
  await ensureSchema();
  if (input.clearToken) await putSetting("bot_token", "");
  const token = (input.botToken || "").trim();
  if (token && !token.includes("••••")) await putSetting("bot_token", token);
  if (input.chatId != null) await putSetting("chat_id", input.chatId.trim());
  if (input.minDiscount != null && Number.isFinite(input.minDiscount)) {
    await putSetting("min_discount", String(Math.min(95, Math.max(20, Math.round(input.minDiscount)))));
  }
  if (input.notifySuspicious != null) await putSetting("notify_suspicious", input.notifySuspicious ? "1" : "0");
  if (input.urlTemplate) {
    const url = validTemplate(input.urlTemplate);
    if (!url) throw new Error("Adres https://www.amazon.com.tr/ ile başlamalı ve {page} içermeli");
    await putSetting("url_template", url);
  }
}

export async function addLog(level: string, message: string): Promise<void> {
  const sql = db();
  await sql`INSERT INTO scan_log (level, message) VALUES (${level}, ${message.slice(0, 500)})`;
  await sql`DELETE FROM scan_log WHERE id NOT IN (SELECT id FROM scan_log ORDER BY id DESC LIMIT 200)`;
  console.log(`[${level}] ${message}`);
}

export async function observedHigh(asin: string): Promise<{ high: number | null; samples: number; history: number[] }> {
  const points = (await db()`SELECT price FROM price_points WHERE asin = ${asin} ORDER BY seen_at ASC, id ASC`) as Row[];
  const history = points.map((row) => Number(row.price)).filter((price) => Number.isFinite(price) && price > 0);
  return {
    high: cameBackToOldPrice(history) ? null : realSaleHigh(history),
    samples: history.length,
    history,
  };
}

export async function upsertProduct(item: ProductCard): Promise<{ highest: number; samples: number; inserted: boolean; trustedHigh: number | null }> {
  const sql = db();
  const existing = (await sql`SELECT * FROM products WHERE asin = ${item.asin}`) as Row[];
  if (!existing.length) {
    if (!keepNewPrice(item.title, null, item.price)) {
      return { highest: item.price, samples: 0, inserted: false, trustedHigh: null };
    }
    await sql`INSERT INTO products (
      asin, title, url, image, condition, last_price, list_price, highest_price, lowest_price, first_seen, last_seen
    ) VALUES (
      ${item.asin}, ${item.title}, ${item.url}, ${item.image}, ${item.condition},
      ${item.price}, ${item.listPrice}, ${item.price}, ${item.price}, NOW(), NOW()
    )`;
    await sql`INSERT INTO price_points (asin, price, list_price) VALUES (${item.asin}, ${item.price}, ${item.listPrice})`;
    return { highest: item.price, samples: 1, inserted: true, trustedHigh: item.price };
  }
  const row = existing[0];
  const previous = num(row.last_price) ?? item.price;
  if (!keepNewPrice(item.title, previous, item.price)) {
    const seen = await observedHigh(item.asin);
    await sql`UPDATE products SET last_seen = NOW(), highest_price = ${seen.high ?? previous} WHERE asin = ${item.asin}`;
    return {
      highest: seen.high ?? previous,
      samples: seen.samples || 1,
      inserted: false,
      trustedHigh: seen.high,
    };
  }
  const lowest = Math.min(num(row.lowest_price) ?? item.price, item.price);
  const storedList = num(row.list_price);
  const incoming = item.listPrice != null && fakeListPrice(item.title, item.price, item.listPrice) ? null : item.listPrice;
  const keptStored = storedList != null && !fakeListPrice(item.title, item.price, storedList) ? storedList : null;
  const listPrice = incoming ?? keptStored;
  const inserted = Math.abs(previous - item.price) > 0.009;
  if (inserted) {
    await sql`INSERT INTO price_points (asin, price, list_price) VALUES (${item.asin}, ${item.price}, ${listPrice})`;
  }
  const seen = await observedHigh(item.asin);
  const highest = seen.high ?? item.price;
  await sql`UPDATE products SET
    title = ${item.title},
    url = ${item.url},
    image = COALESCE(${item.image}, image),
    condition = COALESCE(NULLIF(${item.condition}, ''), condition),
    last_price = ${item.price},
    list_price = ${listPrice},
    highest_price = ${highest},
    lowest_price = ${lowest},
    last_seen = NOW()
    WHERE asin = ${item.asin}`;
  return { highest, samples: seen.samples || 1, inserted, trustedHigh: seen.high };
}

export async function needsFreshVerdict(asin: string, price: number): Promise<boolean> {
  const rows = (await db()`SELECT price, verdict, created_at FROM alerts WHERE asin = ${asin} ORDER BY id DESC LIMIT 1`) as Row[];
  const row = rows[0];
  if (!row || num(row.price) == null) return true;
  const old = num(row.price) as number;
  if (price < old * 0.9) return true;
  if (Math.abs(old - price) / Math.max(price, 1) > 0.08) return true;
  if (row.verdict === "kararsiz") {
    const seen = new Date(String(row.created_at)).getTime();
    if (Date.now() - seen > 12 * 60 * 60 * 1000) return true;
  }
  return false;
}

export async function enqueuePending(item: ProductCard, memory: { highest: number; samples: number }, priority = 0): Promise<void> {
  await db()`INSERT INTO pending (asin, title, url, image, price, list_price, highest_price, samples, tries, priority)
    VALUES (${item.asin}, ${item.title}, ${item.url}, ${item.image}, ${item.price}, ${item.listPrice}, ${memory.highest}, ${memory.samples}, 0, ${priority})
    ON CONFLICT (asin) DO UPDATE SET
      title = EXCLUDED.title,
      price = EXCLUDED.price,
      list_price = EXCLUDED.list_price,
      highest_price = EXCLUDED.highest_price,
      samples = EXCLUDED.samples,
      priority = GREATEST(pending.priority, EXCLUDED.priority)`;
}

export async function takePending(): Promise<Row | null> {
  const rows = (await db()`SELECT * FROM pending ORDER BY priority DESC, created_at DESC LIMIT 1`) as Row[];
  return rows[0] ?? null;
}

export async function seedWatchAsin(query: string, item: { asin: string; title: string; url: string }): Promise<void> {
  await db()`UPDATE watch_query SET
    cheapest_asin = ${item.asin},
    title = COALESCE(NULLIF(title, ''), ${item.title}),
    url = ${item.url}
    WHERE query = ${query} AND (cheapest_price IS NULL OR cheapest_price <= 0)`;
}

export async function nextRechecks(limit = 3): Promise<{ asin: string; title: string; url: string }[]> {
  const take = Math.max(1, Math.min(limit, 5));
  const missing = (await db()`
    SELECT q.cheapest_asin AS asin, COALESCE(NULLIF(q.title, ''), q.query) AS title, q.url
    FROM watch_query q
    LEFT JOIN products p ON p.asin = q.cheapest_asin
    WHERE q.cheapest_asin IS NOT NULL
      AND (q.cheapest_price IS NULL OR q.cheapest_price <= 0)
      AND (p.last_seen IS NULL OR p.last_seen < NOW() - INTERVAL '2 hours')
    ORDER BY q.added_at ASC
    LIMIT ${take}
  `) as Row[];
  const found: { asin: string; title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const row of missing) {
    const asin = String(row.asin ?? "");
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);
    found.push({
      asin,
      title: String(row.title ?? ""),
      url: String(row.url || `https://www.amazon.com.tr/dp/${asin}`),
    });
  }
  if (found.length >= take) return found;
  const rows = (await db()`
    SELECT p.asin, p.title, p.url, p.last_price
    FROM products p
    LEFT JOIN watch w ON w.asin = p.asin
    LEFT JOIN watch_query q ON q.cheapest_asin = p.asin
    WHERE p.last_price > 0
      AND p.last_seen > NOW() - INTERVAL '5 days'
      AND (
        ((w.asin IS NOT NULL OR q.query IS NOT NULL OR p.last_price >= 10000)
          AND p.last_seen < NOW() - INTERVAL '4 minutes')
        OR
        (w.asin IS NULL AND q.query IS NULL AND p.last_price < 10000
          AND p.last_seen < NOW() - INTERVAL '12 minutes')
      )
    ORDER BY
      CASE WHEN w.asin IS NOT NULL OR q.query IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN p.last_price >= 10000 THEN 0 ELSE 1 END,
      p.last_seen ASC
    LIMIT ${take}
  `) as Row[];
  for (const row of rows) {
    const asin = String(row.asin);
    if (seen.has(asin)) continue;
    seen.add(asin);
    found.push({ asin, title: String(row.title ?? ""), url: `https://www.amazon.com.tr/dp/${asin}` });
    if (found.length >= take) break;
  }
  return found;
}

export async function bumpPending(asin: string): Promise<number> {
  const rows = (await db()`UPDATE pending SET tries = tries + 1 WHERE asin = ${asin} RETURNING tries`) as Row[];
  return num(rows[0]?.tries) ?? 1;
}

export async function dropPending(asin: string): Promise<void> {
  await db()`DELETE FROM pending WHERE asin = ${asin}`;
}

export async function insertAlert(input: {
  asin: string;
  title: string;
  url: string;
  image: string | null;
  price: number;
  listPrice: number | null;
  highestPrice: number | null;
  verdict: Verdict;
  notify: boolean;
}): Promise<void> {
  const verdict = input.verdict;
  await db()`INSERT INTO alerts (
    asin, title, url, image, price, list_price, highest_price, discount,
    market_median, market_samples, verdict, detail, wants_notify, notified
  ) VALUES (
    ${input.asin}, ${input.title}, ${input.url}, ${input.image}, ${input.price}, ${input.listPrice},
    ${input.highestPrice}, ${verdict.discount}, ${verdict.marketMedian}, ${verdict.marketSamples},
    ${verdict.verdict}, ${verdict.detail}, ${input.notify ? 1 : 0}, 0
  )`;
}

export async function hideAlert(id: number): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) return;
  await db()`UPDATE alerts SET dismissed = 1
    WHERE asin = (SELECT asin FROM alerts WHERE id = ${id})
       OR id = ${id}`;
}

export async function nextUnsent(): Promise<Row | null> {
  const rows = (await db()`SELECT * FROM alerts WHERE wants_notify = 1 AND notified = 0 ORDER BY id ASC LIMIT 1`) as Row[];
  return rows[0] ?? null;
}

export async function markNotified(id: number, telegramId?: number | null): Promise<void> {
  if (telegramId != null) {
    await db()`UPDATE alerts SET notified = 1, telegram_id = ${String(telegramId)} WHERE id = ${id}`;
    return;
  }
  await db()`UPDATE alerts SET notified = 1 WHERE id = ${id}`;
}

export async function openBak(item: ProductCard, highest: number | null): Promise<boolean> {
  const recent = (await db()`SELECT id FROM alerts
    WHERE asin = ${item.asin}
      AND price > 0
      AND ABS(price - ${item.price}) / GREATEST(price, ${item.price}, 1) <= 0.08
      AND created_at > NOW() - INTERVAL '12 hours'
    LIMIT 1`) as Row[];
  if (recent.length) return false;
  const open = (await db()`SELECT id FROM alerts
    WHERE asin = ${item.asin} AND verdict = 'bak' AND COALESCE(dismissed, 0) = 0 LIMIT 1`) as Row[];
  if (open.length) return false;
  const was = highest && highest > item.price ? highest : null;
  const off = percentOff(item.price, was);
  await insertAlert({
    asin: item.asin,
    title: item.title,
    url: item.url,
    image: item.image,
    price: item.price,
    listPrice: item.listPrice,
    highestPrice: was,
    notify: true,
    verdict: {
      verdict: "bak",
      discount: Math.round(off * 10) / 10,
      marketMedian: null,
      marketSamples: 0,
      detail: `Bak. Depo ${Math.round(item.price)} TL${was ? `, biz ${Math.round(was)} TL görmüştük` : ""}. Piyasa bakılıyor, stok kaçmasın.`,
    },
  });
  return true;
}

export async function closeBak(asin: string): Promise<{ telegramId: number; title: string; url: string; price: number }[]> {
  const rows = (await db()`SELECT telegram_id, title, url, price FROM alerts
    WHERE asin = ${asin} AND verdict = 'bak' AND COALESCE(dismissed, 0) = 0`) as Row[];
  await db()`UPDATE alerts SET dismissed = 1 WHERE asin = ${asin} AND verdict = 'bak'`;
  return rows
    .map((row) => ({
      telegramId: Number(row.telegram_id),
      title: String(row.title ?? ""),
      url: String(row.url ?? ""),
      price: num(row.price) ?? 0,
    }))
    .filter((row) => Number.isFinite(row.telegramId) && row.telegramId > 0);
}

export async function countProducts(): Promise<number> {
  await ensureSchema();
  const rows = (await db()`SELECT COUNT(*)::int AS n FROM products`) as Row[];
  return num(rows[0]?.n) ?? 0;
}

export async function readState(): Promise<{ page: number; queryIndex: number; nextUrl: string | null; queryText: string | null; aisleIndex: number; aislePage: number; aisleUrl: string | null; lastError: string | null; lastScanAt: string | null }> {
  await ensureSchema();
  const rows = (await db()`SELECT page, query_index, next_url, query_text, aisle_index, aisle_page, aisle_url, last_error, last_scan_at FROM scan_state WHERE id = 1`) as Row[];
  const row = rows[0];
  const nextUrl = row?.next_url ? String(row.next_url) : null;
  const queryText = row?.query_text ? String(row.query_text).trim() : "";
  return {
    page: Math.max(1, num(row?.page) ?? 1),
    queryIndex: Math.max(0, num(row?.query_index) ?? 0),
    nextUrl: nextUrl && nextUrl.startsWith("https://www.amazon.com.tr/") ? nextUrl : null,
    queryText: queryText ? queryText.slice(0, 80) : null,
    aisleIndex: Math.max(0, num(row?.aisle_index) ?? 0),
    aislePage: Math.max(1, num(row?.aisle_page) ?? 1),
    aisleUrl: row?.aisle_url && String(row.aisle_url).startsWith("https://www.amazon.com.tr/") ? String(row.aisle_url) : null,
    lastError: row?.last_error ? String(row.last_error) : null,
    lastScanAt: iso(row?.last_scan_at),
  };
}

export async function writeState(
  page: number,
  queryIndex: number,
  lastError: string | null,
  nextUrl: string | null = null,
  queryText: string | null = null,
): Promise<void> {
  await db()`UPDATE scan_state SET page = ${page}, query_index = ${queryIndex}, next_url = ${nextUrl}, query_text = ${queryText}, last_error = ${lastError}, last_scan_at = NOW() WHERE id = 1`;
}

export async function writeAisle(index: number, page: number, url: string | null): Promise<void> {
  await db()`UPDATE scan_state SET aisle_index = ${index}, aisle_page = ${page}, aisle_url = ${url} WHERE id = 1`;
}

export async function touchLastScan(): Promise<void> {
  await db()`UPDATE scan_state SET last_scan_at = NOW() WHERE id = 1`;
}

function blankStatus(message: string): Status {
  return {
    ready: false,
    message,
    page: 1,
    search: "Amazon Depo · boş arama",
    aisle: DEPO_AISLES[0].label,
    aislePage: 1,
    aisles: DEPO_AISLES.map((row) => ({ label: row.label, page: 1, count: 0 })),
    aisleItems: [],
    aisleAlerts: [],
    watch: [],
    pendingCount: 0,
    productCount: 0,
    dealCount: 0,
    lastScanAt: null,
    lastError: null,
    minDiscount: 50,
    hasToken: false,
    tokenHint: "",
    chatId: "",
    notifySuspicious: false,
    urlTemplate: SEARCH_URL,
    alerts: [],
    recent: [],
    logs: [],
  };
}

async function healPhantomHighs(): Promise<void> {
  const sql = db();
  await sql`UPDATE products p SET highest_price = s.high
    FROM (SELECT asin, MAX(price) AS high FROM price_points GROUP BY asin) s
    WHERE p.asin = s.asin AND COALESCE(p.highest_price, 0) > s.high * 1.04`;
  await sql`UPDATE pending p SET highest_price = s.high
    FROM (SELECT asin, MAX(price) AS high FROM price_points GROUP BY asin) s
    WHERE p.asin = s.asin AND COALESCE(p.highest_price, 0) > s.high * 1.04`;
  await sql`UPDATE watch w SET highest_price = s.high
    FROM (SELECT asin, MAX(price) AS high FROM price_points GROUP BY asin) s
    WHERE w.asin = s.asin AND COALESCE(w.highest_price, 0) > s.high * 1.04`;
  await sql`UPDATE watch_query w SET highest_price = s.high
    FROM (SELECT asin, MAX(price) AS high FROM price_points GROUP BY asin) s
    WHERE w.cheapest_asin = s.asin AND COALESCE(w.highest_price, 0) > s.high * 1.04`;
  const highs = (await sql`SELECT asin, MAX(price) AS high FROM price_points GROUP BY asin`) as Row[];
  const byAsin = new Map(highs.map((row) => [String(row.asin), num(row.high)]));
  const alerts = (await sql`SELECT id, asin, title, price, highest_price, verdict
    FROM alerts WHERE COALESCE(dismissed, 0) = 0 AND highest_price IS NOT NULL`) as Row[];
  for (const row of alerts) {
    const honest = byAsin.get(String(row.asin)) ?? null;
    const stored = num(row.highest_price);
    if (honest == null || stored == null || stored <= honest * 1.04) continue;
    const price = Number(row.price);
    const off = percentOff(price, honest);
    const gate = dealThreshold(honest, 20, String(row.title ?? ""));
    if (String(row.verdict) === "evet" && off < gate) {
      await sql`UPDATE alerts SET highest_price = ${honest}, dismissed = 1 WHERE id = ${row.id}`;
    } else {
      await sql`UPDATE alerts SET highest_price = ${honest} WHERE id = ${row.id}`;
    }
  }
}

async function dropFakeUnitDeals(): Promise<void> {
  const sql = db();
  await healPhantomHighs();
  const alerts = (await sql`SELECT id, title, price, list_price FROM alerts WHERE price > 0 AND list_price > price * 4`) as Row[];
  for (const row of alerts) {
    if (!fakeListPrice(String(row.title ?? ""), Number(row.price), num(row.list_price))) continue;
    await sql`DELETE FROM alerts WHERE id = ${row.id}`;
  }
  const waiting = (await sql`SELECT asin, title, price, list_price FROM pending WHERE price > 0 AND list_price > price * 4`) as Row[];
  for (const row of waiting) {
    if (!fakeListPrice(String(row.title ?? ""), Number(row.price), num(row.list_price))) continue;
    await sql`DELETE FROM pending WHERE asin = ${String(row.asin)}`;
  }
  const goods = (await sql`SELECT asin, title, last_price, list_price FROM products WHERE last_price > 0 AND list_price > last_price * 4`) as Row[];
  for (const row of goods) {
    if (!fakeListPrice(String(row.title ?? ""), Number(row.last_price), num(row.list_price))) continue;
    await sql`UPDATE products SET list_price = NULL WHERE asin = ${String(row.asin)}`;
  }
  // Piyasadan eşiğin altında kalan sahte EVET'leri sil. Telegram'a gidenler kalsın.
  await sql`DELETE FROM alerts WHERE verdict = 'evet' AND COALESCE(notified, 0) = 0 AND market_median IS NOT NULL AND price > market_median * 0.55 AND detail NOT LIKE 'Takip%' AND detail NOT LIKE 'Evet. Bu ürünü%'`;
  await sql`DELETE FROM alerts WHERE verdict = 'evet' AND COALESCE(notified, 0) = 0 AND detail LIKE 'Takip%' AND (market_median IS NULL OR market_samples = 0 OR price > COALESCE(market_median, 0) * 0.85)`;
  await sql`DELETE FROM alerts WHERE verdict = 'evet' AND COALESCE(notified, 0) = 0 AND (market_median IS NULL OR market_samples = 0) AND detail NOT LIKE 'Takip%' AND detail NOT LIKE 'Evet.%' AND detail NOT LIKE 'Piyasa bulunamadı%'`;
  await sql`DELETE FROM alerts a
    WHERE a.verdict = 'evet'
      AND COALESCE(a.notified, 0) = 0
      AND a.detail LIKE 'Evet. Bu ürünü%'
      AND EXISTS (
        SELECT 1 FROM price_points p
        WHERE p.asin = a.asin
          AND a.price > 0
          AND ABS(p.price - a.price) / a.price <= 0.08
          AND p.seen_at < COALESCE(
            (SELECT MIN(p2.seen_at) FROM price_points p2
              WHERE p2.asin = a.asin AND p2.price >= COALESCE(a.highest_price, 0) * 0.92),
            NOW()
          )
      )`;
  const bogus = (await sql`SELECT id, title, price FROM alerts WHERE verdict = 'evet' AND COALESCE(dismissed, 0) = 0`) as Row[];
  for (const row of bogus) {
    if (priceBelongs(String(row.title ?? ""), Number(row.price))) continue;
    await sql`UPDATE alerts SET dismissed = 1 WHERE id = ${row.id}`;
  }
  const hunts = (await sql`SELECT query, title FROM watch_query WHERE COALESCE(title, '') <> ''`) as Row[];
  for (const row of hunts) {
    const query = String(row.query ?? "");
    const title = String(row.title ?? "");
    if (!query || !title || titleFits(title, query)) continue;
    await sql`UPDATE watch_query SET
      cheapest_asin = NULL,
      cheapest_price = NULL,
      title = '',
      url = NULL,
      image = NULL,
      highest_price = NULL,
      high_samples = 0,
      base_price = NULL
      WHERE query = ${query}`;
  }
}

export async function getStatus(): Promise<Status> {
  if (!databaseUrl()) {
    return blankStatus("Postgres bağlı değil. Vercel'de Storage → Create Database → Postgres.");
  }
  await ensureSchema();
  await dropFakeUnitDeals();
  const sql = db();
  const config = await getConfig();
  const state = await readState();
  const query = state.queryText || DEPO_QUERIES[state.queryIndex % DEPO_QUERIES.length] || "";
  const nowKind = await readSetting("now_kind");
  const nowLabel = await readSetting("now_label");
  const nowPage = Number(await readSetting("now_page")) || 0;
  const kindName = nowKind === "tur" ? "Tur" : nowKind === "reyon" ? "Reyon" : nowKind === "takip" ? "Takip" : nowKind === "urun" ? "Ürün" : "";
  const search = nowLabel
    ? `${kindName || "Tarama"} · ${nowLabel}`
    : `Amazon Depo · ${depoQueryLabel(query)}`;
  const products = (await sql`SELECT COUNT(*)::int AS n FROM products`) as Row[];
  const deals = (await sql`SELECT COUNT(*)::int AS n FROM alerts WHERE verdict = 'evet' AND COALESCE(dismissed, 0) = 0`) as Row[];
  const alerts = (await sql`SELECT * FROM alerts WHERE COALESCE(dismissed, 0) = 0 ORDER BY id DESC LIMIT 40`) as Row[];
  const recent = (await sql`SELECT asin, title, url, image, last_price, list_price FROM products ORDER BY last_seen DESC LIMIT 8`) as Row[];
  const logs = (await sql`SELECT level, message, created_at FROM scan_log ORDER BY id DESC LIMIT 40`) as Row[];
  const aisle = DEPO_AISLES[state.aisleIndex % DEPO_AISLES.length] ?? DEPO_AISLES[0];
  const cursors = await readAisleCursors();
  const aisleCounts = (await sql`SELECT aisle, COUNT(*)::int AS n FROM products WHERE aisle IS NOT NULL GROUP BY aisle`) as Row[];
  const aisleSeen = (await sql`SELECT asin, title, url, image, last_price, list_price, highest_price, aisle
    FROM products WHERE aisle IS NOT NULL ORDER BY aisle_seen DESC NULLS LAST LIMIT 12`) as Row[];
  const aisleAlerts = (await sql`SELECT a.* FROM alerts a
    JOIN products p ON p.asin = a.asin AND p.aisle IS NOT NULL
    WHERE COALESCE(a.dismissed, 0) = 0
    ORDER BY a.id DESC LIMIT 20`) as Row[];
  const alertView = (row: Row) => ({
    id: num(row.id) ?? 0,
    asin: String(row.asin),
    title: String(row.title ?? ""),
    url: String(row.url ?? ""),
    image: row.image ? String(row.image) : null,
    price: num(row.price) ?? 0,
    listPrice: num(row.list_price),
    highestPrice: num(row.highest_price),
    discount: num(row.discount) ?? 0,
    marketMedian: num(row.market_median),
    verdict: String(row.verdict ?? ""),
    detail: String(row.detail ?? ""),
    createdAt: iso(row.created_at),
  });
  const watchRows = (await sql`SELECT w.asin, w.title, w.url, w.image, w.target_price, w.base_price, p.last_price
    FROM watch w LEFT JOIN products p ON p.asin = w.asin ORDER BY w.added_at DESC LIMIT 30`) as Row[];
  const huntRows = (await sql`SELECT query, title, url, image, target_price, base_price, cheapest_asin, cheapest_price
    FROM watch_query ORDER BY added_at DESC LIMIT 30`) as Row[];
  const waiting = (await sql`SELECT COUNT(*)::int AS n FROM pending`) as Row[];
  return {
    aisleAlerts: aisleAlerts.map(alertView),
    pendingCount: num(waiting[0]?.n) ?? 0,
    watch: [
      ...huntRows.map((row) => ({
        query: String(row.query),
        asin: String(row.cheapest_asin ?? ""),
        title: String(row.title || row.query),
        url: String(row.url || ""),
        image: row.image ? String(row.image) : null,
        price: (() => {
          const value = num(row.cheapest_price);
          if (value == null) return null;
          return value < huntFloor(String(row.query)) ? null : value;
        })(),
        basePrice: num(row.base_price),
        targetPrice: num(row.target_price),
      })),
      ...watchRows.map((row) => ({
        query: "",
        asin: String(row.asin),
        title: String(row.title ?? ""),
        url: String(row.url ?? ""),
        image: row.image ? String(row.image) : null,
        price: num(row.last_price),
        basePrice: num(row.base_price),
        targetPrice: num(row.target_price),
      })),
    ],
    ready: true,
    message: "",
    page: nowPage || (nowKind === "tur" || !nowKind ? state.page : 0),
    search,
    aisle: aisle.label,
    aislePage: cursors[aisle.label]?.page ?? state.aislePage,
    aisles: DEPO_AISLES.map((row) => ({
      label: row.label,
      page: cursors[row.label]?.page ?? 1,
      count: num(aisleCounts.find((count) => String(count.aisle) === row.label)?.n) ?? 0,
    })),
    aisleItems: aisleSeen.map((row) => {
      const price = num(row.last_price) ?? 0;
      const list = num(row.list_price) ?? num(row.highest_price);
      return {
        asin: String(row.asin),
        title: String(row.title ?? ""),
        url: String(row.url ?? ""),
        image: row.image ? String(row.image) : null,
        price,
        listPrice: num(row.list_price),
        aisle: String(row.aisle ?? ""),
        discount: list && list > price ? Math.round(((list - price) / list) * 100) : 0,
      };
    }),
    productCount: num(products[0]?.n) ?? 0,
    dealCount: num(deals[0]?.n) ?? 0,
    lastScanAt: state.lastScanAt,
    lastError: state.lastError,
    minDiscount: config.minDiscount,
    hasToken: Boolean(config.token),
    tokenHint: mask(config.token),
    chatId: config.chatId,
    notifySuspicious: config.notifySuspicious,
    urlTemplate: config.urlTemplate,
    alerts: alerts.map(alertView),
    recent: recent.map((row) => ({
      asin: String(row.asin),
      title: String(row.title ?? ""),
      url: String(row.url ?? ""),
      image: row.image ? String(row.image) : null,
      price: num(row.last_price) ?? 0,
      listPrice: num(row.list_price),
    })),
    logs: logs.map((row) => ({
      level: String(row.level ?? ""),
      message: String(row.message ?? ""),
      createdAt: iso(row.created_at),
    })),
  };
}
