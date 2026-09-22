import * as cheerio from "cheerio";

export const SEARCH_URL = "https://www.amazon.com.tr/s?k=&i=warehouse-deals&url=search-alias%3Dwarehouse-deals&page={page}";

// Üstteki arama kutusunda "Amazon Depo" seçiliyken yazılan aramalar.
// Boş arama listenin kendisi. Diğerleri aynı kutudan kategori araması.
export const DEPO_QUERIES = [
  "Bahçe",
  "Bebek",
  "Bebek Bakım",
  "Bilgisayar",
  "Elektronik",
  "Ev ve Yaşam",
  "Evcil Hayvan Ürünleri",
  "Kitap",
  "Kişisel Bakım ve Kozmetik",
  "Moda",
  "Mutfak",
  "Müzik Enstrümanları ve DJ",
  "Ofis ve Kırtasiye",
  "Otomotiv",
  "Oyuncak",
  "Sağlık ve Kişisel Bakım",
  "Spor ve Outdoor",
  "Video Oyunu ve Konsol",
  "Yapı Market",
];

export function depoSearchUrl(query: string, page: number): string {
  const params = new URLSearchParams({
    k: query,
    i: "warehouse-deals",
    url: "search-alias=warehouse-deals",
    page: String(page),
  });
  return `https://www.amazon.com.tr/s?${params.toString()}`;
}

export const DEPO_HOME = "https://www.amazon.com.tr/b?node=44219324031";

export const DEPO_AISLES = [
  { label: "Yeni Gelenler", match: /yeni gelenler/i },
  { label: "Günün Fırsatları", match: /günün fırsat/i },
  { label: "Çok Al Az Öde", match: /çok al.{0,12}az öde/i },
  { label: "Outlet", match: /outlet reyonu|\boutlet\b/i },
];

const AISLE_START: Record<string, string> = {
  "Yeni Gelenler": "https://www.amazon.com.tr/s?i=warehouse-deals&url=search-alias%3Dwarehouse-deals&s=date-desc-rank&page=1",
  "Günün Fırsatları": "https://www.amazon.com.tr/s?i=specialty-aps&rh=p_n_deal_type%3A26902947031&page=1",
  "Çok Al Az Öde": "https://www.amazon.com.tr/s?node=26248552031&page=1",
  Outlet: "https://www.amazon.com.tr/s?node=21034466031&page=1",
};

export function aisleStartUrl(label: string): string {
  return AISLE_START[label] || AISLE_START["Yeni Gelenler"];
}

// Reyonların eski adresleri hafızada kalmasın.
export function keywordAisleUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const params = new URL(url).searchParams;
    const k = (params.get("k") || "").trim();
    if (/^(günün fırsatları|çok al az öde|outlet)$/i.test(k)) return true;
    return params.get("i") === "warehouse-deals" && (params.get("rh") || "").includes("p_n_deal_type");
  } catch {
    return false;
  }
}

export function storePageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const node = parsed.searchParams.get("node");
  if (!node || !/^\d+$/.test(node)) return null;
  return `https://www.amazon.com.tr/s?node=${node}&page=1`;
}

// Ürün listesi veren adresler. /deals ve goldbox sayfası ham halde boş gelir.
function listingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (/^\/(deals|events)\//.test(`${parsed.pathname}/`) || parsed.pathname.startsWith("/gp/goldbox")) return false;
    if (!parsed.pathname.startsWith("/s") && !parsed.pathname.startsWith("/b")) return false;
    return Boolean(parsed.searchParams.get("node") || parsed.searchParams.get("k") || parsed.searchParams.get("rh") || parsed.searchParams.get("i"));
  } catch {
    return false;
  }
}

export function aisleEntryUrl(html: string, match: RegExp): string | null {
  const $ = cheerio.load(html);
  let found: string | null = null;
  $("a[href]").each((_, element) => {
    if (found) return;
    const node = $(element);
    const text = `${node.attr("aria-label") || ""} ${node.text()}`.replace(/\s+/g, " ").trim();
    if (!text || text.length > 80 || !match.test(text)) return;
    const url = amazonUrl(node.attr("href") || "");
    if (!url || !listingUrl(url)) return;
    found = storePageUrl(url) || url;
  });
  return found;
}

const ELEKTRONIK_NODE = "12466496031";

export function pageTurnUrl(query: string, page: number): string {
  const url = new URL(depoSearchUrl(query, page));
  if (page > 1) {
    url.searchParams.set("pg", String(page));
    url.searchParams.set("ref", `sr_pg_${page}`);
  }
  return url.toString();
}

export function elektronikPageUrl(page: number): string {
  const params = new URLSearchParams({
    i: "warehouse-deals",
    rh: `n:${ELEKTRONIK_NODE}`,
    fs: "true",
    page: String(page),
    pg: String(page),
    ref: `sr_pg_${page}`,
  });
  return `https://www.amazon.com.tr/s?${params.toString()}`;
}

export function pageFlipUrl(html: string, currentUrl: string): string | null {
  return explicitNext(html, currentUrl);
}

export function depoQueryLabel(query: string): string {
  return query ? query : "boş arama";
}

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type ProductCard = {
  asin: string;
  title: string;
  price: number;
  listPrice: number | null;
  image: string | null;
  condition: string;
  url: string;
};

const PRICE = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/;

export function parsePrice(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/\u00a0/g, " ").replace(/TL/gi, " ").replace(/₺/g, " ");
  const match = cleaned.match(PRICE);
  if (!match) return null;
  const whole = match[1].replace(/\./g, "");
  const frac = match[2] || "0";
  const value = Number(`${whole}.${frac}`);
  if (!Number.isFinite(value) || value <= 0 || value > 5_000_000) return null;
  return value;
}

export function isBlocked(html: string): boolean {
  if (!html || html.length < 500) return true;
  const lowered = html.toLowerCase();
  return [
    "validatecaptcha",
    "robot check",
    "type the characters you see",
    "/errors/validatecaptcha",
    "api-services-support@amazon.com",
    "captchacharacters",
    "opfcaptcha",
  ].some((needle) => lowered.includes(needle));
}

export function pageSummary(html: string): string {
  const title = (html.match(/<title>([^<]{0,80})/i)?.[1] || "başlıksız").replace(/\s+/g, " ").trim();
  const cards = html.match(/data-asin="[A-Z0-9]{10}"/gi)?.length ?? 0;
  return `${title} · ${cards} kart · ${html.length} bayt`;
}

export function continueTarget(html: string): { url: string | null; captcha: boolean } {
  if (!/captchacharacters|validateCaptcha|opfcaptcha/i.test(html)) return { url: null, captcha: false };
  const $ = cheerio.load(html);
  const href = $("a[href*='cs_503'], a[href*='validateCaptcha']").attr("href") || "";
  if (!href) return { url: null, captcha: true };
  const url = href.startsWith("http") ? href : `https://www.amazon.com.tr${href.startsWith("/") ? href : `/${href}`}`;
  if (!url.startsWith("https://www.amazon.com.tr/")) return { url: null, captcha: true };
  return { url, captcha: false };
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const UNIT_PRICE = /\/\s*\d*\s*(mm|cm|ml|cl|lt|kg|g|gr|adet|metre|meter|m)\b|\/\s*l\b|100\s*ml|birim fiyat|başına/i;

function isUnitPrice(text: string): boolean {
  return UNIT_PRICE.test(text.replace(/\s+/g, " "));
}

function perUnitMultiple(price: number, listPrice: number): boolean {
  const ratio = listPrice / price;
  return Math.abs(ratio - 100) / 100 < 0.03 || Math.abs(ratio - 1000) / 1000 < 0.03;
}

export function fakeListPrice(title: string, price: number, listPrice: number | null): boolean {
  if (listPrice == null || !(listPrice > price) || price <= 0) return false;
  if (perUnitMultiple(price, listPrice)) return true;
  const match = title.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|metre|meter|ml|cl|lt|kg|g|gr|m|l)\b/i);
  if (!match) return false;
  const qty = Number(match[1].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(qty) || qty <= 0) return false;
  const unit = match[2].toLowerCase();
  const factors = unit === "mm"
    ? [10 / qty, 1000 / qty]
    : unit === "cm"
      ? [100 / qty]
      : unit === "ml" || unit === "g" || unit === "gr"
        ? [100 / qty, 1000 / qty]
        : unit === "cl"
          ? [10 / qty, 100 / qty]
          : [1 / qty, 100 / qty];
  return factors.some((factor) => factor > 1.5 && Math.abs(price * factor - listPrice) / listPrice < 0.04);
}

function priceFromCard(card: { find(selector: string): { first(): { text(): string } } }, strike: boolean): number | null {
  const selector = strike
    ? "span.a-price.a-text-price span.a-offscreen"
    : "span.a-price:not(.a-text-price) span.a-offscreen";
  const direct = parsePrice(card.find(selector).first().text());
  if (direct || strike) return direct;
  const whole = card.find("span.a-price:not(.a-text-price) span.a-price-whole").first().text();
  const frac = card.find("span.a-price:not(.a-text-price) span.a-price-fraction").first().text();
  const digits = whole.replace(/[^\d]/g, "");
  if (!digits) return null;
  const cents = frac.replace(/[^\d]/g, "") || "0";
  const value = Number(`${digits}.${cents}`);
  return Number.isFinite(value) ? value : null;
}

function amazonUrl(href: string): string | null {
  const raw = href.replace(/&amp;/g, "&").trim();
  if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return null;
  const absolute = raw.startsWith("//")
    ? `https:${raw}`
    : raw.startsWith("http")
      ? raw
      : `https://www.amazon.com.tr${raw.startsWith("/") ? raw : `/${raw}`}`;
  if (!absolute.startsWith("https://www.amazon.com.tr/")) return null;
  return absolute.split("#")[0];
}

export function nextSearchPage(currentUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith("amazon.com.tr") || !url.pathname.startsWith("/s")) return null;
  const current = Number(url.searchParams.get("page") || "1");
  if (!Number.isFinite(current) || current < 1 || current >= 200) return null;
  url.searchParams.set("page", String(current + 1));
  url.searchParams.set("ref", `sr_pg_${current + 1}`);
  const next = url.toString();
  return next === currentUrl ? null : next;
}

function looseTl(card: { clone(): { find(selector: string): { remove(): void }; text(): string } }): number | null {
  const copy = card.clone();
  copy.find(".a-text-price").remove();
  const match = copy.text().replace(/\u00a0/g, " ").match(/(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\s*TL/i);
  if (!match) return null;
  return parsePrice(`${match[1]},${match[2]} TL`);
}

const SEE_ALL = /tüm sonuçları gör|tümünü gör|sonuçların tümünü|see all results/i;

export function seeAllResultsUrl(html: string): string | null {
  const $ = cheerio.load(html);
  let found: string | null = null;
  $("a[href], span, button").each((_, element) => {
    if (found) return;
    const node = $(element);
    const text = node.text().replace(/\s+/g, " ").trim();
    if (!text || text.length > 60 || !SEE_ALL.test(text)) return;
    const link = node.is("a[href]") ? node : node.closest("a[href]");
    const href = link.attr("href") || node.closest("form[action]").attr("action") || "";
    found = amazonUrl(href);
  });
  if (found) return found;
  const raw = html.match(/href="([^"]+)"[^>]*>\s*(?:<[^>]+>\s*){0,4}Tüm sonuçları gör/i);
  return raw ? amazonUrl(raw[1].replace(/&amp;/g, "&")) : null;
}

function explicitNext(html: string, currentUrl: string): string | null {
  const $ = cheerio.load(html);
  let found: string | null = null;
  const take = (href: string | undefined) => {
    if (found) return;
    const url = amazonUrl(href || "");
    if (url && url !== currentUrl) found = url;
  };
  $("link[rel='next']").each((_, element) => take($(element).attr("href")));
  $("a[href]").each((_, element) => {
    const node = $(element);
    if (node.hasClass("s-pagination-disabled") || node.attr("aria-disabled") === "true") return;
    const label = `${node.attr("aria-label") || ""} ${node.text()}`.replace(/\s+/g, " ").trim();
    const href = node.attr("href") || "";
    const pager = node.hasClass("s-pagination-next") || /pagination/i.test(node.attr("class") || "") || /(?:page|pg)=\d|sr_pg_\d/.test(href);
    if (pager && (node.hasClass("s-pagination-next") || /sonraki|next page|daha fazla sonuç/i.test(label))) {
      take(href);
    }
  });
  if (found) return found;
  let current = 1;
  try {
    current = Number(new URL(currentUrl).searchParams.get("page") || "1");
  } catch {
    current = 1;
  }
  const best = { n: Number.POSITIVE_INFINITY, url: "" };
  $("a[href]").each((_, element) => {
    const label = `${$(element).attr("aria-label") || ""} ${$(element).text()}`.replace(/\s+/g, " ");
    const match = label.match(/(\d+)\s*\.?\s*sayfa/i);
    const n = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(n) || n <= current) return;
    const url = amazonUrl($(element).attr("href") || "");
    if (!url || n >= best.n) return;
    best.n = n;
    best.url = url;
  });
  if (best.url) return best.url;
  $("a.s-pagination-item[href], .s-pagination-strip a[href], .s-pagination-container a[href]").each((_, element) => {
    const text = $(element).text().replace(/\s+/g, "").trim();
    if (!/^\d+$/.test(text)) return;
    const n = Number(text);
    if (!Number.isFinite(n) || n <= current || n >= best.n) return;
    const url = amazonUrl($(element).attr("href") || "");
    if (!url) return;
    best.n = n;
    best.url = url;
  });
  if (best.url) return best.url;
  const rawPg = html.match(new RegExp(`href="([^"]*(?:[?&](?:page|pg)=${current + 1}|sr_pg_${current + 1})[^"]*)"`, "i"));
  const fromPg = rawPg ? amazonUrl(rawPg[1].replace(/&amp;/g, "&")) : null;
  if (fromPg && fromPg !== currentUrl) return fromPg;
  const raw = html.match(/href="([^"]+)"[^>]*(?:s-pagination-next|rel="next")|s-pagination-next[^>]*href="([^"]+)"|rel="next"[^>]*href="([^"]+)"/i);
  const rawHref = raw?.[1] || raw?.[2] || raw?.[3] || "";
  const fromRaw = amazonUrl(rawHref);
  return fromRaw && fromRaw !== currentUrl ? fromRaw : null;
}

const MORE_SCROLL = /daha fazla göster|daha fazla gör|daha fazla sonuç|show more|load more/i;

export function scrollMoreUrl(html: string, currentUrl: string): string | null {
  const listed = continueResultsUrl(html, currentUrl);
  if (listed) return listed;
  const $ = cheerio.load(html);
  let found: string | null = null;
  $("a[href], button, span").each((_, element) => {
    if (found) return;
    const node = $(element);
    const text = node.text().replace(/\s+/g, " ").trim();
    if (!text || text.length > 60 || !MORE_SCROLL.test(text)) return;
    const link = node.is("a[href]") ? node : node.closest("a[href]");
    const href = link.attr("href") || node.attr("data-url") || node.closest("[data-url]").attr("data-url") || "";
    const url = amazonUrl(href);
    if (url && url !== currentUrl) found = url;
  });
  return found;
}

export function continueResultsUrl(html: string, currentUrl: string): string | null {
  const next = explicitNext(html, currentUrl);
  if (next) return next;
  const seeAll = seeAllResultsUrl(html);
  if (seeAll && seeAll !== currentUrl) return seeAll;
  return null;
}

export function hasNextPage(html: string): boolean {
  const $ = cheerio.load(html);
  const next = $(".s-pagination-next, a[aria-label*='Sonraki'], a[aria-label*='Next']");
  const enabled = next.toArray().some((element) => {
    const node = $(element);
    return !node.hasClass("s-pagination-disabled") && node.attr("aria-disabled") !== "true" && Boolean(node.attr("href") || node.text());
  });
  if (enabled) return true;
  return /daha fazla sonuç/i.test($.text());
}

export function parseSearchPage(html: string): ProductCard[] {
  const $ = cheerio.load(html);
  const found: ProductCard[] = [];
  const seen = new Set<string>();
  $("[data-asin]").each((_, element) => {
    const card = $(element);
    const asin = (card.attr("data-asin") || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) return;
    const title = clean(
      card.find("h2 span").first().text()
      || card.find("h2").first().text()
      || card.find("a.a-link-normal span").first().text()
      || card.find("img").first().attr("alt")
      || "",
    );
    if (title.length < 3) return;
    const price = priceFromCard(card, false) ?? looseTl(card);
    if (price == null) return;
    const cardText = clean(card.text());
    let listPrice: number | null = null;
    card.find("span.a-price.a-text-price").each((__, priceNode) => {
      if (listPrice != null) return;
      const node = $(priceNode);
      const around = clean(`${node.text()} ${node.next().text()} ${node.parent().text().slice(0, 220)}`);
      const value = parsePrice(node.find("span.a-offscreen").first().text());
      if (value == null || value <= price) return;
      if (isUnitPrice(around) || fakeListPrice(title, price, value)) return;
      if (isUnitPrice(cardText) && perUnitMultiple(price, value)) return;
      listPrice = value;
    });
    const image = card.find("img.s-image").attr("src") || null;
    let condition = "";
    card.find("span").each((__, span) => {
      const text = clean($(span).text());
      if (!condition && (text.startsWith("İkinci El") || text.startsWith("Kullanılmış"))) {
        condition = text.slice(0, 80);
      }
    });
    seen.add(asin);
    found.push({
      asin,
      title: title.slice(0, 300),
      price,
      listPrice,
      image: image?.startsWith("https://") ? image : null,
      condition,
      url: `https://www.amazon.com.tr/dp/${asin}`,
    });
  });
  return found;
}

export function assertAmazonParser(): void {
  const html = `
    <div data-component-type="s-search-result" data-asin="B0TEST1234">
      <h2><a href="/dp/B0TEST1234"><span>Örnek Kulaklık</span></a></h2>
      <span class="a-price"><span class="a-offscreen">1.299,00 TL</span></span>
      <span class="a-price a-text-price"><span class="a-offscreen">7.999,00 TL</span></span>
      <span>İkinci El - Yeni Gibi</span>
    </div>
  `;
  const items = parseSearchPage(html);
  if (items.length !== 1 || items[0].price !== 1299 || items[0].listPrice !== 7999) {
    throw new Error("Amazon ayrıştırıcı bozuldu");
  }
  if (parsePrice("299,90 TL") !== 299.9 || parsePrice("₺89,90") !== 89.9) {
    throw new Error("fiyat ayrıştırıcı bozuldu");
  }
  if (!isBlocked("<html>validateCaptcha</html>")) throw new Error("engel ayrıştırıcı bozuldu");
  const loose = `
    <div data-asin="B0TEST5678" data-component-type="s-search-result">
      <a class="a-link-normal"><span>Başka Ürün</span></a>
      <span class="a-price"><span class="a-offscreen">499,90 TL</span></span>
    </div>
  `;
  const looseItems = parseSearchPage(loose);
  if (looseItems.length !== 1 || looseItems[0].price !== 499.9) throw new Error("başlıksız kart okunamadı");
  const normal = `<html><title>Amazon Depo</title>${"x".repeat(600)}<div data-asin="B0TEST1234" data-component-type="s-search-result"></div></html>`;
  if (isBlocked(normal)) throw new Error("normal sayfa engel sayıldı");
  const splash = `<html><title>Amazon.com.tr: Amazon Depo</title>${"x".repeat(2000)}<p>Alışverişe devam</p></html>`;
  if (isBlocked(splash)) throw new Error("kapak sayfası robot sayıldı");
  const seeAll = seeAllResultsUrl(`<a href="/s?k=Kitap&i=warehouse-deals"><span>Tüm sonuçları gör</span></a>`);
  if (seeAll !== "https://www.amazon.com.tr/s?k=Kitap&i=warehouse-deals") throw new Error("tüm sonuçları gör kaçtı");
  const next = continueResultsUrl(
    `<a class="s-pagination-next" href="/s?k=Bebek&page=2">Sonraki</a>`,
    "https://www.amazon.com.tr/s?k=Bebek&page=1",
  );
  if (next !== "https://www.amazon.com.tr/s?k=Bebek&page=2") throw new Error("sonraki sayfa linki kaçtı");
  const numbered = continueResultsUrl(
    `<a aria-label="2. sayfaya git" href="/s?k=Elektronik&amp;i=warehouse-deals&amp;page=2">2</a>`,
    "https://www.amazon.com.tr/s?k=Elektronik&i=warehouse-deals&page=1",
  );
  if (!numbered?.includes("page=2")) throw new Error("sayfa numarası kaçtı");
  const crowded = `${"<div data-asin=\"B0ELEC0001\"></div>".repeat(14)}<a href="/s?k=Elektronik&page=2"><span>Tüm sonuçları gör</span></a>`;
  const crowdedNext = continueResultsUrl(crowded, "https://www.amazon.com.tr/s?k=Elektronik&page=1");
  if (!crowdedNext?.includes("page=2")) throw new Error("14 ürünlü sayfada tüm sonuçları gör atlandı");
  const flip = pageFlipUrl(
    `<a href="/s?k=Elektronik">Tüm sonuçları gör</a><a aria-label="2. sayfaya git" href="/s?k=Elektronik&page=2&ref=sr_pg_2">2</a>`,
    "https://www.amazon.com.tr/s?k=Elektronik&page=1",
  );
  if (!flip?.includes("sr_pg_2")) throw new Error("elektronik sayfa çevirme kaçtı");
  const numberedOnly = pageFlipUrl(
    `<a class="s-pagination-item" href="/s?i=warehouse-deals&amp;page=2&amp;pg=2">2</a>`,
    "https://www.amazon.com.tr/s?i=warehouse-deals&page=1",
  );
  if (!numberedOnly?.includes("pg=2")) throw new Error("sayfa numarası 2 okunamadı");
  const nodeUrl = elektronikPageUrl(2);
  if (!nodeUrl.includes("12466496031") || !nodeUrl.includes("page=2") || !nodeUrl.includes("i=warehouse-deals")) {
    throw new Error("elektronik kategori adresi bozuk");
  }
  const bumped = nextSearchPage("https://www.amazon.com.tr/s?k=Elektronik&i=warehouse-deals&page=1");
  if (!bumped?.includes("page=2")) throw new Error("sayfa artırılamadı");
  const plain = `
    <div data-asin="B0TEST9012"><img alt="Bebek Bezi"><span>249,90 TL</span></div>
  `;
  const plainItems = parseSearchPage(plain);
  if (plainItems.length !== 1 || plainItems[0].price !== 249.9) throw new Error("düz fiyat okunamadı");
  const unit = `
    <div data-asin="B0UNITPRICE">
      <h2><span>Urban Care Duş Jeli 500 ml</span></h2>
      <span class="a-price"><span class="a-offscreen">145,45 TL</span></span>
      <span class="a-price a-text-price"><span class="a-offscreen">14.543,00 TL</span></span>
      <span> / 100 ml</span>
    </div>
  `;
  const unitItems = parseSearchPage(unit);
  if (unitItems.length !== 1 || unitItems[0].price !== 145.45 || unitItems[0].listPrice !== null) {
    throw new Error("litre fiyatı indirim sanıldı");
  }
  const realSale = `
    <div data-asin="B0REALSALE1">
      <h2><span>Kulaklık</span></h2>
      <span class="a-price"><span class="a-offscreen">200,00 TL</span></span>
      <span class="a-price a-text-price"><span class="a-offscreen">1.000,00 TL</span></span>
    </div>
  `;
  const realItems = parseSearchPage(realSale);
  if (realItems.length !== 1 || realItems[0].listPrice !== 1000) throw new Error("gerçek indirim silindi");
  const nail = `
    <div data-asin="B0NAILPOL15">
      <h2><span>Mara Kozmetik Oje 15ml</span></h2>
      <span class="a-price"><span class="a-offscreen">200,00 TL</span></span>
      <span class="a-price a-text-price"><span class="a-offscreen">1.333,00 TL</span></span>
    </div>
  `;
  const nailItems = parseSearchPage(nail);
  if (nailItems.length !== 1 || nailItems[0].listPrice !== null) throw new Error("15 ml birim fiyatı indirim sanıldı");
  const cable = `
    <div data-asin="B0CABLE020C">
      <h2><span>S-link Şarj Kablosu 20cm</span></h2>
      <span class="a-price"><span class="a-offscreen">300,00 TL</span></span>
      <span class="a-price a-text-price"><span class="a-offscreen">1.500,00 TL</span></span>
      <span> / metre</span>
    </div>
  `;
  const cableItems = parseSearchPage(cable);
  if (cableItems.length !== 1 || cableItems[0].listPrice !== null) throw new Error("metre fiyatı indirim sanıldı");
  if (!fakeListPrice("S-link Şarj Kablosu 20cm", 300, 1500)) throw new Error("20 cm metre hesabı kaçtı");
  if (!fakeListPrice("Bosch Disk 350 Mm", 3669, 366900)) throw new Error("100 kat fiyat kaçtı");
  const aisleHtml = `
    <a href="/gp/goldbox">Günün Fırsatları</a>
    <a href="/b/?ie=UTF8&node=21034466031&ref_=sv_gb_3">Outlet</a>
    <a href="/deals">Çok Al Az Öde</a>
  `;
  if (aisleEntryUrl(aisleHtml, /günün fırsat/i) !== null) throw new Error("boş fırsat sayfası reyon sandı");
  if (aisleEntryUrl(aisleHtml, /çok al.{0,12}az öde/i) !== null) throw new Error("boş kampanya sayfası reyon sandı");
  if (aisleEntryUrl(aisleHtml, /outlet/i) !== "https://www.amazon.com.tr/s?node=21034466031&page=1") {
    throw new Error("mağaza sayfası listeye çevrilmedi");
  }
  if (storePageUrl("https://www.amazon.com.tr/b/?ie=UTF8&node=26248552031&ref_=sv_gb_1") !== "https://www.amazon.com.tr/s?node=26248552031&page=1") {
    throw new Error("node adresi okunamadı");
  }
  if (!keywordAisleUrl("https://www.amazon.com.tr/s?k=Outlet&i=warehouse-deals&page=1")) throw new Error("eski reyon araması duruyor");
  if (keywordAisleUrl("https://www.amazon.com.tr/s?node=21034466031&page=1")) throw new Error("yeni reyon adresi silindi");
  if (!aisleStartUrl("Outlet").includes("node=21034466031")) throw new Error("outlet adresi bozuk");
  if (!aisleStartUrl("Çok Al Az Öde").includes("node=26248552031")) throw new Error("çok al az öde adresi bozuk");
  if (!aisleStartUrl("Günün Fırsatları").includes("p_n_deal_type")) throw new Error("fırsat filtresi kaçtı");
  if (!aisleStartUrl("Yeni Gelenler").includes("s=date-desc-rank")) throw new Error("yeni gelenler sıralaması kaçtı");
  if (seeAllResultsUrl(`<a href="/gp/help">Yardım</a>`) !== null) throw new Error("başka link sonuç sandı");
  if (!hasNextPage(`<a class="s-pagination-next" href="/s?page=2">Daha fazla sonuç</a>`)) throw new Error("sonraki sayfa kaçtı");
  if (hasNextPage(`<span class="s-pagination-next s-pagination-disabled">Sonraki</span>`)) throw new Error("bitmiş sayfa devam sandı");
}
