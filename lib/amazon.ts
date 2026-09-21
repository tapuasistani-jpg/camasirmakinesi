import * as cheerio from "cheerio";

export const SEARCH_URL = "https://www.amazon.com.tr/s?k=&i=warehouse-deals&url=search-alias%3Dwarehouse-deals&page={page}";

// Üstteki arama kutusunda "Amazon Depo" seçiliyken yazılan aramalar.
// Boş arama listenin kendisi. Diğerleri aynı kutudan kategori araması.
export const DEPO_QUERIES = [
  "",
  "Bahçe",
  "Bebek",
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
  const needles = [
    "validatecaptcha",
    "robot check",
    "type the characters you see",
    "/errors/validatecaptcha",
    "api-services-support@amazon.com",
    "captchacharacters",
    "opfcaptcha",
    "automated access",
    "otomatik erişim",
    "sorry! something went wrong",
    "üzgünüz",
    "dogs of amazon",
    "continue shopping",
    "alışverişe devam",
  ];
  if (needles.some((needle) => lowered.includes(needle))) return true;
  const cards = html.match(/data-asin="[A-Z0-9]{10}"/gi)?.length ?? 0;
  const looksLikeResults = /s-search-result|s-result-item|data-component-type="s-search-result"/i.test(html);
  return cards === 0 && !looksLikeResults;
}

export function pageSummary(html: string): string {
  const title = (html.match(/<title>([^<]{0,80})/i)?.[1] || "başlıksız").replace(/\s+/g, " ").trim();
  const cards = html.match(/data-asin="[A-Z0-9]{10}"/gi)?.length ?? 0;
  return `${title} · ${cards} kart · ${html.length} bayt`;
}

export function continueTarget(html: string): { url: string | null; captcha: boolean } {
  if (/captchacharacters|validateCaptcha|opfcaptcha/i.test(html)) return { url: null, captcha: true };
  const $ = cheerio.load(html);
  const link = $("a")
    .toArray()
    .map((element) => $(element).attr("href") || "")
    .find((href) => /cs_503|continue|alisveris/i.test(href));
  const form = $("form[action]").first();
  const action = form.attr("action") || "";
  const raw = link || action;
  if (!raw) return { url: null, captcha: false };
  if (form.find("img[src*='captcha'], input[name='field-keywords']").length) return { url: null, captcha: true };
  const base = raw.startsWith("http") ? raw : `https://www.amazon.com.tr${raw.startsWith("/") ? raw : `/${raw}`}`;
  if (!base.startsWith("https://www.amazon.com.tr/")) return { url: null, captcha: false };
  if (!form.length || link) return { url: base, captcha: false };
  const params = new URLSearchParams();
  form.find("input[name]").each((_, element) => {
    const name = $(element).attr("name");
    if (!name) return;
    params.set(name, $(element).attr("value") || "");
  });
  const joiner = base.includes("?") ? "&" : "?";
  return { url: params.size ? `${base}${joiner}${params.toString()}` : base, captcha: false };
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
    const price = priceFromCard(card, false);
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
  if (!isBlocked(`<html>${"x".repeat(800)}<p>Üzgünüz</p></html>`)) throw new Error("robot sayfası kaçtı");
  if (!hasNextPage(`<a class="s-pagination-next" href="/s?page=2">Daha fazla sonuç</a>`)) throw new Error("sonraki sayfa kaçtı");
  if (hasNextPage(`<span class="s-pagination-next s-pagination-disabled">Sonraki</span>`)) throw new Error("bitmiş sayfa devam sandı");
}
