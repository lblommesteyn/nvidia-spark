/**
 * TTC service alerts — live disruptions, diversions and closures.
 *
 * The TTC publishes a public, keyless alerts feed used by their own site:
 *   https://alerts.ttc.ca/api/alerts/live-alerts
 *
 * Alerts are route-based (no coordinates), so they surface as a city-wide
 * panel and feed the agent rather than the map. They are a strong demand
 * signal: a subway closure reroutes thousands of people onto nearby streets.
 */

import { cached, fetchJson, nowIso } from "../cache.ts";
import type { CivicRecord, SourceResult } from "../types.ts";

interface TtcAlert {
  id?: string | number;
  headerText?: string;
  description?: string;
  route?: string;
  routeType?: string;
  severity?: string;
  effect?: string;
  activePeriod?: { start?: string; end?: string };
}

interface TtcAlertsResponse {
  routes?: TtcAlert[];
  accessibility?: TtcAlert[];
  // The feed shape varies; we defensively scan any array of alert-like objects.
  [key: string]: unknown;
}

function collectAlerts(payload: TtcAlertsResponse): TtcAlert[] {
  const out: TtcAlert[] = [];
  for (const v of Object.values(payload)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && ("headerText" in item || "description" in item)) {
          out.push(item as TtcAlert);
        }
      }
    }
  }
  return out;
}

export async function loadTtcAlerts(): Promise<SourceResult<CivicRecord[]>> {
  return cached(
    "ttc:alerts",
    async () => {
      const payload = await fetchJson<TtcAlertsResponse>(
        "https://alerts.ttc.ca/api/alerts/live-alerts",
        { timeoutMs: 8000 },
      );
      const alerts = collectAlerts(payload);
      const records: CivicRecord[] = alerts.slice(0, 60).map((a, i) => ({
        id: `ttc-alert-${a.id ?? i}`,
        category: "alert",
        title: [a.route ? `Route ${a.route}` : null, a.headerText ?? a.effect ?? "Service alert"]
          .filter(Boolean)
          .join(" — "),
        detail: a.description ?? a.effect ?? a.severity,
        meta: {
          provider: "ttc",
          route: a.route,
          routeType: a.routeType,
          severity: a.severity,
          effect: a.effect,
          start: a.activePeriod?.start,
        },
      }));
      return {
        source: "ttc-alerts",
        status: records.length > 0 ? ("live" as const) : ("demo" as const),
        fetchedAt: nowIso(),
        note: records.length === 0 ? "No active TTC alerts right now." : undefined,
        data: records,
        attribution: "Toronto Transit Commission — Service Alerts",
      };
    },
    60 * 1000,
  );
}
