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
  if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return null;
  const url = href.startsWith("http") ? href : `https://www.amazon.com.tr${href.startsWith("/") ? href : `/${href}`}`;
  if (!url.startsWith("https://www.amazon.com.tr/")) return null;
  return url.split("#")[0];
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

export function continueResultsUrl(html: string, currentUrl: string): string | null {
  const seeAll = seeAllResultsUrl(html);
  if (seeAll && seeAll !== currentUrl) return seeAll;
  const $ = cheerio.load(html);
  const href = $(
    "a.s-pagination-next[href], a[aria-label*='Sonraki'][href], a[aria-label*='Next'][href]",
  ).filter((_, element) => {
    const node = $(element);
    return !node.hasClass("s-pagination-disabled") && node.attr("aria-disabled") !== "true";
  }).first().attr("href") || "";
  const next = amazonUrl(href);
  if (next && next !== currentUrl) return next;
  let word = "";
  $("a[href]").each((_, element) => {
    if (word) return;
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (/^(sonraki|next|daha fazla sonuç)$/i.test(text)) word = $(element).attr("href") || "";
  });
  const byWord = amazonUrl(word);
  if (byWord && byWord !== currentUrl) return byWord;
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
    let listPrice = priceFromCard(card, true);
    if (listPrice != null && listPrice <= price) listPrice = null;
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
  const plain = `
    <div data-asin="B0TEST9012"><img alt="Bebek Bezi"><span>249,90 TL</span></div>
  `;
  const plainItems = parseSearchPage(plain);
  if (plainItems.length !== 1 || plainItems[0].price !== 249.9) throw new Error("düz fiyat okunamadı");
  if (seeAllResultsUrl(`<a href="/gp/help">Yardım</a>`) !== null) throw new Error("başka link sonuç sandı");
  if (!hasNextPage(`<a class="s-pagination-next" href="/s?page=2">Daha fazla sonuç</a>`)) throw new Error("sonraki sayfa kaçtı");
  if (hasNextPage(`<span class="s-pagination-next s-pagination-disabled">Sonraki</span>`)) throw new Error("bitmiş sayfa devam sandı");
}
