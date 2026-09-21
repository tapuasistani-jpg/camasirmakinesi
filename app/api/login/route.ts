import { checkLogin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
  const result = checkLogin(body.username || "", body.password || "");
  if (!result.ok) return Response.json({ error: result.error }, { status: 401 });
  return Response.json({ ok: true });
}
