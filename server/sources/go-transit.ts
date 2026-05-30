/**
 * GO Transit (GO Train) positions — a schedule-accurate simulation driven by
 * the real Metrolinx GO GTFS timetable (server/data/go-gtfs.json, built by
 * scripts/build-go-gtfs.py).
 *
 * Trains are replayed against the current Toronto wall-clock: a train only
 * exists while one of its real scheduled trips is mid-run, so the map shows
 * rush-hour density in the morning/evening, a sparse midday, and an empty
 * network overnight — matching the hours GO actually operates. Each train
 * glides along its real corridor geometry, taking the real trip duration.
 *
 * Still badged DEMO because these are simulated (schedule-derived) positions,
 * not GTFS-RT vehicle telemetry. Add METROLINX_API_KEY + a GTFS-RT reader to
 * swap in true real-time positions.
 */

import { nowIso } from "../cache.ts";
import { loadGoGtfs, type DayType, type GoRoute } from "./go-gtfs.ts";
import type { SourceResult } from "../types.ts";

export interface GoTrain {
  type: "Feature";
  properties: {
    id: string;
    line: string;
    color: string;
    direction: "inbound" | "outbound";
    speedKmh: number;
    nextStation: string;
  };
  geometry: { type: "Point"; coordinates: [number, number] };
}

export interface GoTrainCollection {
  type: "FeatureCollection";
  status: "demo";
  fetchedAt: string;
  dayType: DayType;
  serviceSecond: number;
  activeTrains: number;
  note: string;
  attribution: string;
  features: GoTrain[];
}

const DAY = 86_400;

// ---- Toronto local time --------------------------------------------------

function torontoNow(): { dayType: DayType; sec: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const wd = get("weekday");
  let hh = Number(get("hour"));
  if (hh === 24) hh = 0; // some engines emit "24" at midnight
  const sec = hh * 3600 + Number(get("minute")) * 60 + Number(get("second"));
  const dayType: DayType = wd === "Sat" ? "sat" : wd === "Sun" ? "sun" : "weekday";
  return { dayType, sec };
}

// ---- Per-route geometry precomputation (cached) --------------------------

interface DirGeom {
  coords: [number, number][];
  cum: number[]; // cumulative planar length to each vertex
  total: number; // total planar length
  lengthKm: number; // haversine length (for realistic speed)
  stations: { name: string; frac: number }[]; // ordered by frac
}

const geomCache = new Map<string, DirGeom | null>();

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function dirGeom(route: GoRoute, dir: number): DirGeom | null {
  const key = `${route.short}-${dir}`;
  if (geomCache.has(key)) return geomCache.get(key)!;
  const coords = route.geometry[String(dir)] ?? route.geometry["0"];
  if (!coords || coords.length < 2) {
    geomCache.set(key, null);
    return null;
  }
  const cum = [0];
  let total = 0;
  let lengthKm = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    total += Math.hypot(dx, dy);
    cum.push(total);
    lengthKm += haversineKm(coords[i - 1], coords[i]);
  }
  const rawStations = route.stations[String(dir)] ?? [];
  const stations = rawStations
    .map((s) => {
      // Fraction along the corridor = nearest vertex by planar distance.
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < coords.length; i++) {
        const d = (coords[i][0] - s.lon) ** 2 + (coords[i][1] - s.lat) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      return { name: s.name, frac: total === 0 ? 0 : cum[bi] / total };
    })
    .sort((a, b) => a.frac - b.frac);
  const g: DirGeom = { coords, cum, total, lengthKm, stations };
  geomCache.set(key, g);
  return g;
}

function pointAt(g: DirGeom, frac: number): [number, number] {
  const target = Math.min(Math.max(frac, 0), 1) * g.total;
  // binary-ish linear scan over cumulative lengths.
  for (let i = 1; i < g.cum.length; i++) {
    if (g.cum[i] >= target) {
      const segLen = g.cum[i] - g.cum[i - 1];
      const f = segLen === 0 ? 0 : (target - g.cum[i - 1]) / segLen;
      const a = g.coords[i - 1];
      const b = g.coords[i];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
  }
  return g.coords[g.coords.length - 1];
}

function nextStation(g: DirGeom, frac: number): string {
  for (const s of g.stations) {
    if (s.frac >= frac - 0.01) return s.name;
  }
  return g.stations.length ? `arriving ${g.stations[g.stations.length - 1].name}` : "in service";
}

// ---- Simulation ----------------------------------------------------------

function simulate(): { trains: GoTrain[]; dayType: DayType; sec: number } {
  const gtfs = loadGoGtfs();
  const routeByShort = new Map(gtfs.routes.map((r) => [r.short, r]));
  const { dayType, sec } = torontoNow();
  const trains: GoTrain[] = [];

  for (const [short, dir, dep, dur, day] of gtfs.trips) {
    if (day !== dayType) continue;
    const end = dep + dur;
    // A trip is on the road now if `sec` (or `sec + 1 day`, to catch trips that
    // departed before midnight and run past it) falls inside [dep, end].
    let elapsed: number | null = null;
    if (sec >= dep && sec <= end) elapsed = sec - dep;
    else if (sec + DAY >= dep && sec + DAY <= end) elapsed = sec + DAY - dep;
    if (elapsed === null) continue;

    const route = routeByShort.get(short);
    if (!route) continue;
    const g = dirGeom(route, dir);
    if (!g) continue;

    const frac = dur === 0 ? 0 : elapsed / dur;
    const [lon, lat] = pointAt(g, frac);
    // Average speed for the run. Trains are drawn along each line's canonical
    // full corridor, so short-turn/express trips can over-estimate distance;
    // clamp to GO's realistic operating band for an honest label.
    const rawSpeed = g.lengthKm / (dur / 3600);
    const speedKmh = Math.round(Math.min(92, Math.max(40, rawSpeed)));

    trains.push({
      type: "Feature",
      properties: {
        id: `${short}-${dir}-${dep}`,
        line: `GO ${route.name}`,
        color: route.color,
        direction: dir === 0 ? "outbound" : "inbound",
        speedKmh,
        nextStation: nextStation(g, frac),
      },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  }

  return { trains, dayType, sec };
}

export function getGoTrains(): GoTrainCollection {
  const { trains, dayType, sec } = simulate();
  return {
    type: "FeatureCollection",
    status: "demo",
    fetchedAt: nowIso(),
    dayType,
    serviceSecond: sec,
    activeTrains: trains.length,
    note: "Schedule-accurate GO Train simulation from GO GTFS (trains run only during real service hours). Set METROLINX_API_KEY for GTFS-RT live positions.",
    attribution: "GO Transit / Metrolinx — GO GTFS schedule (simulated positions)",
    features: trains,
  };
}

export function loadGoTrains(): SourceResult<GoTrainCollection["features"]> {
  const fc = getGoTrains();
  return {
    source: "go-trains",
    status: "demo",
    fetchedAt: fc.fetchedAt,
    note: fc.note,
    data: fc.features,
    attribution: fc.attribution,
  };
}
