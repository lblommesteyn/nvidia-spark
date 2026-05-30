/**
 * Fine-tuning dataset generator for the "Toronto demand forecaster".
 *
 * Turns live context snapshots into supervised training examples that teach a
 * small Nemotron (e.g. Nemotron-Nano-8B) to reproduce the demand forecast that
 * today is produced by the heuristic — or, when a strong provider is available,
 * by a larger teacher model (Llama-3.3-Nemotron-Super-49B). That distillation
 * loop is exactly what the GX10 LoRA fine-tune in docs/GX10-NEMOTRON.md consumes.
 *
 * Two on-disk shapes are emitted so the file works with either pipeline:
 *   - NeMo / OpenAI SFT "messages" JSONL  (default, broadest compatibility)
 *   - prompt/completion JSONL            (classic instruction tuning)
 */
import { buildContext, scopeFromBusiness, type LocationContext } from "./context.ts";
import {
  buildHeuristic,
  llmPrompt,
  signalDigest,
  type DemandForecast,
} from "./forecast.ts";
import { activeProvider, chat } from "./provider.ts";
import type { BusinessProfile, GeoPoint } from "../types.ts";

/** A single training row, plus the raw signals for inspection/debugging. */
export interface TrainingExample {
  /** OpenAI/NeMo chat format. */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** Classic instruction-tuning format. */
  prompt: string;
  completion: string;
  meta: {
    point: GeoPoint;
    label: "heuristic" | "teacher";
    teacherModel?: string;
    signals: Record<string, unknown>;
  };
}

const SYSTEM =
  "You are a Toronto demand-forecasting model for small businesses. " +
  "Given live civic signals, output ONLY a JSON demand forecast for the next ~12 hours.";

/** Label = the forecast we want the student to learn (target completion). */
function labelJson(f: Pick<DemandForecast, "score" | "level" | "headline" | "drivers" | "windows" | "actions">): string {
  return JSON.stringify(
    {
      score: f.score,
      level: f.level,
      headline: f.headline,
      drivers: f.drivers,
      windows: f.windows,
      actions: f.actions,
    },
    null,
    0,
  );
}

/**
 * Build one example from a context snapshot. If a non-mock provider is active it
 * is used as the TEACHER (distillation); otherwise the deterministic heuristic
 * supplies the label so dataset generation always works offline.
 */
export async function buildExample(
  ctx: LocationContext,
  business?: BusinessProfile,
): Promise<TrainingExample> {
  const prompt = llmPrompt(ctx, business);
  const heuristic = buildHeuristic(ctx);

  let completion = labelJson(heuristic);
  let label: "heuristic" | "teacher" = "heuristic";
  let teacherModel: string | undefined;

  if (activeProvider() !== "mock") {
    try {
      const res = await chat(
        [
          { role: "system", content: "You output strict JSON. No markdown, no commentary." },
          { role: "user", content: prompt },
        ],
        { reasoning: true, temperature: 0.2, maxTokens: 900 },
      );
      const start = res.text.indexOf("{");
      const end = res.text.lastIndexOf("}");
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(res.text.slice(start, end + 1));
        if (parsed && typeof parsed.score === "number") {
          completion = JSON.stringify(parsed, null, 0);
          label = "teacher";
          teacherModel = res.model;
        }
      }
    } catch {
      // keep the heuristic label
    }
  }

  return {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
      { role: "assistant", content: completion },
    ],
    prompt,
    completion,
    meta: { point: ctx.scope.point, label, teacherModel, signals: signalDigest(ctx) },
  };
}

export async function exampleForPoint(
  point: GeoPoint,
  opts: { radiusM?: number; businessType?: string } = {},
): Promise<TrainingExample> {
  const ctx = await buildContext({
    point,
    radiusM: opts.radiusM ?? 750,
    businessType: opts.businessType,
  });
  return buildExample(ctx);
}

export async function exampleForBusiness(
  business: BusinessProfile,
  radiusM = 750,
): Promise<TrainingExample> {
  const ctx = await buildContext(scopeFromBusiness(business, radiusM));
  return buildExample(ctx, business);
}

/** Serialize examples to JSONL in the requested training format. */
export function toJsonl(examples: TrainingExample[], format: "messages" | "prompt" = "messages"): string {
  return examples
    .map((ex) =>
      format === "messages"
        ? JSON.stringify({ messages: ex.messages })
        : JSON.stringify({ prompt: ex.prompt, completion: ex.completion }),
    )
    .join("\n");
}

/**
 * A spread of representative Toronto neighbourhoods/business contexts. Sampling
 * across the city (and across the day, when run on a schedule) yields a diverse
 * dataset rather than one over-fit to downtown at noon.
 */
export const SAMPLE_LOCATIONS: { name: string; businessType: string; point: GeoPoint }[] = [
  { name: "Financial District café", businessType: "cafe", point: { lon: -79.3806, lat: 43.6487 } },
  { name: "Kensington Market grocer", businessType: "grocery", point: { lon: -79.4003, lat: 43.6547 } },
  { name: "Distillery District restaurant", businessType: "restaurant", point: { lon: -79.3593, lat: 43.6503 } },
  { name: "Liberty Village gym", businessType: "gym", point: { lon: -79.4203, lat: 43.6376 } },
  { name: "The Beaches bakery", businessType: "bakery", point: { lon: -79.2986, lat: 43.6712 } },
  { name: "Yorkville boutique", businessType: "retail", point: { lon: -79.3923, lat: 43.6709 } },
  { name: "North York pharmacy", businessType: "pharmacy", point: { lon: -79.4112, lat: 43.7615 } },
  { name: "Scarborough Town diner", businessType: "restaurant", point: { lon: -79.2578, lat: 43.7764 } },
  { name: "Junction brewery taproom", businessType: "bar", point: { lon: -79.4647, lat: 43.6654 } },
  { name: "Entertainment District bar", businessType: "bar", point: { lon: -79.3899, lat: 43.6447 } },
];
