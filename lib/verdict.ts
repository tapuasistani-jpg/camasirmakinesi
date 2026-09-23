export type Verdict = {
  verdict: "evet" | "hayir" | "kararsiz";
  discount: number;
  marketMedian: number | null;
  marketSamples: number;
  detail: string;
};

export function tl(value: number): string {
  return Math.round(value).toLocaleString("tr-TR");
}

export function dealThreshold(reference: number, siteMin: number): number {
  if (reference >= 10_000) return Math.min(20, siteMin);
  return siteMin;
}

export function percentOff(price: number | null, reference: number | null): number {
  if (!price || !reference || reference <= 0 || price >= reference) return 0;
  return ((reference - price) / reference) * 100;
}

function robustMedian(prices: number[]): { median: number | null; kept: number[] } {
  if (prices.length < 2) return { median: null, kept: [] };
  const ordered = [...prices].sort((a, b) => a - b);
  const mid = ordered.length % 2 ? ordered[(ordered.length - 1) / 2] : (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
  let kept = ordered.filter((price) => price >= mid * 0.25 && price <= mid * 4);
  if (kept.length < 2) kept = ordered;
  if (kept.length < 2) return { median: null, kept: [] };
  const median = kept.length % 2 ? kept[(kept.length - 1) / 2] : (kept[kept.length / 2 - 1] + kept[kept.length / 2]) / 2;
  return { median, kept };
}

export function withoutEcho(prices: number[], amazonPrice: number): number[] {
  if (!amazonPrice) return prices;
  return prices.filter((price) => Math.abs(price - amazonPrice) / amazonPrice > 0.03);
}

// "4'lü 1 L Pepsi" → 4. Tek şişe fiyatını paket fiyatına çevirmek için.
export function packCount(title: string): number {
  const text = title.replace(/\s+/g, " ");
  const match = text.match(/(\d+)\s*['’]?\s*(?:lü|li|lu|lı)\b/i)
    || text.match(/(\d+)\s*[x×]\s*\d/i)
    || text.match(/(\d+)\s*(?:adet|lı paket|li paket)\b/i);
  const n = match ? Number(match[1]) : 1;
  return Number.isFinite(n) && n >= 2 && n <= 24 ? n : 1;
}

export function alignMarketPrices(title: string, amazon: number, prices: number[]): number[] {
  if (!amazon) return prices.filter((price) => price > 0);
  const pack = packCount(title);
  const unitGuess = amazon / pack;
  const aligned: number[] = [];
  for (const raw of prices) {
    if (!Number.isFinite(raw) || raw <= 0) continue;
    let price = raw;
    // Migros 42 TL tek şişe → 4'lü paket 168 TL. 139 TL paket bunun yanında fırsat değil.
    if (pack >= 2 && raw >= unitGuess * 0.4 && raw <= Math.max(unitGuess * 1.5, 80)) price = raw * pack;
    if (price < amazon * 0.3 || price > amazon * 3) continue;
    aligned.push(price);
  }
  return aligned;
}

// 550 bir kez göründü, 139'a düştü. Tek başına duran yüksek fiyat gerçek satış değil.
export function realSaleHigh(prices: number[]): number | null {
  const clean = prices.filter((price) => Number.isFinite(price) && price > 0);
  if (clean.length < 2) return null;
  const max = Math.max(...clean);
  const rest = clean.filter((price) => price < max * 0.92);
  if (!rest.length) return max;
  const restHigh = Math.max(...rest);
  const peakCount = clean.filter((price) => price >= max * 0.92).length;
  if (max >= restHigh * 1.7 && peakCount <= 2) return restHigh;
  if (max >= restHigh * 1.25 && peakCount <= 1) return restHigh;
  return max;
}

// 6399 → 10500 → 6399. Eski fiyata dönüş indirim değil.
export function cameBackToOldPrice(prices: number[]): boolean {
  if (prices.length < 3) return false;
  const current = prices[prices.length - 1];
  if (!current) return false;
  let end = prices.length - 1;
  while (end > 0 && Math.abs(prices[end - 1] - current) / current <= 0.08) end -= 1;
  if (end < 2) return false;
  const earlier = prices.slice(0, end);
  const left = earlier.some((price) => Math.abs(price - current) / current > 0.08);
  const hadBefore = earlier.some((price) => Math.abs(price - current) / current <= 0.08);
  return left && hadBefore;
}

// Google'da dönen 550 TL, Amazon'un eski şişirme etiketi. Piyasa sayma.
export function withoutFakeAnchors(prices: number[], amazon: number, list: number | null, high: number | null): number[] {
  const anchors = [list, high].filter((value): value is number => value != null && value >= amazon * 1.7);
  return prices.filter((price) => !anchors.some((anchor) => Math.abs(price - anchor) / anchor < 0.12));
}

export function honestMarket(title: string, amazon: number, prices: number[], list: number | null, high: number | null): number[] {
  return withoutFakeAnchors(withoutEcho(alignMarketPrices(title, amazon, prices), amazon), amazon, list, high);
}

export function decide(input: {
  price: number;
  listPrice: number | null;
  highestPrice: number | null;
  samples: number;
  marketPrices: number[];
  threshold: number;
  title?: string;
  history?: number[];
}): Verdict | null {
  const listOff = percentOff(input.price, input.listPrice);
  const series = [
    ...(input.highestPrice != null ? [input.highestPrice] : []),
    ...(input.history ?? []),
    input.price,
  ];
  const timeline = input.history?.length ? [...input.history, input.price] : series;
  const trustedHigh = cameBackToOldPrice(timeline) ? null : realSaleHigh(series);
  const memoryOff = input.samples >= 2 ? percentOff(input.price, trustedHigh) : 0;
  const discount = Math.max(listOff, memoryOff);
  if (discount < input.threshold) return null;

  const aligned = honestMarket(input.title || "", input.price, input.marketPrices, input.listPrice, input.highestPrice);
  const cheapest = aligned.length ? Math.min(...aligned) : null;
  const { median, kept } = robustMedian(aligned);
  const marketOff = percentOff(input.price, median);
  // 4'lü 139 TL, tek şişe 42 TL × 4 = 168 TL. Yüzde 17 ucuzluk fırsat değil.
  if (cheapest != null && percentOff(input.price, cheapest) < input.threshold && (median == null || marketOff < input.threshold)) {
    return {
      verdict: "hayir",
      discount: Math.round(Math.max(percentOff(input.price, cheapest), marketOff) * 10) / 10,
      marketMedian: median ?? cheapest,
      marketSamples: Math.max(kept.length, aligned.length),
      detail: `Hayır. Amazon ${tl(input.price)} TL, piyasada paket karşılığı ${tl(cheapest)} TL. Fark fırsat değil.`,
    };
  }
  if (median && marketOff < input.threshold) {
    return {
      verdict: "hayir",
      discount: Math.round(discount * 10) / 10,
      marketMedian: median,
      marketSamples: kept.length,
      detail: `Hayır. Amazon ${tl(input.price)} TL, piyasa ${tl(median)} TL. Çizili etiket büyük görünür, gerçek fark %${Math.round(marketOff)}.`,
    };
  }
  if (median && marketOff >= input.threshold) {
    return {
      verdict: "evet",
      discount: Math.round(marketOff * 10) / 10,
      marketMedian: median,
      marketSamples: kept.length,
      detail: `Evet, piyasaya göre de düşük. Amazon ${tl(input.price)} TL, bulunan piyasa ortası ${tl(median)} TL. Yaklaşık %${Math.round(marketOff)} daha ucuz.`,
    };
  }
  if (median) {
    return {
      verdict: "hayir",
      discount: Math.round(discount * 10) / 10,
      marketMedian: median,
      marketSamples: kept.length,
      detail: `Hayır. Çizili fiyata göre %${Math.round(listOff)} indirim var ama piyasa ortası ${tl(median)} TL. Amazon fiyatı buna yakın, etiket şişirilmiş olabilir.`,
    };
  }
  if (memoryOff >= input.threshold && input.samples >= 2 && trustedHigh) {
    return {
      verdict: "evet",
      discount: Math.round(memoryOff * 10) / 10,
      marketMedian: null,
      marketSamples: 0,
      detail: `Evet. Bu ürünü ${tl(trustedHigh)} TL görmüştük, şimdi ${tl(input.price)} TL. Hafızadaki gerçek satıştan eşiğin üstünde düştü.`,
    };
  }
  return {
    verdict: "kararsiz",
    discount: Math.round(discount * 10) / 10,
    marketMedian: null,
    marketSamples: 0,
    detail: `Net değil. İndirim %${Math.round(discount)} görünüyor ama Google ve diğer sonuçlarda karşılaştırılacak kadar fiyat çıkmadı.`,
  };
}

export function assertVerdicts(): void {
  const yes = decide({ price: 1000, listPrice: 8000, highestPrice: 1000, samples: 1, marketPrices: [7000, 7200, 6800, 7100], threshold: 80 });
  const no = decide({ price: 7000, listPrice: 40000, highestPrice: 7000, samples: 1, marketPrices: [7100, 6900, 7200], threshold: 80 });
  const memory = decide({ price: 1000, listPrice: 1000, highestPrice: 9000, samples: 3, marketPrices: [], threshold: 80 });
  if (memory !== null) throw new Error("tek yüksek 9000 gerçek satış sandı");
  const selpak = decide({
    price: 47,
    listPrice: 47,
    highestPrice: 156,
    samples: 4,
    marketPrices: [],
    threshold: 50,
    history: [156, 156, 150, 47],
  });
  if (selpak?.verdict !== "evet") throw new Error("156'dan 47'ye düşen ürün bekledi");
  const fakeWas = decide({
    price: 139,
    listPrice: 550,
    highestPrice: 550,
    samples: 4,
    marketPrices: [42, 45, 168, 550, 520],
    threshold: 50,
    title: "4'lü 1 Litre Pepsi Kola",
    history: [550, 139],
  });
  if (fakeWas?.verdict !== "hayir") throw new Error("550 TL şişirme etiketini yüzde 75 sandı");
  if (realSaleHigh([550, 139]) !== 139) throw new Error("yalnız görülen 550 çapa kaldı");
  const overpriced = decide({ price: 168, listPrice: 600, highestPrice: 600, samples: 4, marketPrices: [139, 142, 135], threshold: 50, title: "Pepsi 4'lü 1 L" });
  if (overpriced?.verdict !== "hayir") throw new Error("piyasadan pahalı ürün fırsat sayıldı");
  const bottles = decide({ price: 139, listPrice: 400, highestPrice: 400, samples: 3, marketPrices: [42, 42, 40], threshold: 50, title: "4'lü 1 Litre Pepsi Kola" });
  if (bottles?.verdict !== "hayir") throw new Error("Migros 42 TL tek şişe paket fırsatı sandı");
  if (packCount("4'lü 1 Litre Pepsi") !== 4) throw new Error("paket sayısı okunamadı");
  const unknown = decide({ price: 1000, listPrice: 8000, highestPrice: 1000, samples: 1, marketPrices: [], threshold: 80 });
  const skip = decide({ price: 5000, listPrice: 6000, highestPrice: 5000, samples: 1, marketPrices: [9000, 9100], threshold: 80 });
  if (yes?.verdict !== "evet" || no?.verdict !== "hayir" || unknown?.verdict !== "kararsiz" || skip !== null) {
    throw new Error("karar motoru bozuldu");
  }
  const echoed = withoutEcho([1299, 1300, 7000, 7100], 1299);
  if (echoed.length !== 2 || echoed[0] !== 7000) throw new Error("piyasa filtresi bozuldu");
  const cheaper = decide({ price: 2000, listPrice: 9000, highestPrice: 2000, samples: 1, marketPrices: [4400, 4500, 4600], threshold: 50 });
  if (cheaper?.verdict !== "evet") throw new Error("piyasadan yarı yarıya ucuz ürün kaçtı");
  if (dealThreshold(180000, 50) !== 20) throw new Error("pahalı ürün eşiği 20 olmalı");
  if (dealThreshold(168, 50) !== 50) throw new Error("ucuz ürün eşiği bozuldu");
  const phone = decide({ price: 120000, listPrice: 180000, highestPrice: 180000, samples: 3, marketPrices: [], threshold: dealThreshold(180000, 50), history: [180000, 175000, 120000] });
  if (phone?.verdict !== "evet") throw new Error("iPhone yüzde 33 kaçtı");
  if (!cameBackToOldPrice([6399, 7875, 10500, 6399])) throw new Error("eski fiyata dönüş kaçtı");
  const hike = decide({
    price: 6399,
    listPrice: 10500,
    highestPrice: 10500,
    samples: 4,
    marketPrices: [],
    threshold: 20,
    history: [6399, 7875, 10500, 6399],
  });
  if (hike?.verdict === "evet") throw new Error("attırıp eski fiyata inen ayakkabı fırsat sayıldı");
}
