import { adminOk } from "@/lib/auth";
import { getConfig, saveSettings } from "@/lib/db";
import { discoverChats } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ error: "Vercel'de ADMIN_PASSWORD tanımla" }, { status: 400 });
  }
  if (!adminOk(request)) return Response.json({ error: "şifre yanlış" }, { status: 401 });
  try {
    const body = (await request.json()) as { botToken?: string };
    if (body.botToken) await saveSettings({ botToken: body.botToken });
    const config = await getConfig();
    if (!config.token) return Response.json({ error: "Önce bot token yaz" }, { status: 400 });
    const chats = await discoverChats(config.token);
    if (!chats.length) {
      return Response.json({ error: "Sohbet yok. Telegram'da bota /start yaz, sonra tekrar dene." }, { status: 400 });
    }
    return Response.json({ chats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "sohbet bulunamadı";
    return Response.json({ error: message }, { status: 400 });
  }
}
