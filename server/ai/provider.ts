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
      try { return await nemotron(messages, opts); } catch { return mock(messages); }
    case "openai":
      return openai(messages, opts);
    case "anthropic":
      return anthropic(messages, opts);
    case "ollama":
      try { return await ollama(messages, opts); } catch { return mock(messages); }
    default:
      return mock(messages);
  }
}

/** Provider + model identity without making a call (for streaming metadata). */
export function describeProvider(): { provider: string; model: string } {
  const provider = activeProvider();
  switch (provider) {
    case "nemotron":
      return { provider, model: process.env.NEMOTRON_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1" };
    case "openai":
      return { provider, model: process.env.OPENAI_MODEL ?? "gpt-4o-mini" };
    case "anthropic":
      return { provider, model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest" };
    case "ollama":
      return { provider, model: process.env.OLLAMA_MODEL ?? "llama3.1" };
    default:
      return { provider: "mock", model: "rule-based" };
  }
}

/**
 * Streaming counterpart to chat(): yields text deltas as the model produces
 * them, so the UI can render tokens live instead of waiting for the whole
 * answer. Nemotron/OpenAI/Ollama stream natively; Anthropic falls back to a
 * single chunk; the mock simulates streaming so local dev feels the same.
 */
export async function* chatStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string> {
  const provider = activeProvider();
  switch (provider) {
    case "nemotron": {
      // Single non-streaming call (the /v1 SSE path is unreliable on local NIM
      // servers). Falls back to the built-in mock when the server is unreachable
      // so the chat UI stays functional during development without a GPU.
      try {
        const { text } = await nemotron(messages, opts);
        if (text) { yield text; return; }
      } catch { /* server down — fall through to mock */ }
      yield* mockStream(messages);
      return;
    }
    case "openai":
      yield* openaiStream(messages, opts);
      return;
    case "ollama": {
      try {
        yield* ollamaStream(messages, opts);
        return;
      } catch (err) {
        console.error(`[provider] Ollama stream failed: ${err instanceof Error ? err.message : err} — falling back to mock`);
      }
      yield* mockStream(messages);
      return;
    }
    case "anthropic": {
      // Anthropic uses a different SSE schema; keep it simple and non-streamed.
      const { text } = await anthropic(messages, opts);
      yield text;
      return;
    }
    default:
      yield* mockStream(messages);
      return;
  }
}

/**
 * Reads an OpenAI-compatible Chat Completions SSE stream (used by Nemotron NIM
 * and OpenAI), yielding the incremental `choices[0].delta.content` text.
 */
async function* openAISSE(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
): AsyncGenerator<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} (stream)`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content ?? "";
          if (delta) yield delta as string;
        } catch {
          /* keep-alive comment or partial frame — ignore */
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function* openaiStream(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<string> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    Accept: "text/event-stream",
  };
  const payload = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens,
    stream: true,
  };
  yield* openAISSE("https://api.openai.com/v1/chat/completions", headers, payload, 60_000);
}

/** Prepend Nemotron's `detailed thinking on|off` directive when reasoning is set. */
function withReasoningDirective(messages: ChatMessage[], opts: ChatOptions): ChatMessage[] {
  if (opts.reasoning === undefined) return messages;
  const directive = `detailed thinking ${opts.reasoning ? "on" : "off"}`;
  return [{ role: "system" as const, content: directive }, ...messages];
}

async function* ollamaStream(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<string> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.1";
  const msgs = withReasoningDirective(messages, opts);
  yield* ollamaNativeStream(host, model, msgs, ollamaOptions(opts));
}

/** Build Ollama `options` (temperature, token limit) from ChatOptions. */
function ollamaOptions(opts: ChatOptions): Record<string, unknown> {
  const options: Record<string, unknown> = { temperature: opts.temperature ?? 0.3 };
  if (opts.maxTokens) options.num_predict = opts.maxTokens;
  return options;
}

/**
 * Stream from Ollama's native /api/chat (newline-delimited JSON). This is the
 * transport NVIDIA models served via Ollama stream reliably over (the OpenAI
 * /v1 SSE path is flaky on some Ollama builds). Strips <think> traces inline.
 */
async function* ollamaNativeStream(
  host: string,
  model: string,
  msgs: ChatMessage[],
  options: Record<string, unknown>,
): AsyncGenerator<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const stripper = makeThinkStripper();
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: msgs, stream: true, options }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} (stream)`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      // Ollama streams newline-delimited JSON objects (not SSE).
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const json = JSON.parse(line);
          const raw = json.message?.content ?? "";
          if (raw) {
            const clean = stripper.push(raw as string);
            if (clean) yield clean;
          }
        } catch {
          /* partial line — ignore */
        }
      }
    }
    const tail = stripper.flush();
    if (tail) yield tail;
  } finally {
    clearTimeout(timer);
  }
}

/** Simulated streaming for the no-key mock, so local dev streams too. */
async function* mockStream(messages: ChatMessage[]): AsyncGenerator<string> {
  const { text } = mock(messages);
  const tokens = text.match(/\S+\s*|\s+/g) ?? [text];
  for (const tok of tokens) {
    yield tok;
    await new Promise((r) => setTimeout(r, 12));
  }
}

/**
 * Incremental <think>…</think> remover for streamed text. Holds back a small
 * tail so a tag split across chunk boundaries is still caught.
 */
function makeThinkStripper() {
  let inThink = false;
  let buf = "";
  const OPEN = "<think>";
  const CLOSE = "</think>";
  return {
    push(chunk: string): string {
      buf += chunk;
      let out = "";
      for (;;) {
        if (inThink) {
          const end = buf.indexOf(CLOSE);
          if (end === -1) {
            // Stay in think mode; keep only enough tail to match a split </think>.
            if (buf.length > CLOSE.length) buf = buf.slice(-CLOSE.length);
            return out;
          }
          buf = buf.slice(end + CLOSE.length);
          inThink = false;
        } else {
          const start = buf.indexOf(OPEN);
          if (start === -1) {
            // Emit everything except a tail that might be a partial "<think>".
            const keep = OPEN.length - 1;
            if (buf.length > keep) {
              out += buf.slice(0, buf.length - keep);
              buf = buf.slice(buf.length - keep);
            }
            return out;
          }
          out += buf.slice(0, start);
          buf = buf.slice(start + OPEN.length);
          inThink = true;
        }
      }
    },
    flush(): string {
      if (inThink) {
        buf = "";
        return "";
      }
      const out = buf;
      buf = "";
      return out;
    },
  };
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
  const msgs = withReasoningDirective(messages, opts);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.NEMOTRON_API_KEY ?? process.env.FORECAST_API_KEY;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchJson<{ choices: { message: { content: string } }[] }>(
    `${base}/chat/completions`,
    {
      method: "POST",
      timeoutMs: 25_000,
      headers,
      body: JSON.stringify({
        model,
        messages: msgs,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1024,
      }),
    },
  );
  const raw = res.choices[0]?.message?.content ?? "";
  const text = stripThink(raw);
  return { text: text || raw.trim(), provider: "nemotron", model };
}

/**
 * Remove <think>…</think> reasoning traces from a complete response. Handles
 * closed blocks, an unclosed trailing <think> (keeps text before it), and never
 * returns empty when there is non-think content present.
 */
function stripThink(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (t) return t;
  // Unclosed <think> (e.g. cut off by max_tokens): keep any answer before it.
  t = raw.replace(/<think>[\s\S]*$/i, "").trim();
  return t;
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

async function ollama(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.1";
  const msgs = withReasoningDirective(messages, opts);
  const options: Record<string, unknown> = { temperature: opts.temperature ?? 0.3 };
  if (opts.maxTokens) options.num_predict = opts.maxTokens;
  const res = await fetchJson<{ message: { content: string } }>(
    `${host}/api/chat`,
    {
      method: "POST",
      timeoutMs: 25_000,
      body: JSON.stringify({ model, messages: msgs, stream: false, options }),
    },
  );
  const raw = res.message?.content ?? "";
  const text = stripThink(raw);
  return { text: text || raw.trim(), provider: "ollama", model };
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
      ? highlights.split("\n").filter(Boolean).map((h) => `- ${h.replace(/^[-•]\s*/, "")}`)
      : ["- No nearby civic activity matched the current radius."]),
    "",
    `*(You asked: "${question.slice(0, 160)}")*`,
  ];
  return { text: lines.join("\n"), provider: "mock", model: "rule-based" };
}

function extractBlock(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}
