import { adminOk } from "@/lib/auth";
import { getConfig, saveSettings } from "@/lib/db";
import { sendMessage } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ error: "Vercel'de ADMIN_PASSWORD tanımla" }, { status: 400 });
  }
  if (!adminOk(request)) return Response.json({ error: "şifre yanlış" }, { status: 401 });
  try {
    const body = (await request.json()) as { botToken?: string; chatId?: string };
    if (body.botToken || body.chatId) await saveSettings({ botToken: body.botToken, chatId: body.chatId });
    const config = await getConfig();
    if (!config.token || !config.chatId) {
      return Response.json({ error: "Bot token ve sohbet numarası lazım" }, { status: 400 });
    }
    await sendMessage(config.token, config.chatId, "<b>ÇAMAŞIRMAKİNESİ</b>\nBağlantı tamam. %80 fırsatlar buraya düşecek.");
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "gitmedi";
    return Response.json({ error: message }, { status: 400 });
  }
}
