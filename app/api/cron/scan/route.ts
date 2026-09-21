import { checkLogin, cronOk, scanOk } from "@/lib/auth";
import { scanOnce } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(request: Request) {
  if (!scanOk(request)) {
    if (!cronOk(request)) {
      const reason = checkLogin(request.headers.get("x-admin-user") || "", request.headers.get("x-admin-password") || "");
      if (!reason.ok) return Response.json({ error: reason.error }, { status: 401 });
    }
    return Response.json({ error: "yetkisiz" }, { status: 401 });
  }
  try {
    return Response.json(await scanOnce());
  } catch (error) {
    const message = error instanceof Error ? error.message : "tarama bozuldu";
    return Response.json({ ok: false, blocked: false, error: message });
  }
}

export const GET = run;
export const POST = run;
