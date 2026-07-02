/**
 * Provider-agnostic chat LLM with an ordered fallback chain. Every provider
 * whose env is configured is tried in priority order; the first that answers
 * wins, and any failure (unreachable host, timeout, empty output) transparently
 * falls through to the next one, ending at the deterministic mock:
 *
 *   1. NEMOTRON_BASE_URL   → NVIDIA Nemotron (OpenAI-compatible) — the remote
 *                            DGX Spark / GX10 serving Nemotron, or a hosted NIM
 *   2. OPENAI_API_KEY      → OpenAI Chat Completions      ┐  cloud fallback used
 *   3. ANTHROPIC_API_KEY   → Anthropic Messages           ┘  when the DGX is down
 *   4. OLLAMA_HOST         → local Ollama
 *   5. (none)              → deterministic mock that summarizes the context
 *
 * The headline use case: point NEMOTRON_BASE_URL at a remote DGX Spark AND set
 * a cloud key (OpenAI/Anthropic). Normal traffic runs on-device on the DGX; if
 * that endpoint can't be reached, requests seamlessly fail over to the cloud so
 * the public app never goes dark. Set LLM_FALLBACK=off to disable failover and
 * pin to the single preferred provider.
 */
import { fetchJson } from "../cache.ts";

type Provider = "nemotron" | "openai" | "anthropic" | "ollama" | "mock";
export type PreferredProvider = Exclude<Provider, "mock">;

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

/**
 * Ordered list of configured providers (highest priority first), always ending
 * in "mock". When LLM_FALLBACK=off, only the single preferred provider (plus the
 * mock safety net) is returned so there's no cloud failover.
 */
export function providerChain(preferred?: PreferredProvider, allowMockFallback = true): Provider[] {
  const chain: Provider[] = [];
  if (process.env.NEMOTRON_BASE_URL) chain.push("nemotron");
  if (process.env.OPENAI_API_KEY) chain.push("openai");
  if (process.env.ANTHROPIC_API_KEY) chain.push("anthropic");
  if (process.env.OLLAMA_HOST) chain.push("ollama");

  const fallbackDisabled = /^(off|false|0|no)$/i.test(process.env.LLM_FALLBACK ?? "");
  const configured = fallbackDisabled ? chain.slice(0, 1) : chain;
  if (preferred && configured.includes(preferred)) {
    return allowMockFallback
      ? [preferred, ...configured.filter((provider) => provider !== preferred), "mock"]
      : [preferred];
  }
  return allowMockFallback ? [...configured, "mock"] : configured;
}

/** The preferred (first, highest-priority) provider. */
export function activeProvider(): Provider {
  return providerChain()[0];
}

function modelFor(provider: Provider): string {
  switch (provider) {
    case "nemotron": return process.env.NEMOTRON_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1";
    case "openai": return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    case "anthropic": return process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";
    case "ollama": return process.env.OLLAMA_MODEL ?? "llama3.1";
    default: return "rule-based";
  }
}

function callOnce(provider: Provider, messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  switch (provider) {
    case "nemotron": return nemotron(messages, opts);
    case "openai": return openai(messages, opts);
    case "anthropic": return anthropic(messages, opts);
    case "ollama": return ollama(messages, opts);
    default: return Promise.resolve(mock(messages));
  }
}

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
  preferred?: PreferredProvider,
  allowMockFallback = true,
): Promise<ChatResult> {
  const chain = providerChain(preferred, allowMockFallback);
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    if (provider === "mock") return mock(messages);
    try {
      const result = await callOnce(provider, messages, opts);
      if (result.text?.trim()) return result;
      // Empty output → treat as a soft failure and fall through to the next.
      console.warn(`[provider] ${provider} returned empty text — falling back`);
      if (!allowMockFallback && preferred) throw new Error(`${provider} returned empty text`);
    } catch (err) {
      console.warn(`[provider] ${provider} failed (${err instanceof Error ? err.message : err}) — falling back`);
      if (!allowMockFallback && preferred) throw err;
    }
  }
  if (!allowMockFallback && preferred) {
    throw new Error(`${preferred} unavailable`);
  }
  return mock(messages);
}

/** Provider + model identity without making a call (preferred provider only). */
export function describeProvider(): { provider: string; model: string } {
  const provider = activeProvider();
  return { provider, model: modelFor(provider) };
}

/**
 * Full LLM stack description for /api/health: the preferred provider plus the
 * ordered fallback list, so operators can see the DGX→cloud→mock chain.
 */
export function describeChain(): { provider: string; model: string; chain: string[]; fallbacks: string[] } {
  const chain = providerChain();
  const provider = chain[0];
  return {
    provider,
    model: modelFor(provider),
    chain,
    fallbacks: chain.slice(1),
  };
}

/**
 * Short reachability probe for the Nemotron endpoint (GET /models). Used to
 * decide, before we announce streaming metadata, whether the remote DGX is up
 * or whether we should present a cloud fallback provider instead. Cached
 * briefly so a burst of requests doesn't hammer the probe.
 */
let nemotronProbe: { at: number; ok: boolean } | null = null;
async function probeNemotron(): Promise<boolean> {
  if (!process.env.NEMOTRON_BASE_URL) return false;
  const now = Date.now();
  if (nemotronProbe && now - nemotronProbe.at < 15_000) return nemotronProbe.ok;
  const base = process.env.NEMOTRON_BASE_URL.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  const apiKey = process.env.NEMOTRON_API_KEY ?? process.env.FORECAST_API_KEY;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let ok = false;
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(3000) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  nemotronProbe = { at: now, ok };
  if (!ok) console.warn("[provider] Nemotron endpoint unreachable — will use cloud fallback");
  return ok;
}

/**
 * Resolve the provider that will actually serve the next request, probing the
 * remote Nemotron endpoint so streaming metadata reflects reality (DGX vs the
 * cloud fallback) instead of optimistically claiming Nemotron when it's down.
 */
export async function resolveProvider(preferred?: PreferredProvider): Promise<{ provider: string; model: string; fallbacks: string[] }> {
  const chain = providerChain(preferred);
  for (const provider of chain) {
    if (provider === "nemotron") {
      if (await probeNemotron()) return { provider, model: modelFor(provider), fallbacks: chain.slice(1) };
      continue; // DGX down → try the next configured provider
    }
    return {
      provider,
      model: modelFor(provider),
      fallbacks: chain.filter((p) => p !== provider),
    };
  }
  return { provider: "mock", model: "rule-based", fallbacks: [] };
}

/**
 * Streaming counterpart to chat(): yields text deltas as the model produces
 * them, so the UI can render tokens live instead of waiting for the whole
 * answer. Nemotron/OpenAI/Ollama stream natively; Anthropic falls back to a
 * single chunk; the mock simulates streaming so local dev feels the same.
 */
/**
 * Stream one provider's output. nemotron/anthropic are emitted as a single
 * chunk (their SSE is flaky / a different schema); openai/ollama stream natively.
 */
async function* streamOne(provider: Provider, messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<string> {
  switch (provider) {
    case "nemotron": {
      // Single non-streaming call — the /v1 SSE path is unreliable on local NIMs.
      const { text } = await nemotron(messages, opts);
      if (text) yield text;
      return;
    }
    case "openai":
      yield* openaiStream(messages, opts);
      return;
    case "ollama":
      yield* ollamaStream(messages, opts);
      return;
    case "anthropic": {
      const { text } = await anthropic(messages, opts);
      if (text) yield text;
      return;
    }
    default:
      yield* mockStream(messages);
      return;
  }
}

export async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
  preferred?: PreferredProvider,
  allowMockFallback = true,
): AsyncGenerator<string> {
  const chain = providerChain(preferred, allowMockFallback);
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    if (provider === "mock") {
      yield* mockStream(messages);
      return;
    }
    let emitted = 0;
    try {
      for await (const delta of streamOne(provider, messages, opts)) {
        if (delta) {
          emitted += delta.length;
          yield delta;
        }
      }
    } catch (err) {
      // If we already streamed some tokens we can't cleanly restart on another
      // provider (would duplicate), so stop here. Otherwise fall through.
      if (emitted > 0) return;
      if (!allowMockFallback && preferred) throw err;
      console.warn(`[provider] ${provider} stream failed (${err instanceof Error ? err.message : err}) — falling back`);
      continue;
    }
    if (emitted > 0) return;
    // Provider produced nothing (e.g. all <think>) → try the next in the chain.
    console.warn(`[provider] ${provider} stream produced no visible output — falling back`);
    if (!allowMockFallback && preferred) {
      throw new Error(`${provider} produced no visible output`);
    }
  }
  if (!allowMockFallback && preferred) {
    throw new Error(`${preferred} unavailable`);
  }
  yield* mockStream(messages);
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

  const res = await fetchJson<{ choices: { message: { content?: string; reasoning?: string } }[] }>(
    `${base}/chat/completions`,
    {
      method: "POST",
      timeoutMs: 180_000,
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
  const reasoning = res.choices[0]?.message?.reasoning ?? "";
  const text = stripThink(raw);
  if (text.trim()) return { text, provider: "nemotron", model };
  if (reasoning.trim()) return { text: reasoning.trim(), provider: "nemotron", model };
  throw new Error("Nemotron returned no visible answer");
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
      timeoutMs: 180_000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens }),
    },
  );
  const text = res.choices[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("OpenAI returned no visible answer");
  return { text, provider: "openai", model };
}

async function anthropic(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const res = await fetchJson<{ content: Array<{ type?: string; text?: string }> }>(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      timeoutMs: 180_000,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 1024, system, messages: rest }),
    },
  );
  const text = res.content.map((block) => block.text ?? "").join("\n").trim();
  if (!text.trim()) throw new Error("Claude returned no visible answer");
  return { text, provider: "anthropic", model };
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
      timeoutMs: 180_000,
      body: JSON.stringify({ model, messages: msgs, stream: false, options }),
    },
  );
  const raw = res.message?.content ?? "";
  const text = stripThink(raw);
  if (!text.trim()) throw new Error("Ollama returned no visible answer");
  return { text, provider: "ollama", model };
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
