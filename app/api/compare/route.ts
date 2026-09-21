import { adminOk } from "@/lib/auth";
import { comparePrices } from "@/lib/compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!adminOk(request)) return Response.json({ error: "şifre yanlış" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  if (name.trim().length < 2) return Response.json({ error: "Ürün adını yaz" }, { status: 400 });
  try {
    return Response.json(await comparePrices(name));
  } catch (error) {
    const message = error instanceof Error ? error.message : "arama bozuldu";
    return Response.json({ error: message }, { status: 400 });
  }
}
