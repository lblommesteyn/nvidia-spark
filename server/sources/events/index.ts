/**
 * Events aggregator — combines every event provider into one civic source.
 *
 *   - ESPN      (always, no key): Toronto pro sports schedules
 *   - Ticketmaster (TICKETMASTER_API_KEY): concerts, arts, festivals
 *   - PredictHQ    (PREDICTHQ_TOKEN): demand-ranked events w/ attendance
 *
 * The aggregator runs providers in parallel, tolerates individual failures,
 * de-dupes, and reports which providers were actually live in the note so the
 * UI/agent can be honest about live-vs-demo. If nothing returns, it falls back
 * to a small demo set so the panel and map are never empty.
 */

import { nowIso } from "../../cache.ts";
import type { CivicRecord, SourceResult } from "../../types.ts";
import { loadEspnEvents } from "./espn.ts";
import { loadTicketmasterEvents, ticketmasterEnabled } from "./ticketmaster.ts";
import { loadPredictHqEvents, predicthqEnabled } from "./predicthq.ts";

const DEMO_EVENTS: CivicRecord[] = [
  { id: "event-demo-1", category: "event", title: "Blue Jays vs. Yankees", detail: "MLB · Rogers Centre", lon: -79.3894, lat: 43.6414, meta: { provider: "demo", kind: "sports" } },
  { id: "event-demo-2", category: "event", title: "Concert — Budweiser Stage", detail: "Live music · Budweiser Stage", lon: -79.4155, lat: 43.6285, meta: { provider: "demo", kind: "concert/event" } },
  { id: "event-demo-3", category: "event", title: "Toronto FC vs. Inter Miami", detail: "MLS · BMO Field", lon: -79.4185, lat: 43.6332, meta: { provider: "demo", kind: "sports" } },
];

/** Drop events that share an identical title + start time across providers. */
function dedupe(records: CivicRecord[]): CivicRecord[] {
  const seen = new Set<string>();
  const out: CivicRecord[] = [];
  for (const r of records) {
    const start = (r.meta?.start as string) ?? "";
    const key = `${r.title.toLowerCase()}|${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export async function loadEvents(): Promise<SourceResult<CivicRecord[]>> {
  const [espn, tm, phq] = await Promise.allSettled([
    loadEspnEvents(),
    loadTicketmasterEvents(),
    loadPredictHqEvents(),
  ]);

  const records: CivicRecord[] = [];
  const live: string[] = [];
  const skipped: string[] = [];

  const take = (
    res: PromiseSettledResult<SourceResult<CivicRecord[]>>,
    label: string,
    enabled: boolean,
  ) => {
    if (res.status === "fulfilled" && res.value.data.length > 0) {
      records.push(...res.value.data);
      live.push(label);
    } else if (!enabled) {
      skipped.push(label);
    } else if (res.status === "rejected") {
      skipped.push(`${label} (error)`);
    }
  };

  take(espn, "ESPN sports", true);
  take(tm, "Ticketmaster", ticketmasterEnabled());
  take(phq, "PredictHQ", predicthqEnabled());

  const deduped = dedupe(records);

  if (deduped.length === 0) {
    return {
      source: "events",
      status: "demo",
      fetchedAt: nowIso(),
      note: `No live events available${skipped.length ? ` (inactive: ${skipped.join(", ")})` : ""}; showing demo events.`,
      data: DEMO_EVENTS,
      attribution: "ESPN · Ticketmaster · PredictHQ",
    };
  }

  const noteParts = [`Live: ${live.join(", ")}.`];
  if (skipped.length) noteParts.push(`Inactive: ${skipped.join(", ")} (add API keys to enable).`);

  return {
    source: "events",
    status: "live",
    fetchedAt: nowIso(),
    note: noteParts.join(" "),
    data: deduped,
    attribution: "ESPN · Ticketmaster · PredictHQ",
  };
}
