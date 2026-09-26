import { ensureSchema, getConfig } from "../lib/db";
import { sendMessage } from "../lib/telegram";

async function main() {
  await ensureSchema();
  const config = await getConfig();
  if (!config.token || !config.chatId) {
    console.error("Telegram ayarı boş. Bot token veya chat id veritabanında yok.");
    process.exit(1);
  }
  await sendMessage(
    config.token,
    config.chatId,
    [
      "<b>ÇAMAŞIRMAKİNESİ</b>",
      "TEST",
      "",
      "Bot çalışıyor.",
      "Eski: 1.200 TL",
      "Şimdi: 480 TL",
      "%60 düşmüş",
      "",
      "Bundan sonra gerçek fırsatta da eski fiyat böyle yazacak.",
    ].join("\n"),
  );
  console.log("telegram gitti");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Telegram gitmedi");
  process.exit(1);
});
