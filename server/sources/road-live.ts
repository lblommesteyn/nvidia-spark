/**
 * Live road restrictions & construction closures from the City of Toronto
 * real-time feed (the same data behind the city's traffic map). Includes
 * coordinates, severity and work type — used for Waze-style closure markers
 * and construction sites on the map.
 *
 * The feed occasionally emits invalid JSON escapes (e.g. "WATER \ SEWER"),
 * so we sanitize the text before parsing.
 */

import { cached, nowIso } from "../cache.ts";
import type { CivicRecord, SourceResult } from "../types.ts";

const FEED = "https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json";

interface Closure {
  id: string;
  road?: string;
  name?: string;
  district?: string;
  latitude?: string;
  longitude?: string;
  roadClass?: string;
  planned?: number;
  description?: string;
  workPeriod?: string;
  workEventType?: string;
  contractor?: string;
  expired?: number;
}

export type Severity = "major" | "moderate" | "minor";

function severityFor(roadClass?: string): Severity {
  const rc = (roadClass ?? "").toLowerCase();
  if (rc.includes("express") || rc.includes("major")) return "major";
  if (rc.includes("minor") || rc.includes("collector")) return "moderate";
  return "minor";
}

const CONSTRUCTION_RE =
  /construct|watermain|water main|sewer|water \/ sewer|water\s+sewer|utility|gas|hydro|paving|road work|bridge|track|tcs|excavat/i;

function isConstruction(c: Closure): boolean {
  const blob = `${c.description ?? ""} ${c.workEventType ?? ""}`;
  return c.planned === 1 || CONSTRUCTION_RE.test(blob);
}

/** Parse the city feed, tolerating its occasional invalid escape sequences. */
function parseFeed(text: string): Closure[] {
  // Replace any backslash not starting a valid JSON escape with a space.
  const cleaned = text.replace(/\\(?!["\\/bfnrtu])/g, " ");
  const data = JSON.parse(cleaned) as { Closure?: Closure[] };
  return data.Closure ?? [];
}

async function fetchClosures(): Promise<Closure[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(FEED, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text());
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadRoadRestrictions(): Promise<SourceResult<CivicRecord[]>> {
  const closures = await cached("road-live", fetchClosures, 5 * 60 * 1000);
  const records: CivicRecord[] = closures
    .filter((c) => c.expired !== 1)
    .map((c) => {
      const lat = c.latitude ? Number(c.latitude) : NaN;
      const lon = c.longitude ? Number(c.longitude) : NaN;
      const construction = isConstruction(c);
      const severity = severityFor(c.roadClass);
      return {
        id: `road-${c.id}`,
        category: construction ? ("construction" as const) : ("mobility" as const),
        title: c.name || c.road || "Road restriction",
        detail: [c.description, c.workPeriod].filter(Boolean).join(" · ") || undefined,
        lon: Number.isFinite(lon) ? lon : undefined,
        lat: Number.isFinite(lat) ? lat : undefined,
        meta: {
          severity,
          roadClass: c.roadClass,
          district: c.district,
          workEventType: c.workEventType,
          contractor: c.contractor,
          construction,
        },
      };
    });
  return {
    source: "road-restrictions",
    status: "live",
    fetchedAt: nowIso(),
    data: records,
    attribution: "City of Toronto — Road Restrictions (real-time)",
  };
}
