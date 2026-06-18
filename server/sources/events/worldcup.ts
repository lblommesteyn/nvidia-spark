/**
 * FIFA World Cup 2026 — ESPN scoreboard API (no key).
 *
 * Toronto is a 2026 host city (matches at BMO Field / "Toronto Stadium"), so
 * the tournament is highly relevant to local businesses: host-city match days
 * flood the core, and EVERY World Cup match drives bar/restaurant viewing
 * demand city-wide. We pull the tournament scoreboard across the next few weeks
 * and emit civic event records:
 *   - Toronto-hosted matches get venue coordinates (placed on the map).
 *   - Other matches are listed (no coords) and tagged so the agent/forecast can
 *     treat them as a city-wide "people are out watching the game" signal.
 *
 * Endpoint (undocumented but stable, same family as espn.ts):
 *   https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD
 */

import { cached, fetchJson, nowIso } from "../../cache.ts";
import type { CivicRecord, SourceResult } from "../../types.ts";
import { venueCoords } from "./venues.ts";

interface EspnCompetitor {
  homeAway?: "home" | "away";
  team?: { displayName?: string; shortDisplayName?: string; abbreviation?: string };
}

interface EspnScoreEvent {
  id?: string;
  date?: string;
  name?: string;
  shortName?: string;
  competitions?: Array<{
    venue?: { fullName?: string; address?: { city?: string; country?: string } };
    competitors?: EspnCompetitor[];
    status?: { type?: { state?: string; shortDetail?: string } };
  }>;
}

interface EspnScoreboard {
  events?: EspnScoreEvent[];
}

/** A Toronto-host venue if the match city/venue is in Toronto, else null. */
function torontoVenue(venueName?: string, city?: string): { lon: number; lat: number } | null {
  const c = (city ?? "").toLowerCase();
  if (c.includes("toronto")) {
    // 2026 World Cup matches in Toronto are at BMO Field ("Toronto Stadium").
    return venueCoords(venueName) ?? venueCoords("BMO Field");
  }
  return venueCoords(venueName);
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function loadWorldCupEvents(): Promise<SourceResult<CivicRecord[]>> {
  return cached(
    "events:worldcup",
    async () => {
      const now = new Date();
      const end = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000); // next 3 weeks
      const url =
        `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard` +
        `?dates=${yyyymmdd(now)}-${yyyymmdd(end)}`;

      let sb: EspnScoreboard;
      try {
        sb = await fetchJson<EspnScoreboard>(url, { timeoutMs: 9000 });
      } catch {
        return {
          source: "events-worldcup",
          status: "demo" as const,
          fetchedAt: nowIso(),
          note: "World Cup schedule unavailable.",
          data: [],
          attribution: "ESPN (FIFA World Cup schedule)",
        };
      }

      const out: CivicRecord[] = [];
      let torontoCount = 0;

      for (const ev of sb.events ?? []) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const when = ev.date ? new Date(ev.date) : null;
        // Keep upcoming + in-progress matches only.
        const state = comp.status?.type?.state;
        const isPast = state === "post" || (when != null && when.getTime() < Date.now() - 3 * 60 * 60 * 1000);
        if (isPast) continue;

        const venueName = comp.venue?.fullName;
        const city = comp.venue?.address?.city;
        const coords = torontoVenue(venueName, city);
        const inToronto = (city ?? "").toLowerCase().includes("toronto");
        if (inToronto) torontoCount++;

        const matchup = ev.shortName ?? ev.name ?? "World Cup match";

        out.push({
          id: `worldcup-${ev.id ?? matchup}`,
          category: "event",
          title: `${matchup} (World Cup)`,
          detail: [
            "FIFA World Cup 2026",
            venueName,
            city,
            when
              ? when.toLocaleString("en-CA", {
                  timeZone: "America/Toronto",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          lon: coords?.lon,
          lat: coords?.lat,
          meta: {
            provider: "espn",
            kind: "sports",
            tournament: "FIFA World Cup 2026",
            league: "FIFA World Cup",
            venue: venueName,
            city,
            // host-city match in Toronto → on-map, big local impact; otherwise a
            // city-wide viewing-demand signal (people out at bars/restaurants).
            home: inToronto,
            hostCity: inToronto,
            start: ev.date,
          },
        });
      }

      out.sort((a, b) => {
        const ta = new Date((a.meta?.start as string) ?? 0).getTime();
        const tb = new Date((b.meta?.start as string) ?? 0).getTime();
        return ta - tb;
      });

      const note =
        out.length === 0
          ? "No upcoming World Cup matches in the next 3 weeks."
          : `${out.length} upcoming match${out.length === 1 ? "" : "es"}` +
            (torontoCount ? `, ${torontoCount} in Toronto.` : " (none in Toronto; city-wide viewing demand).");

      return {
        source: "events-worldcup",
        status: out.length > 0 ? ("live" as const) : ("demo" as const),
        fetchedAt: nowIso(),
        note,
        data: out,
        attribution: "ESPN (FIFA World Cup schedule)",
      };
    },
    10 * 60 * 1000,
  );
}
