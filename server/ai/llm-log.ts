/**
 * Append-only JSONL log of LLM calls (timestamp, provider, question, response).
 * Default path: data/llm-calls.jsonl (gitignored). Override with LLM_LOG_PATH.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface LlmLogEntry {
  ts: string;
  provider: string;
  model: string;
  durationMs: number;
  /** User question (last user message). */
  question: string;
  /** Approximate system-prompt size in characters. */
  systemChars: number;
  response: string;
  ok: boolean;
  note?: string;
}

const LOG_PATH = resolve(process.cwd(), process.env.LLM_LOG_PATH ?? "data/llm-calls.jsonl");

export function logLlmCall(entry: LlmLogEntry): void {
  if (process.env.LLM_LOG === "off") return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    const q = entry.question.length > 72 ? `${entry.question.slice(0, 72)}…` : entry.question;
    console.log(
      `[llm-log] ${entry.durationMs}ms ${entry.provider}/${entry.model} ok=${entry.ok}` +
        (entry.note ? ` (${entry.note})` : "") +
        ` — "${q}"`,
    );
  } catch (err) {
    console.warn("[llm-log] write failed:", err instanceof Error ? err.message : err);
  }
}

export function llmLogPath(): string {
  return LOG_PATH;
}
