/**
 * PredictHQ — demand intelligence for events around Toronto.
 *
 * Requires a bearer token (PREDICTHQ_TOKEN). PredictHQ is the highest-value
 * source for the demand model because every event carries a `rank`,
 * `local_rank`, and predicted attendance (`phq_attendance`) — exactly the
 * signals needed to forecast how the city will "flow". We stash those in meta
 * so the neighbourhood flow model and the agent can reason about them.
 *
 *   GET https://api.predicthq.com/v1/events/
 *       ?within=15km@43.6535,-79.3839&active.gte=<today>&sort=rank&limit=50
 *   Authorization: Bearer <token>
 */

import { cached, fetchJson, nowIso } from "../../cache.ts";
import type { CivicRecord, SourceResult } from "../../types.ts";

export function predicthqEnabled(): boolean {
  return Boolean(process.env.PREDICTHQ_TOKEN);
}

interface PhqEvent {
  id?: string;
  title?: string;
  category?: string;
  rank?: number;
  local_rank?: number;
  phq_attendance?: number;
  start?: string;
  /** [lon, lat] */
  location?: [number, number];
  entities?: Array<{ name?: string; type?: string }>;
}

interface PhqResponse {
  results?: PhqEvent[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadPredictHqEvents(): Promise<SourceResult<CivicRecord[]>> {
  if (!predicthqEnabled()) {
    return {
      source: "events-predicthq",
      status: "demo",
      fetchedAt: nowIso(),
      note: "PREDICTHQ_TOKEN not set — adapter disabled.",
      data: [],
      attribution: "PredictHQ",
    };
  }

  return cached(
    "events:predicthq",
    async () => {
      const url =
        "https://api.predicthq.com/v1/events/" +
        "?within=15km@43.6535,-79.3839" +
        `&active.gte=${today()}&sort=rank&limit=50`;
      const res = await fetchJson<PhqResponse>(url, {
        timeoutMs: 9000,
        headers: { Authorization: `Bearer ${process.env.PREDICTHQ_TOKEN}` },
      });
      const events = res.results ?? [];
      const records: CivicRecord[] = events.map((ev, i) => {
        const lon = ev.location?.[0];
        const lat = ev.location?.[1];
        const venue = ev.entities?.find((e) => e.type === "venue")?.name;
        return {
          id: `phq-${ev.id ?? i}`,
          category: "event",
          title: ev.title ?? "Event",
          detail: [
            ev.category,
            venue,
            ev.phq_attendance ? `~${ev.phq_attendance.toLocaleString()} expected` : null,
            ev.rank != null ? `rank ${ev.rank}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          lon,
          lat,
          meta: {
            provider: "predicthq",
            kind: "demand",
            category: ev.category,
            rank: ev.rank,
            localRank: ev.local_rank,
            attendance: ev.phq_attendance,
            venue,
            start: ev.start,
          },
        };
      });
      return {
        source: "events-predicthq",
        status: records.length > 0 ? ("live" as const) : ("demo" as const),
        fetchedAt: nowIso(),
        data: records,
        attribution: "PredictHQ (demand intelligence)",
      };
    },
    10 * 60 * 1000,
  );
}
