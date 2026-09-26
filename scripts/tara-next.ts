import { writeFileSync } from "node:fs";

import { databaseUrl, ensureSchema } from "../lib/db";
import { nextTarget, type ScanLane } from "../lib/feed";

const lane: ScanLane = process.argv.includes("site") ? "site" : "depo";

async function main() {
  if (!databaseUrl()) {
    console.error("POSTGRES_URL yok");
    process.exit(1);
  }
  await ensureSchema();
  const target = await nextTarget(lane);
  const json = JSON.stringify(target);
  writeFileSync("sira.json", json);
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : "sıradaki adres bulunamadı");
  process.exit(1);
});
