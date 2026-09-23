import { scanOk } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { eatPage } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!scanOk(request)) return Response.json({ error: "yetkisiz" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; url?: unknown; html?: unknown; label?: unknown };
  const kind = body.kind === "reyon" ? "reyon" : "tur";
  const url = typeof body.url === "string" ? body.url : "";
  const html = typeof body.html === "string" ? body.html : "";
  const label = typeof body.label === "string" ? body.label : "";
  if (!url.startsWith("https://www.amazon.com.tr/")) {
    return Response.json({ error: "adres Amazon değil" }, { status: 400 });
  }
  try {
    await ensureSchema();
    return Response.json(await eatPage({ kind, url, html, label }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "sayfa okunamadı";
    return Response.json({ ok: false, blocked: false, error: message }, { status: 500 });
  }
}
