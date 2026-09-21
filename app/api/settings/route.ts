import { adminOk } from "@/lib/auth";
import { getStatus, saveSettings } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ error: "Vercel'de ADMIN_PASSWORD tanımla" }, { status: 400 });
  }
  if (!adminOk(request)) return Response.json({ error: "şifre yanlış" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      botToken?: string;
      clearToken?: boolean;
      chatId?: string;
      minDiscount?: number;
      notifySuspicious?: boolean;
      urlTemplate?: string;
    };
    await saveSettings(body);
    return Response.json(await getStatus());
  } catch (error) {
    const message = error instanceof Error ? error.message : "kaydedilemedi";
    return Response.json({ error: message }, { status: 400 });
  }
}
