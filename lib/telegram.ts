import { tl } from "@/lib/verdict";

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
  const head = alert.verdict === "evet" ? "EVET — piyasadan da ucuz" : "KONTROL — indirim etiketine dikkat";
  const lines = ["<b>ÇAMAŞIRMAKİNESİ</b>", head, "", esc(alert.title || "Ürün"), "", `Amazon: ${money(alert.price)}`];
  if (alert.list_price) lines.push(`Çizili: ${money(alert.list_price)} (%${Math.round(Number(alert.discount || 0))})`);
  if (alert.highest_price && Number(alert.highest_price) > Number(alert.price || 0)) {
    lines.push(`Hafızadaki en yüksek: ${money(alert.highest_price)}`);
  }
  if (alert.market_median) {
    lines.push(`Piyasa ort.: ${money(alert.market_median)} (${alert.market_samples || 0} fiyat)`);
  }
  if (alert.detail) lines.push("", esc(alert.detail));
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

export async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  await telegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  });
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
