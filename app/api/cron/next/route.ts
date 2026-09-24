import { scanOk } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { nextTarget } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!scanOk(request)) return Response.json({ error: "yetkisiz" }, { status: 401 });
  try {
    await ensureSchema();
    const lane = new URL(request.url).searchParams.get("lane") === "site" ? "site" : "depo";
    return Response.json(await nextTarget(lane));
  } catch (error) {
    const message = error instanceof Error ? error.message : "sıradaki adres bulunamadı";
    return Response.json({ error: message }, { status: 500 });
  }
}
