/**
 * Server-side fetch with timeout, in-memory TTL cache, and single-flight
 * coalescing (mirrors WorldMonitor's cachedFetchJson stampede protection).
 */

interface Entry {
  expires: number;
  value: unknown;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

const DEFAULT_TTL = 5 * 60 * 1000;
const USER_AGENT = "TorontoMonitor/0.2 (+https://localhost)";

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init?.timeoutMs ?? 10_000,
  );
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** Cache a loader by key with TTL + single-flight. */
export async function cached<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs = DEFAULT_TTL,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    try {
      const value = await loader();
      store.set(key, { expires: Date.now() + ttlMs, value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function nowIso(): string {
  return new Date().toISOString();
}
