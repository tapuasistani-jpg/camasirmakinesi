import { writeFileSync } from "node:fs";

import { databaseUrl, ensureSchema } from "../lib/db";
import { nextTarget, type ScanLane } from "../lib/feed";

const lane: ScanLane = process.argv.includes("site") ? "site" : "depo";

async function main() {
  if (!databaseUrl()) {
    console.error("POSTGRES_URL secret yok. GitHub → Settings → Secrets and variables → Actions → POSTGRES_URL");
    process.exit(1);
  }
  await ensureSchema();
  const target = await nextTarget(lane);
  writeFileSync("sira.json", JSON.stringify(target));
  if (!target.url) {
    console.error("Sıra boş döndü.");
    process.exit(1);
  }
  console.log(`db tamam · ${target.kind} · ${target.label} · ${target.url}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : "veritabanı açılmadı");
  process.exit(1);
});
