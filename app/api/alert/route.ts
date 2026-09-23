import { adminOk } from "@/lib/auth";
import { ensureSchema, hideAlert } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!adminOk(request)) return Response.json({ error: "yetkisiz" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) return Response.json({ error: "karar numarası yok" }, { status: 400 });
  try {
    await ensureSchema();
    await hideAlert(id);
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "kapatılamadı";
    return Response.json({ error: message }, { status: 500 });
  }
}
