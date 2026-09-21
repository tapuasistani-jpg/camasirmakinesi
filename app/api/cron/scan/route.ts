import { scanOk } from "@/lib/auth";
import { scanOnce } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(request: Request) {
  if (!scanOk(request)) return Response.json({ error: "yetkisiz" }, { status: 401 });
  try {
    return Response.json(await scanOnce());
  } catch (error) {
    const message = error instanceof Error ? error.message : "tarama bozuldu";
    return Response.json({ ok: false, blocked: false, error: message });
  }
}

export const GET = run;
export const POST = run;
