import * as cheerio from "cheerio";

import { USER_AGENT, parsePrice } from "@/lib/amazon";

export type Offer = {
  shop: string;
  title: string;
  url: string;
  price: number;
};

const SHOPS: Record<string, string> = {
  "amazon.com.tr": "Amazon",
  "trendyol.com": "Trendyol",
  "hepsiburada.com": "Hepsiburada",
  "n11.com": "n11",
  "cimri.com": "Cimri",
  "akakce.com": "Akakçe",
  "epey.com": "Epey",
  "mediamarkt.com.tr": "MediaMarkt",
  "vatanbilgisayar.com": "Vatan",
  "teknosa.com": "Teknosa",
  "pttavm.com": "PTT AVM",
  "idefix.com": "Idefix",
  "dr.com.tr": "D&R",
  "pazarama.com": "Pazarama",
  "gittigidiyor.com": "GittiGidiyor",
  "boyner.com.tr": "Boyner",
  "morhipo.com": "Morhipo",
  "lcwaikiki.com": "LC Waikiki",
};

const PRICE = /(?:₺\s*)?(?:\d{1,3}(?:\.\d{3})+|\d{2,6})(?:,\d{2})?\s*(?:TL|₺)/gi;

function shopOf(hostname: string): string | null {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  if (SHOPS[host]) return SHOPS[host];
  if (host.endsWith(".com.tr")) return host.replace(/\.com\.tr$/, "");
  return null;
}

function realUrl(href: string): string | null {
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const wrapped = url.searchParams.get("uddg");
    const target = new URL(wrapped || url.toString());
    if (!/^https?:$/.test(target.protocol)) return null;
    target.hash = "";
    return target.toString();
  } catch {
    return null;
  }
}

function priceIn(text: string): number | null {
  const clean = text.replace(/\u00a0/g, " ");
  if (/ayda|taksit|kargo/i.test(clean) && !/TL|₺/.test(clean.replace(/ayda[\s\S]{0,24}/gi, " "))) return null;
  const withoutInstallment = clean.replace(/ayda[\s\S]{0,24}/gi, " ");
  for (const match of withoutInstallment.matchAll(PRICE)) {
    const value = parsePrice(match[0]);
    if (value != null && value >= 20 && value <= 2_000_000) return value;
  }
  return null;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "tr-TR,tr;q=0.9",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(12000),
    redirect: "follow",
  });
  if (!response.ok) return "";
  return response.text();
}

function offersFrom(html: string): Offer[] {
  const $ = cheerio.load(html);
  const found: Offer[] = [];
  $(".result, .web-result").each((_, element) => {
    const node = $(element);
    const link = node.find("a.result__a, a").first();
    const href = realUrl(link.attr("href") || "");
    if (!href) return;
    let host = "";
    try {
      host = new URL(href).hostname;
    } catch {
      return;
    }
    const shop = shopOf(host);
    if (!shop) return;
    const title = link.text().replace(/\s+/g, " ").trim().slice(0, 180);
    const snippet = node.find(".result__snippet, .result__body").text() || node.text();
    const price = priceIn(`${title} ${snippet}`);
    if (!title || price == null) return;
    found.push({ shop, title, url: href, price });
  });
  return found;
}

function cheapestPerShop(offers: Offer[]): Offer[] {
  const best = new Map<string, Offer>();
  for (const offer of offers) {
    const key = offer.shop.toLowerCase();
    const current = best.get(key);
    if (!current || offer.price < current.price) best.set(key, offer);
  }
  return [...best.values()].sort((a, b) => a.price - b.price);
}

export async function comparePrices(rawName: string): Promise<{ query: string; cheapest: Offer | null; offers: Offer[] }> {
  const query = rawName.replace(/\s+/g, " ").trim().slice(0, 120);
  if (query.length < 2) return { query, cheapest: null, offers: [] };
  const encoded = encodeURIComponent(`${query} fiyat TL`);
  const compared = encodeURIComponent(`${query} en ucuz site:akakce.com OR site:cimri.com OR site:epey.com`);
  const [open, shops] = await Promise.all([
    fetchText(`https://html.duckduckgo.com/html/?q=${encoded}`),
    fetchText(`https://html.duckduckgo.com/html/?q=${compared}`),
  ]);
  let offers = cheapestPerShop([...offersFrom(open), ...offersFrom(shops)]);
  if (offers.length < 2) {
    const google = await fetchText(`https://www.google.com/search?hl=tr&gl=tr&num=10&q=${encoded}`);
    if (google && !google.slice(0, 1500).includes("consent.google")) {
      offers = cheapestPerShop([...offers, ...offersFrom(google)]);
    }
  }
  return { query, cheapest: offers[0] ?? null, offers: offers.slice(0, 12) };
}
