import { writeFileSync } from "node:fs";

import { databaseUrl, ensureSchema } from "../lib/db";
import { nextTarget, type ScanLane } from "../lib/feed";

const lane: ScanLane = process.argv.includes("site") ? "site" : "depo";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!databaseUrl()) {
    console.error("POSTGRES_URL secret yok. GitHub → Settings → Secrets and variables → Actions → POSTGRES_URL");
    process.exit(1);
  }
  let last: unknown;
  for (let i = 1; i <= 6; i += 1) {
    try {
      await ensureSchema();
      const target = await nextTarget(lane);
      writeFileSync("sira.json", JSON.stringify(target));
      if (!target.url) {
        console.error("Sıra boş döndü.");
        process.exit(1);
      }
      console.log(`db tamam · ${target.kind} · ${target.label} · ${target.url}`);
      return;
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : "veritabanı açılmadı";
      console.error(`db deneme ${i}/6: ${message}`);
      if (i < 6) await sleep(4000);
    }
  }
  const message = last instanceof Error ? last.message : "veritabanı açılmadı";
  console.error(`Neon açılmadı: ${message}`);
  console.error("Vercel → Storage → neon-indigo-village yeşil mi bak. Kota doluysa tarama durur.");
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : "veritabanı açılmadı");
  process.exit(1);
});
