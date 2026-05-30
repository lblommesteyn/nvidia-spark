import { useEffect, useState } from "preact/hooks";

/** Format an ISO timestamp as a compact relative string: "just now", "2m ago". */
export function timeAgo(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

interface Props {
  /** ISO timestamp the data was fetched. */
  at?: string | null;
  /** Refresh cadence in ms (default 15s). */
  intervalMs?: number;
}

/** Self-ticking "updated X ago" label. */
export function RelativeTime({ at, intervalMs = 15_000 }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  if (!at) return null;
  return (
    <span class="rel-time" title={new Date(at).toLocaleString("en-CA", { timeZone: "America/Toronto" })}>
      updated {timeAgo(at, now)}
    </span>
  );
}
