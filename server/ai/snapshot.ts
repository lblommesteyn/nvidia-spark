/**
 * Background snapshot service — runs inside the server process.
 *
 * Every N minutes, captures signal state for all sample locations and stores
 * it in the SQLite DB. This builds up the historical pattern library that the
 * agent and forecast use to ground answers in past outcomes.
 */
import { SAMPLE_LOCATIONS } from "./dataset.ts";
import { buildContext } from "./context.ts";
import { buildHeuristic } from "./forecast.ts";
import { storeSnapshot } from "./patterns.ts";
import { snapshots } from "../db.ts";

async function capture(): Promise<void> {
  let written = 0;
  for (const loc of SAMPLE_LOCATIONS) {
    try {
      const ctx = await buildContext({
        point: loc.point,
        radiusM: 750,
        businessType: loc.businessType,
      });
      const f = buildHeuristic(ctx);
      storeSnapshot(ctx, loc.name, loc.businessType, f.score, f.level, f.headline);
      written++;
    } catch (err) {
      // Non-fatal — one bad source shouldn't stop the whole capture.
      console.warn(`[snapshot] ${loc.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[snapshot] ${new Date().toISOString().slice(0, 19)} — captured ${written}/${SAMPLE_LOCATIONS.length} locations (total: ${snapshots.count()})`);
}

export function startSnapshotService(intervalMs = 15 * 60_000): () => void {
  // Capture immediately on start so the pattern store is warm from the first request.
  capture().catch((e) => console.error("[snapshot] initial capture failed:", e));
  const id = setInterval(
    () => capture().catch((e) => console.error("[snapshot] capture failed:", e)),
    intervalMs,
  );
  return () => clearInterval(id);
}
