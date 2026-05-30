/**
 * Generate a fine-tuning dataset for the Toronto demand forecaster.
 *
 * Usage:
 *   tsx scripts/gen-forecast-dataset.ts [--out data/forecast-train.jsonl]
 *                                       [--format messages|prompt]
 *                                       [--repeat N] [--radius M]
 *
 *   --repeat N   pass over SAMPLE_LOCATIONS N times (use with a cron/schedule
 *                across the day to capture time-of-day variation). Default 1.
 *
 * With NO LLM key set, labels come from the deterministic heuristic. Set a
 * Nemotron/OpenAI/Anthropic provider to distill from a stronger TEACHER model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { activeProvider } from "../server/ai/provider.ts";
import {
  SAMPLE_LOCATIONS,
  exampleForPoint,
  toJsonl,
  type TrainingExample,
} from "../server/ai/dataset.ts";

try {
  process.loadEnvFile();
} catch {
  /* no .env — heuristic labels */
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const out = arg("out", "data/forecast-train.jsonl");
const format = arg("format", "messages") as "messages" | "prompt";
const repeat = Number(arg("repeat", "1"));
const radiusM = Number(arg("radius", "750"));

async function main() {
  console.log(`[dataset] provider=${activeProvider()} format=${format} repeat=${repeat}`);
  const examples: TrainingExample[] = [];
  for (let pass = 0; pass < repeat; pass++) {
    for (const loc of SAMPLE_LOCATIONS) {
      try {
        const ex = await exampleForPoint(loc.point, { radiusM, businessType: loc.businessType });
        examples.push(ex);
        console.log(`  + ${loc.name.padEnd(34)} label=${ex.meta.label}`);
      } catch (err) {
        console.warn(`  ! ${loc.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toJsonl(examples, format) + "\n");
  const teacher = examples.filter((e) => e.meta.label === "teacher").length;
  console.log(`[dataset] wrote ${examples.length} examples → ${out} (${teacher} teacher-labelled)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
