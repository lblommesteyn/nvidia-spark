/**
 * Provider-agnostic chat LLM. Selects a backend from env vars at call time:
 *   - NEMOTRON_BASE_URL   → NVIDIA Nemotron NIM (OpenAI-compatible) — e.g. the
 *                           GX10 / DGX Spark serving Llama-Nemotron locally, or
 *                           https://integrate.api.nvidia.com/v1 (hosted)
 *   - OPENAI_API_KEY      → OpenAI Chat Completions
 *   - ANTHROPIC_API_KEY   → Anthropic Messages
 *   - OLLAMA_HOST         → local Ollama
 *   - (none)              → deterministic mock that summarizes the provided context
 *
 * This lets us ship the full data + agent pipeline now and "wire the key later"
 * by just setting an env var — no code changes.
 */
import { fetchJson } from "../cache.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
}

export interface ChatOptions {
  /** Sampling temperature (default 0.3). */
  temperature?: number;
  /** Max tokens to generate. */
  maxTokens?: number;
  /**
   * For Nemotron reasoning models: enable/disable the model's "thinking" mode.
   * Nemotron uses a `detailed thinking on|off` system directive.
   */
  reasoning?: boolean;
}

export function activeProvider(): string {
  if (process.env.NEMOTRON_BASE_URL) return "nemotron";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OLLAMA_HOST) return "ollama";
  return "mock";
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const provider = activeProvider();
  switch (provider) {
    case "nemotron":
      return nemotron(messages, opts);
    case "openai":
      return openai(messages, opts);
    case "anthropic":
      return anthropic(messages, opts);
    case "ollama":
      return ollama(messages);
    default:
      return mock(messages);
  }
}

/**
 * NVIDIA Nemotron via an OpenAI-compatible endpoint (NIM). Designed to run
 * against a Nemotron model served locally on the GX10 / DGX Spark, so the agent
 * and forecasts execute on-device with no cloud round-trip. Set:
 *   NEMOTRON_BASE_URL  (e.g. http://localhost:8000/v1)
 *   NEMOTRON_MODEL     (e.g. nvidia/llama-3.3-nemotron-super-49b-v1)
 *   NEMOTRON_API_KEY   (optional — only for hosted endpoints)
 */
async function nemotron(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  const base = (process.env.NEMOTRON_BASE_URL ?? "http://localhost:8000/v1").replace(/\/$/, "");
  const model = process.env.NEMOTRON_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1";

  // Nemotron reasoning toggle is a system directive prepended to the system msg.
  const directive = opts.reasoning === undefined
    ? null
    : `detailed thinking ${opts.reasoning ? "on" : "off"}`;
  const msgs = directive
    ? [{ role: "system" as const, content: directive }, ...messages]
    : messages;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.NEMOTRON_API_KEY) headers.Authorization = `Bearer ${process.env.NEMOTRON_API_KEY}`;

  const res = await fetchJson<{ choices: { message: { content: string } }[] }>(
    `${base}/chat/completions`,
    {
      method: "POST",
      timeoutMs: 120_000,
      headers,
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1024,
      }),
    },
  );
  let text = res.choices[0]?.message?.content ?? "";
  // Strip any <think>…</think> reasoning trace from the final answer.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return { text, provider: "nemotron", model };
}

async function openai(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const res = await fetchJson<{ choices: { message: { content: string } }[] }>(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      timeoutMs: 60_000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens }),
    },
  );
  return { text: res.choices[0]?.message?.content ?? "", provider: "openai", model };
}

async function anthropic(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const res = await fetchJson<{ content: { text: string }[] }>(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      timeoutMs: 60_000,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 1024, system, messages: rest }),
    },
  );
  return { text: res.content[0]?.text ?? "", provider: "anthropic", model };
}

async function ollama(messages: ChatMessage[]): Promise<ChatResult> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.1";
  const res = await fetchJson<{ message: { content: string } }>(
    `${host}/api/chat`,
    {
      method: "POST",
      timeoutMs: 120_000,
      body: JSON.stringify({ model, messages, stream: false }),
    },
  );
  return { text: res.message?.content ?? "", provider: "ollama", model };
}

/**
 * Deterministic fallback "agent". No LLM — it extracts the structured context
 * embedded in the system prompt and produces a useful, grounded answer so the
 * product is fully demoable before a key is wired in.
 */
function mock(messages: ChatMessage[]): ChatResult {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // The context route embeds highlights between markers for the mock to read.
  const highlights = extractBlock(system, "HIGHLIGHTS");
  const profile = extractBlock(system, "BUSINESS");

  const lines = [
    "Here's what I can tell you from current Toronto data near your business:",
    "",
    ...(profile ? [profile, ""] : []),
    ...(highlights
      ? highlights.split("\n").filter(Boolean).map((h) => `• ${h.replace(/^[-•]\s*/, "")}`)
      : ["• No nearby civic activity matched the current radius."]),
    "",
    `(You asked: "${question.slice(0, 160)}")`,
    "",
    "Note: This is the built-in no-key assistant. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_HOST to enable a full conversational agent.",
  ];
  return { text: lines.join("\n"), provider: "mock", model: "rule-based" };
}

function extractBlock(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}
