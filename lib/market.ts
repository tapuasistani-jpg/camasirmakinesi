import * as cheerio from "cheerio";

import { USER_AGENT, parsePrice } from "@/lib/amazon";
import { withoutEcho } from "@/lib/verdict";

const TOKEN_SOURCE =
  "(?:₺\\s*)?\\d{1,3}(?:\\.\\d{3})+(?:,\\d{2})?\\s*(?:TL|₺)|(?:₺\\s*)?\\d{2,6}(?:,\\d{2})?\\s*(?:TL|₺)|₺\\s*\\d{1,3}(?:\\.\\d{3})+(?:,\\d{2})?|₺\\s*\\d{2,6}(?:,\\d{2})?";

function pricesInText(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(new RegExp(TOKEN_SOURCE, "gi"))) {
    const value = parsePrice(match[0]);
    if (value != null && value >= 20 && value <= 2_000_000) found.push(value);
  }
  return found;
}

function queryFrom(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const short = words.slice(0, 12).join(" ") || title.slice(0, 80);
  return `${short} fiyat -site:amazon.com.tr`;
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

export async function searchPrices(title: string, amazonPrice: number): Promise<number[]> {
  const encoded = encodeURIComponent(queryFrom(title));
  const prices: number[] = [];
  const ddg = await fetchText(`https://html.duckduckgo.com/html/?q=${encoded}`);
  if (ddg) {
    const $ = cheerio.load(ddg);
    const results = $(".result, .web-result");
    if (results.length) {
      results.each((_, element) => {
        const result = $(element);
        const href = result.find("a").attr("href") || "";
        if (`${href} ${result.text()}`.includes("amazon.com")) return;
        prices.push(...pricesInText(result.text()));
      });
    } else {
      prices.push(...pricesInText(ddg));
    }
  }
  if (withoutEcho(prices, amazonPrice).length < 2) {
    const google = await fetchText(`https://www.google.com/search?hl=tr&gl=tr&num=10&q=${encoded}`);
    if (google && !google.slice(0, 1500).includes("consent.google")) {
      prices.push(...pricesInText(google));
    }
  }
  return withoutEcho(prices, amazonPrice);
}
