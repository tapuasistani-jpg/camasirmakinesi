import { databaseUrl, ensureSchema } from "../lib/db";
import { nextTarget, type ScanLane } from "../lib/feed";

const lane: ScanLane = process.argv.includes("site") ? "site" : "depo";

async function main() {
  if (!databaseUrl()) {
    console.error("POSTGRES_URL yok");
    process.exit(1);
  }
  await ensureSchema();
  process.stdout.write(JSON.stringify(await nextTarget(lane)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "sıradaki adres bulunamadı");
  process.exit(1);
});
