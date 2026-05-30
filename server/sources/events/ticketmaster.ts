/**
 * Ticketmaster Discovery API — concerts, sports, arts, festivals near Toronto.
 *
 * Requires a free API key (TICKETMASTER_API_KEY). Without it this adapter is
 * inert and the aggregator skips it. Ticketmaster returns precise venue
 * coordinates, so every event can be placed on the map.
 *
 *   GET https://app.ticketmaster.com/discovery/v2/events.json
 *       ?apikey=KEY&latlong=43.65,-79.38&radius=15&unit=miles&size=50&sort=date,asc
 */

import { cached, fetchJson, nowIso } from "../../cache.ts";
import type { CivicRecord, SourceResult } from "../../types.ts";

export function ticketmasterEnabled(): boolean {
  return Boolean(process.env.TICKETMASTER_API_KEY);
}

interface TmEvent {
  id?: string;
  name?: string;
  url?: string;
  dates?: { start?: { dateTime?: string; localDate?: string } };
  classifications?: Array<{ segment?: { name?: string }; genre?: { name?: string } }>;
  _embedded?: {
    venues?: Array<{
      name?: string;
      location?: { latitude?: string; longitude?: string };
    }>;
  };
}

interface TmResponse {
  _embedded?: { events?: TmEvent[] };
}

export async function loadTicketmasterEvents(): Promise<SourceResult<CivicRecord[]>> {
  if (!ticketmasterEnabled()) {
    return {
      source: "events-ticketmaster",
      status: "demo",
      fetchedAt: nowIso(),
      note: "TICKETMASTER_API_KEY not set — adapter disabled.",
      data: [],
      attribution: "Ticketmaster Discovery API",
    };
  }

  return cached(
    "events:ticketmaster",
    async () => {
      const key = process.env.TICKETMASTER_API_KEY!;
      const url =
        "https://app.ticketmaster.com/discovery/v2/events.json" +
        `?apikey=${encodeURIComponent(key)}` +
        "&latlong=43.6535,-79.3839&radius=15&unit=miles&size=50&sort=date,asc";
      const res = await fetchJson<TmResponse>(url, { timeoutMs: 9000 });
      const events = res._embedded?.events ?? [];
      const records: CivicRecord[] = events.map((ev, i) => {
        const venue = ev._embedded?.venues?.[0];
        const lat = venue?.location?.latitude ? Number(venue.location.latitude) : undefined;
        const lon = venue?.location?.longitude ? Number(venue.location.longitude) : undefined;
        const start = ev.dates?.start?.dateTime ?? ev.dates?.start?.localDate;
        const segment = ev.classifications?.[0]?.segment?.name;
        return {
          id: `tm-${ev.id ?? i}`,
          category: "event",
          title: ev.name ?? "Event",
          detail: [segment, venue?.name, start ? new Date(start).toLocaleString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null]
            .filter(Boolean)
            .join(" · "),
          lon,
          lat,
          meta: {
            provider: "ticketmaster",
            kind: "concert/event",
            segment,
            genre: ev.classifications?.[0]?.genre?.name,
            venue: venue?.name,
            url: ev.url,
            start,
          },
        };
      });
      return {
        source: "events-ticketmaster",
        status: records.length > 0 ? ("live" as const) : ("demo" as const),
        fetchedAt: nowIso(),
        data: records,
        attribution: "Ticketmaster Discovery API",
      };
    },
    10 * 60 * 1000,
  );
}
