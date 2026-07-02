/**
 * In-memory guardrails for the public deployment: fixed-window rate limiting
 * plus a global concurrency cap on expensive LLM calls. No external dependency
 * (Redis etc.) — state lives in the process, which is fine for a single Hono
 * instance and resets on restart. Tunable via env:
 *
 *   RL_IP_PER_MIN        overall API requests per IP per minute      (default 120)
 *   RL_REGISTER_PER_HOUR onboarding/registrations per IP per hour    (default 12)
 *   RL_AGENT_PER_MIN     agent/model calls per session per minute    (default 12)
 *   RL_MODEL_CONCURRENCY simultaneous in-flight model calls, global  (default 4)
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets (for Retry-After). */
  retryAfter: number;
  limit: number;
}

/** Fixed-window counter keyed by an arbitrary string (e.g. `ip:1.2.3.4`). */
export function hit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0, limit };
  }
  w.count += 1;
  const allowed = w.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - w.count),
    retryAfter: allowed ? 0 : Math.ceil((w.resetAt - now) / 1000),
    limit,
  };
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const LIMITS = {
  ipPerMin: () => envInt("RL_IP_PER_MIN", 120),
  registerPerHour: () => envInt("RL_REGISTER_PER_HOUR", 12),
  agentPerMin: () => envInt("RL_AGENT_PER_MIN", 12),
  modelConcurrency: () => envInt("RL_MODEL_CONCURRENCY", 4),
};

// ---- Global concurrency cap for model calls --------------------------------
let inFlight = 0;

/** Try to reserve a model slot. Returns a release fn, or null if at capacity. */
export function acquireModelSlot(): (() => void) | null {
  if (inFlight >= LIMITS.modelConcurrency()) return null;
  inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
  };
}

export function modelInFlight(): number {
  return inFlight;
}

/** Periodically drop expired windows so the map doesn't grow unbounded. */
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) {
    if (now >= w.resetAt) windows.delete(key);
  }
}, 60_000).unref?.();
