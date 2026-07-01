/**
 * Lightweight session auth for the public deployment. Onboarding mints an
 * opaque token bound to the operator + their business; the token gates the API
 * and is the identity used for per-user rate limiting. This is deliberately
 * simple (no passwords/OAuth) — its job is a misuse guardrail for a public demo,
 * not high-assurance identity.
 */
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { sessions, type SessionRecord } from "./db.ts";

const HEADER = "x-cityflow-session";

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Best-effort client IP for rate-limiting. Honors X-Forwarded-For (Railway /
 * Vercel / proxies sit in front of the API) and falls back to the socket addr.
 */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return (
    c.req.header("x-real-ip") ??
    c.req.header("cf-connecting-ip") ??
    env?.incoming?.socket?.remoteAddress ??
    "unknown"
  );
}

/**
 * Pull the session token from a request. Header for normal fetches; query param
 * `?token=` for EventSource (SSE), which can't set custom headers.
 */
export function tokenFromRequest(c: Context): string | null {
  const header = c.req.header(HEADER);
  if (header) return header.trim();
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const q = c.req.query("token");
  return q ? q.trim() : null;
}

/** Resolve + touch the session for a request, or null when unauthenticated. */
export function sessionFromRequest(c: Context): SessionRecord | null {
  const token = tokenFromRequest(c);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  sessions.touch(token);
  return session;
}

export { HEADER as SESSION_HEADER };
