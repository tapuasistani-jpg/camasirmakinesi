import { adminOk } from "@/lib/auth";
import { addWatch, ensureSchema, priceHistory, removeWatch } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asinFrom(raw: string): string {
  const text = raw.trim();
  if (/^[A-Z0-9]{10}$/i.test(text)) return text.toUpperCase();
  const hit = text.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i) || text.match(/[?&]asin=([A-Z0-9]{10})/i);
  return hit ? hit[1].toUpperCase() : "";
}

export async function POST(request: Request) {
  if (!adminOk(request)) return Response.json({ error: "yetkisiz" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { item?: unknown; target?: unknown; remove?: unknown };
  const asin = asinFrom(typeof body.item === "string" ? body.item : "");
  if (!asin) return Response.json({ error: "Amazon linkini ya da ürün kodunu yaz" }, { status: 400 });
  const target = Number(body.target);
  try {
    await ensureSchema();
    if (body.remove) {
      await removeWatch(asin);
      return Response.json({ ok: true, removed: asin });
    }
    await addWatch(asin, Number.isFinite(target) && target > 0 ? target : null);
    return Response.json({ ok: true, asin, history: await priceHistory(asin) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "takip edilemedi";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!adminOk(request)) return Response.json({ error: "yetkisiz" }, { status: 401 });
  const asin = asinFrom(new URL(request.url).searchParams.get("asin") || "");
  if (!asin) return Response.json({ error: "ürün kodu yok" }, { status: 400 });
  try {
    await ensureSchema();
    return Response.json({ asin, history: await priceHistory(asin) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "geçmiş okunamadı";
    return Response.json({ error: message }, { status: 500 });
  }
}
