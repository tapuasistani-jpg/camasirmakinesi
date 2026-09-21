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
  const others = prices.filter((price) => Math.abs(price - amazonPrice) / amazonPrice > 0.03);
  return others.length >= 2 ? others : [];
}

export function decide(input: {
  price: number;
  listPrice: number | null;
  highestPrice: number | null;
  samples: number;
  marketPrices: number[];
  threshold: number;
}): Verdict | null {
  const listOff = percentOff(input.price, input.listPrice);
  const memoryOff = input.samples >= 2 ? percentOff(input.price, input.highestPrice) : 0;
  const discount = Math.max(listOff, memoryOff);
  if (discount < input.threshold) return null;

  const { median, kept } = robustMedian(input.marketPrices);
  if (memoryOff >= input.threshold && input.highestPrice) {
    return {
      verdict: "evet",
      discount: Math.round(memoryOff * 10) / 10,
      marketMedian: median,
      marketSamples: kept.length,
      detail: `Evet. Bu ürünü daha önce ${tl(input.highestPrice)} TL görmüştük, şimdi ${tl(input.price)} TL. Düşüş %${Math.round(memoryOff)}.`,
    };
  }
  if (median && input.price <= median * 0.6) {
    const gap = (1 - input.price / median) * 100;
    return {
      verdict: "evet",
      discount: Math.round(discount * 10) / 10,
      marketMedian: median,
      marketSamples: kept.length,
      detail: `Evet, piyasaya göre de düşük. Amazon ${tl(input.price)} TL, bulunan piyasa ortası ${tl(median)} TL. Yaklaşık %${Math.round(gap)} daha ucuz.`,
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
  const unknown = decide({ price: 1000, listPrice: 8000, highestPrice: 1000, samples: 1, marketPrices: [], threshold: 80 });
  const skip = decide({ price: 5000, listPrice: 6000, highestPrice: 5000, samples: 1, marketPrices: [9000, 9100], threshold: 80 });
  if (yes?.verdict !== "evet" || no?.verdict !== "hayir" || memory?.verdict !== "evet" || unknown?.verdict !== "kararsiz" || skip !== null) {
    throw new Error("karar motoru bozuldu");
  }
  const echoed = withoutEcho([1299, 1300, 7000, 7100], 1299);
  if (echoed.length !== 2 || echoed[0] !== 7000) throw new Error("piyasa filtresi bozuldu");
}
