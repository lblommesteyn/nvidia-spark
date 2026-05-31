/**
 * CityFlow ML forecast client.
 * Calls the Python Flask microservice (ml/serve.py, default port 8788).
 * All methods degrade gracefully when the service is unavailable.
 */

const ML_BASE = process.env.ML_URL ?? "http://localhost:8788";
const TIMEOUT_MS = 2000; // never block a user response waiting for Python

interface MLPredictBody {
  business_type: string;
  conditions: Array<{
    hour: number;
    dow: number;
    weather: string;
    event_nearby: boolean;
    transit_disruption: boolean;
  }>;
}

interface MLPredictResponse {
  predictions: number[];
  archetype: string;
  model: "ml" | "heuristic";
  feature_count: number;
}

interface MLProfileResponse {
  type: string;
  archetype: string;
  model: "ml" | "heuristic";
  /** 7 rows (Mon=0..Sun=6) × 24 columns (hour) of predicted customers */
  grid: number[][];
  peak_hour: number;
  peak_dow: number;
}

export interface MLWeeklyProfile {
  grid: number[][];
  peakHour: number;
  peakDow: number;
  model: "ml" | "heuristic";
  archetype: string;
}

let _mlAvailable: boolean | null = null;

export async function mlAvailable(): Promise<boolean> {
  if (_mlAvailable !== null) return _mlAvailable;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${ML_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    _mlAvailable = res.ok;
  } catch {
    _mlAvailable = false;
  }
  return _mlAvailable;
}

/** Reset availability cache (called on server boot to detect a freshly started service). */
export function resetMlAvailability(): void {
  _mlAvailable = null;
}

/**
 * Fetch predicted customer counts for specific (hour, conditions) points.
 * Returns null if the service is unavailable.
 */
export async function mlPredict(body: MLPredictBody): Promise<MLPredictResponse | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${ML_BASE}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return res.json() as Promise<MLPredictResponse>;
  } catch {
    return null;
  }
}

/**
 * Fetch the 7×24 demand grid for a business type.
 * Returns null if the service is unavailable.
 */
export async function mlWeeklyProfile(
  businessType: string,
  opts: { weather?: string; event?: boolean; disruption?: boolean } = {},
): Promise<MLWeeklyProfile | null> {
  try {
    const q = new URLSearchParams({ type: businessType });
    if (opts.weather) q.set("weather", opts.weather);
    if (opts.event != null) q.set("event", String(opts.event));
    if (opts.disruption != null) q.set("disruption", String(opts.disruption));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${ML_BASE}/profile?${q}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const d = await res.json() as MLProfileResponse;
    return {
      grid: d.grid,
      peakHour: d.peak_hour,
      peakDow: d.peak_dow,
      model: d.model,
      archetype: d.archetype,
    };
  } catch {
    return null;
  }
}

/**
 * Convert ML grid + live conditions into a demand score (0..1).
 * Peak of predicted customers is the 100 % reference; current hour is normalized against it.
 */
export function mlScoreFromGrid(
  grid: number[][],
  hour: number,
  dow: number,
): number {
  const flat = grid.flat();
  const max = Math.max(...flat, 1);
  const val = grid[dow]?.[hour] ?? 0;
  return Math.min(1, val / max);
}
