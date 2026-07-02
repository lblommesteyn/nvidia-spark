/**
 * When NEMOTRON_BASE_URL is unset, probe the local DGX stack (auth proxy :11435,
 * then direct Ollama :11434) and configure process.env so dev:all works without
 * hand-editing .env on the Spark box.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODEL = "nemotron-3-nano:30b";
const KEY_FILE = join(homedir(), ".nemotron-api-key");

function loadApiKey(): string | undefined {
  const fromEnv = process.env.NEMOTRON_API_KEY ?? process.env.FORECAST_API_KEY;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    return readFileSync(KEY_FILE, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

async function probeModels(base: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function bootstrapNemotronEnv(): Promise<boolean> {
  if (process.env.NEMOTRON_BASE_URL?.trim()) return true;

  const apiKey = loadApiKey();
  const model = process.env.NEMOTRON_MODEL?.trim() || DEFAULT_MODEL;

  const candidates: Array<{ base: string; headers: Record<string, string>; label: string }> = [
    {
      base: "http://127.0.0.1:11435/v1",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      label: "auth proxy :11435",
    },
    {
      base: "http://127.0.0.1:11434/v1",
      headers: {},
      label: "Ollama :11434",
    },
  ];

  for (const { base, headers, label } of candidates) {
    if (label.includes("11435") && !apiKey) continue;
    if (!(await probeModels(base, headers))) continue;

    process.env.NEMOTRON_BASE_URL = base;
    process.env.NEMOTRON_MODEL = model;
    if (apiKey) process.env.NEMOTRON_API_KEY = apiKey;

    // Native Ollama fallback for reliable streaming when /v1 SSE is thin on reasoning-only chunks.
    if (!process.env.OLLAMA_HOST) {
      process.env.OLLAMA_HOST = base.includes("11435") ? "http://127.0.0.1:11434" : "http://127.0.0.1:11434";
    }
    if (!process.env.OLLAMA_MODEL) process.env.OLLAMA_MODEL = model;

    console.log(`[provider] auto-configured Nemotron via ${label} → ${base} (${model})`);
    return true;
  }

  console.warn(
    "[provider] Nemotron not configured — set NEMOTRON_BASE_URL in .env or run scripts/serve-dgx-nemotron-30b.sh start",
  );
  return false;
}
