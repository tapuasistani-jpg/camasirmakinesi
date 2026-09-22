import { scanOk } from "@/lib/auth";
import { ensureSchema, pinCategory } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!scanOk(request)) return Response.json({ error: "yetkisiz" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { category?: unknown };
  const category = typeof body.category === "string" ? body.category.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (!category || /[<>]/.test(category)) return Response.json({ error: "kategori yaz" }, { status: 400 });
  try {
    await ensureSchema();
    await pinCategory(category);
    return Response.json({ ok: true, category });
  } catch (error) {
    const message = error instanceof Error ? error.message : "sıraya alınamadı";
    return Response.json({ error: message }, { status: 500 });
  }
}
