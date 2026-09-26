import { dealWhy, displayWas, readableTitle, tl } from "@/lib/verdict";

export type AlertRow = {
  title?: string | null;
  verdict?: string | null;
  price?: number | null;
  list_price?: number | null;
  highest_price?: number | null;
  discount?: number | null;
  market_median?: number | null;
  market_samples?: number | null;
  detail?: string | null;
  url?: string | null;
};

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${tl(Number(value))} TL`;
}

export function formatAlert(alert: AlertRow): string {
  const price = Number(alert.price || 0);
  const was = displayWas(price, alert.highest_price ?? null, alert.list_price ?? null);
  const drop = was ? Math.round(((was - price) / was) * 100) : Math.round(Number(alert.discount || 0));
  const market = alert.market_median != null ? Number(alert.market_median) : null;
  const head = alert.verdict === "evet" ? "EVET" : alert.verdict === "bak" ? "BAK" : "KONTROL";
  const lines = [
    "<b>ÇAMAŞIRMAKİNESİ</b>",
    head,
    "",
    esc(readableTitle(alert.title || "Ürün")),
    "",
  ];
  if (was && was > price) {
    lines.push(`Eski: ${money(was)}`);
    lines.push(`Şimdi: ${money(price)}`);
  } else {
    lines.push(`Şimdi: ${money(price)}`);
    lines.push("Eski: kayıtlı değil");
  }
  if (drop > 0) lines.push(`%${drop} düşmüş`);
  if (market) lines.push(`Piyasa: ${money(market)}`);
  else lines.push("Piyasa: henüz yok");
  lines.push("", esc(dealWhy({ price, was, market, detail: alert.detail || "" })));
  lines.push("", esc(alert.url || ""));
  return lines.join("\n");
}

async function telegram(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json()) as { ok?: boolean; description?: string; result?: unknown };
  if (!data.ok) throw new Error(data.description || "Telegram cevap vermedi");
  return data;
}

export async function sendMessage(token: string, chatId: string, text: string): Promise<number | null> {
  const data = await telegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  });
  const id = Number((data.result as { message_id?: number } | undefined)?.message_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function deleteMessage(token: string, chatId: string, messageId: number): Promise<void> {
  await telegram(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

export async function discoverChats(token: string): Promise<{ id: string; label: string }[]> {
  const data = await telegram(token, "getUpdates");
  const found = new Map<string, string>();
  const updates = (data.result as { message?: { chat?: { id?: number; title?: string; username?: string; first_name?: string } }; edited_message?: { chat?: { id?: number; title?: string; username?: string; first_name?: string } } }[]) || [];
  for (const update of updates) {
    const chat = update.message?.chat || update.edited_message?.chat;
    if (!chat || chat.id == null) continue;
    found.set(String(chat.id), chat.title || chat.username || chat.first_name || "sohbet");
  }
  return [...found.entries()].map(([id, label]) => ({ id, label }));
}
