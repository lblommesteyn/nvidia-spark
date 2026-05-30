/**
 * ESPN hidden schedule API — Toronto pro sports.
 *
 * ESPN exposes an undocumented but stable schedule endpoint that needs NO key:
 *   https://site.api.espn.com/apis/site/v2/sports/{path}/teams/{abbr}/schedule
 *
 * We query every Toronto pro team. Seasons vary (in late spring only MLB/MLS
 * are active; NHL/NBA are done; CFL hasn't started) so per-team empty/failed
 * responses are expected and tolerated. The schedule response gives a venue
 * name + city but no coordinates, so home games are placed on the map via the
 * known-venue map; away games are still listed (lat/lon undefined).
 */

import { cached, fetchJson, nowIso } from "../../cache.ts";
import type { CivicRecord, SourceResult } from "../../types.ts";
import { venueCoords } from "./venues.ts";

interface TeamDef {
  /** Toronto team display name. */
  team: string;
  league: string;
  /** ESPN sport path, e.g. "baseball/mlb". */
  path: string;
  /** ESPN team slug under /teams/. */
  slug: string;
}

const TORONTO_TEAMS: TeamDef[] = [
  { team: "Blue Jays", league: "MLB", path: "baseball/mlb", slug: "tor" },
  { team: "Toronto FC", league: "MLS", path: "soccer/usa.1", slug: "tor" },
  { team: "Maple Leafs", league: "NHL", path: "hockey/nhl", slug: "tor" },
  { team: "Raptors", league: "NBA", path: "basketball/nba", slug: "tor" },
  { team: "Argonauts", league: "CFL", path: "football/cfl", slug: "tor" },
];

interface EspnCompetitor {
  homeAway?: "home" | "away";
  team?: { displayName?: string; shortDisplayName?: string };
}

interface EspnEvent {
  id?: string;
  date?: string;
  name?: string;
  shortName?: string;
  competitions?: Array<{
    venue?: { fullName?: string; address?: { city?: string } };
    competitors?: EspnCompetitor[];
    status?: { type?: { state?: string } };
  }>;
}

interface EspnSchedule {
  events?: EspnEvent[];
}

/** Pull one team's upcoming home + away games as civic event records. */
async function loadTeam(def: TeamDef): Promise<CivicRecord[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${def.path}/teams/${def.slug}/schedule`;
  const sched = await fetchJson<EspnSchedule>(url, { timeoutMs: 8000 });
  const events = sched.events ?? [];
  const out: CivicRecord[] = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    // Only future / pre-game events.
    const state = comp.status?.type?.state;
    const when = ev.date ? new Date(ev.date) : null;
    const isUpcoming = state === "pre" || (when != null && when.getTime() > Date.now());
    if (!isUpcoming) continue;

    const venueName = comp.venue?.fullName;
    const city = comp.venue?.address?.city;

    // Is the Toronto team the home side at this competition?
    const torIsHome = (comp.competitors ?? []).some((c) => {
      const name = (c.team?.displayName ?? "").toLowerCase();
      return c.homeAway === "home" && name.includes("toronto");
    });

    const coords = torIsHome ? venueCoords(venueName, city) : null;
    const matchup = ev.shortName ?? ev.name ?? `${def.team} game`;

    out.push({
      id: `espn-${def.path.replace(/\//g, "-")}-${ev.id ?? matchup}`,
      category: "event",
      title: matchup,
      detail: [
        def.league,
        venueName,
        when ? when.toLocaleString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      lon: coords?.lon,
      lat: coords?.lat,
      meta: {
        provider: "espn",
        kind: "sports",
        team: def.team,
        league: def.league,
        venue: venueName,
        city,
        home: torIsHome,
        start: ev.date,
      },
    });
  }
  return out;
}

export async function loadEspnEvents(): Promise<SourceResult<CivicRecord[]>> {
  return cached(
    "events:espn",
    async () => {
      const results = await Promise.allSettled(TORONTO_TEAMS.map(loadTeam));
      const records: CivicRecord[] = [];
      const liveTeams: string[] = [];
      const failed: string[] = [];

      results.forEach((res, i) => {
        const def = TORONTO_TEAMS[i];
        if (res.status === "fulfilled") {
          if (res.value.length > 0) liveTeams.push(def.team);
          records.push(...res.value);
        } else {
          failed.push(def.team);
        }
      });

      // Sort by start time ascending so the soonest games come first.
      records.sort((a, b) => {
        const ta = new Date((a.meta?.start as string) ?? 0).getTime();
        const tb = new Date((b.meta?.start as string) ?? 0).getTime();
        return ta - tb;
      });

      const note = [
        liveTeams.length ? `Live: ${liveTeams.join(", ")}.` : "No teams currently in season.",
        failed.length ? `Unavailable: ${failed.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");

      return {
        source: "events-espn",
        status: records.length > 0 ? ("live" as const) : ("demo" as const),
        fetchedAt: nowIso(),
        note,
        data: records,
        attribution: "ESPN (public schedule API)",
      };
    },
    5 * 60 * 1000,
  );
}
