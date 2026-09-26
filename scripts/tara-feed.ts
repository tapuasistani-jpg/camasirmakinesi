import { readFileSync } from "node:fs";

import { databaseUrl, ensureSchema } from "../lib/db";
import { eatPage, type ScanLane } from "../lib/feed";

type Body = {
  kind?: unknown;
  url?: unknown;
  html?: unknown;
  label?: unknown;
  quiet?: unknown;
  lane?: unknown;
};

async function main() {
  if (!databaseUrl()) {
    console.error("POSTGRES_URL yok");
    process.exit(1);
  }
  const file = process.argv[2] || "gonder.json";
  const body = JSON.parse(readFileSync(file, "utf8")) as Body;
  const lane: ScanLane = body.lane === "site" ? "site" : "depo";
  const kind =
    body.kind === "reyon" || body.kind === "takip" || body.kind === "urun" || body.kind === "site"
      ? body.kind
      : lane === "site"
        ? "site"
        : "tur";
  const url = typeof body.url === "string" ? body.url : "";
  const html = typeof body.html === "string" ? body.html : "";
  const label = typeof body.label === "string" ? body.label : "";
  const quiet = body.quiet === true;
  if (!url.startsWith("https://www.amazon.com.tr/")) {
    process.stdout.write(JSON.stringify({ error: "adres Amazon değil" }));
    process.exit(1);
  }
  await ensureSchema();
  process.stdout.write(JSON.stringify(await eatPage({ kind, url, html, label, quiet, lane })));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "sayfa okunamadı";
  process.stdout.write(JSON.stringify({ ok: false, blocked: false, error: message }));
  process.exit(1);
});
