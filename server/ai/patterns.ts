/**
 * Historic pattern matching over signal snapshots.
 *
 * Encodes every captured signal state as a 14-dim feature vector and uses
 * cosine similarity to find past moments that most closely resemble current
 * conditions. The matched moments — and their actual demand outcomes — are
 * injected into the agent and forecast prompts so the model can reason:
 * "the last N times conditions looked like this, demand was X."
 */
import { snapshots } from "../db.ts";
import { signalDigest } from "./forecast.ts";
import type { LocationContext } from "./context.ts";

export interface SimilarMoment {
  capturedAt: string;
  location: string;
  similarity: number;
  forecastScore: number;
  forecastLevel: string;
  forecastHeadline: string;
}

/**
 * Encode a signal digest into a 14-dimensional feature vector.
 * Cyclical features (hour, day-of-week) use sin/cos so distance is circular.
 */
export function toFeatureVector(digest: Record<string, unknown>, capturedAt?: string): number[] {
  const hour = Number(digest.localHour ?? 12);
  const w = (digest.weather ?? {}) as Record<string, number>;
  const aq = (digest.airQuality ?? {}) as Record<string, number>;
  const c = (digest.counts ?? {}) as Record<string, number>;

  const date = capturedAt ? new Date(capturedAt) : new Date();
  const dow = date.getDay(); // 0=Sun, 6=Sat
  const isWeekend = dow === 0 || dow === 6 ? 1 : 0;

  return [
    Math.sin((2 * Math.PI * hour) / 24),                                       // hour_sin
    Math.cos((2 * Math.PI * hour) / 24),                                       // hour_cos
    Math.sin((2 * Math.PI * dow) / 7),                                         // dow_sin
    Math.cos((2 * Math.PI * dow) / 7),                                         // dow_cos
    isWeekend,                                                                   // is_weekend
    Math.min(1, Math.max(0, (Number(w.temperatureC ?? 10) + 30) / 70)),        // temp [-30,40]→[0,1]
    Math.min(1, Number(w.precipMm ?? 0) / 20),                                 // precip [0,20]
    Math.min(1, Number(w.windKph ?? 0) / 80),                                  // wind [0,80]
    Math.min(1, Number(aq.usAqi ?? w.usAqi ?? 0) / 150),                       // aqi [0,150]
    Math.min(1, Number(c.events ?? 0) / 10),                                   // events [0,10]
    Math.min(1, Number(c.construction ?? 0) / 10),                             // construction
    Math.min(1, Number(c.transit ?? 0) / 5),                                   // transit alerts
    Math.min(1, Number(c.alerts ?? 0) / 5),                                    // 311 alerts
    Math.min(1, Number(c.aviation ?? 0) / 20),                                 // inbound flights
  ];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom < 1e-9 ? 0 : dot / denom;
}

/** Store a signal snapshot into the DB for future pattern matching. */
export function storeSnapshot(
  ctx: LocationContext,
  location: string,
  businessType: string | undefined,
  forecastScore: number,
  forecastLevel: string,
  forecastHeadline: string,
): void {
  const capturedAt = new Date().toISOString();
  const digest = signalDigest(ctx);
  const features = toFeatureVector(digest, capturedAt);
  snapshots.insert({
    captured_at: capturedAt,
    location,
    business_type: businessType ?? null,
    lon: ctx.scope.point.lon,
    lat: ctx.scope.point.lat,
    features: JSON.stringify(features),
    digest: JSON.stringify(digest),
    forecast_score: forecastScore,
    forecast_level: forecastLevel,
    forecast_headline: forecastHeadline,
  });
}

/**
 * Find the N past moments most similar to current conditions.
 * Returns empty if the snapshot store has fewer than 5 rows (not enough history).
 */
export function findSimilarMoments(ctx: LocationContext, n = 12): SimilarMoment[] {
  if (snapshots.count() < 5) return [];

  const digest = signalDigest(ctx);
  const queryVec = toFeatureVector(digest);
  const rows = snapshots.recent(30 * 24 * 60); // last 30 days

  return rows
    .flatMap((row) => {
      try {
        const vec = JSON.parse(row.features) as number[];
        const similarity = cosineSimilarity(queryVec, vec);
        if (similarity < 0.78) return [];
        return [{
          capturedAt: row.captured_at,
          location: row.location,
          similarity,
          forecastScore: row.forecast_score,
          forecastLevel: row.forecast_level,
          forecastHeadline: row.forecast_headline,
        }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, n);
}

/** Format similar moments into a prompt block the LLM can reason over. */
export function historicalPatternBlock(moments: SimilarMoment[]): string {
  if (moments.length === 0) return "";
  const avgScore = moments.reduce((s, m) => s + m.forecastScore, 0) / moments.length;
  const dominant = moments[0].forecastLevel;
  const lines = [
    `<HISTORICAL_PATTERNS count="${moments.length}" avg_score="${avgScore.toFixed(2)}" dominant_level="${dominant}">`,
    "The last time Toronto conditions looked similar to now:",
    ...moments.slice(0, 8).map((m) =>
      `  [${(m.similarity * 100).toFixed(0)}% match] ${m.capturedAt.slice(0, 16).replace("T", " ")} · ${m.location} → ${m.forecastLevel} (${Math.round(m.forecastScore * 100)}%) — ${m.forecastHeadline}`,
    ),
    `</HISTORICAL_PATTERNS>`,
  ];
  return lines.join("\n");
}
