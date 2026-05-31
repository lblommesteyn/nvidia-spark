/**
 * Parakeet ASR client — calls ml/parakeet_serve.py (default port 8789).
 * Degrades gracefully when the service is unavailable.
 */

/** Set PARAKEET_URL when the API runs on a different host than Parakeet (e.g. Mac → GX10). */
export const PARAKEET_BASE = process.env.PARAKEET_URL ?? "http://127.0.0.1:8789";
const HEALTH_TIMEOUT_MS = 3000;
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.PARAKEET_TIMEOUT_MS ?? 120_000);

export interface ParakeetHealth {
  available: boolean;
  loaded: boolean;
  url: string;
  error?: string;
}

/** Always probe fresh — Parakeet is often started after the Node server. */
export async function parakeetHealth(): Promise<ParakeetHealth> {
  const url = PARAKEET_BASE;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      return { available: false, loaded: false, url, error: `HTTP ${res.status}` };
    }
    const d = (await res.json()) as { ok?: boolean; loaded?: boolean; error?: string | null };
    return {
      available: d.ok !== false,
      loaded: Boolean(d.loaded),
      url,
      error: d.error ?? undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "connection refused";
    return { available: false, loaded: false, url, error: msg };
  }
}

export async function parakeetAvailable(): Promise<boolean> {
  return (await parakeetHealth()).available;
}

export function resetParakeetAvailability(): void {
  /* no-op — kept for callers that reset ML-style caches */
}

export async function parakeetTranscribe(
  audio: Buffer,
  filename: string,
): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(audio)]), filename);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS);
    const res = await fetch(`${PARAKEET_BASE}/transcribe`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(err || `ASR HTTP ${res.status}`);
    }
    const d = (await res.json()) as { text?: string };
    return (d.text ?? "").trim() || null;
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("ASR service unavailable");
  }
}
