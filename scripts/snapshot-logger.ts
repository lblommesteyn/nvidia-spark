/**
 * Live signal snapshot logger.
 *
 * Appends a timestamped row per sample location every INTERVAL minutes so we
 * build a real time series of Toronto signals (features) + the heuristic
 * forecast (a weak label) while the app runs / overnight. Later these rows are
 * joined against a real demand proxy (e.g. Bike Share trip counts) to form a
 * supervised training set — see scripts/backfill (todo) and docs/GX10-NEMOTRON.md.
 *
 * Runs on its own interval (no cron needed). Append-only JSONL, bounded memory.
 *
 * Usage:
 *   nohup npm run snapshot -- --interval 15 --out data/snapshots.jsonl &
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildContext } from "../server/ai/context.ts";
import { buildHeuristic, signalDigest } from "../server/ai/forecast.ts";
import { SAMPLE_LOCATIONS } from "../server/ai/dataset.ts";

try {
  process.loadEnvFile();
} catch {
  /* no .env — live keyless sources still work */
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const out = arg("out", "data/snapshots.jsonl");
const intervalMin = Number(arg("interval", "15"));
const radiusM = Number(arg("radius", "750"));

mkdirSync(dirname(out), { recursive: true });

async function tick() {
  const capturedAt = new Date().toISOString();
  let written = 0;
  for (const loc of SAMPLE_LOCATIONS) {
    try {
      const ctx = await buildContext({ point: loc.point, radiusM, businessType: loc.businessType });
      const f = buildHeuristic(ctx);
      const row = {
        capturedAt,
        location: loc.name,
        businessType: loc.businessType,
        point: loc.point,
        signals: signalDigest(ctx),
        // Weak label from the heuristic — replace/augment with a real demand
        // proxy during backfill. Kept here so each snapshot is self-describing.
        forecast: { score: f.score, level: f.level, headline: f.headline, drivers: f.drivers },
      };
      appendFileSync(out, JSON.stringify(row) + "\n");
      written++;
    } catch (err) {
      console.warn(`  ! ${loc.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[snapshot] ${capturedAt} → wrote ${written}/${SAMPLE_LOCATIONS.length} rows to ${out}`);
}

console.log(`[snapshot] every ${intervalMin}min · ${SAMPLE_LOCATIONS.length} locations · → ${out}`);
await tick(); // capture immediately on start
setInterval(() => {
  tick().catch((e) => console.error("[snapshot] tick failed:", e));
}, intervalMin * 60_000);
