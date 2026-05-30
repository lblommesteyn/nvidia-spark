/**
 * Provider-agnostic chat LLM. Selects a backend from env vars at call time:
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

export function activeProvider(): string {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OLLAMA_HOST) return "ollama";
  return "mock";
}

export async function chat(messages: ChatMessage[]): Promise<ChatResult> {
  const provider = activeProvider();
  switch (provider) {
    case "openai":
      return openai(messages);
    case "anthropic":
      return anthropic(messages);
    case "ollama":
      return ollama(messages);
    default:
      return mock(messages);
  }
}

async function openai(messages: ChatMessage[]): Promise<ChatResult> {
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
      body: JSON.stringify({ model, messages, temperature: 0.3 }),
    },
  );
  return { text: res.choices[0]?.message?.content ?? "", provider: "openai", model };
}

async function anthropic(messages: ChatMessage[]): Promise<ChatResult> {
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
      body: JSON.stringify({ model, max_tokens: 1024, system, messages: rest }),
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
