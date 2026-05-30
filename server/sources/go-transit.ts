/**
 * GO Transit (GO Train) "live" positions — synthetic for the hackathon.
 *
 * Real GO real-time needs a (free) Metrolinx Open Data API key
 * (api.openmetrolinx.com, GTFS-RT). We don't have one wired yet, so this
 * generates plausible trains gliding along the real GO corridor geometry and
 * badges the result DEMO so the UI/agent stay honest. Swap to LIVE later by
 * dropping a METROLINX_API_KEY into .env and replacing `positions()`.
 */

import { nowIso } from "../cache.ts";
import { GO_LINES } from "./transit-routes.ts";
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
  note: string;
  attribution: string;
  features: GoTrain[];
}

const GO_GREEN = "#0F7A3D";

/** Total length (in degrees, good enough for interpolation) of a polyline. */
function segLengths(coords: [number, number][]): { lens: number[]; total: number } {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    const d = Math.hypot(dx, dy);
    lens.push(d);
    total += d;
  }
  return { lens, total };
}

/** Point at fraction t∈[0,1] along the polyline, plus the index of the next vertex. */
function pointAt(
  coords: [number, number][],
  t: number,
): { lon: number; lat: number; nextIdx: number } {
  const { lens, total } = segLengths(coords);
  const target = Math.min(Math.max(t, 0), 1) * total;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] >= target) {
      const f = lens[i] === 0 ? 0 : (target - acc) / lens[i];
      const a = coords[i];
      const b = coords[i + 1];
      return {
        lon: a[0] + (b[0] - a[0]) * f,
        lat: a[1] + (b[1] - a[1]) * f,
        nextIdx: i + 1,
      };
    }
    acc += lens[i];
  }
  const last = coords[coords.length - 1];
  return { lon: last[0], lat: last[1], nextIdx: coords.length - 1 };
}

/**
 * Deterministic-ish trains that advance with wall-clock time so the dots glide
 * on each refresh. Two trains per corridor, offset and travelling opposite ways.
 */
function positions(): GoTrain[] {
  const now = Date.now();
  // One full corridor traversal every ~12 min.
  const cycle = (now % 720_000) / 720_000;
  const trains: GoTrain[] = [];

  GO_LINES.forEach((line, li) => {
    const phase = (li * 0.37) % 1;
    // Outbound train: Union → terminus.
    const tOut = (cycle + phase) % 1;
    // Inbound train: terminus → Union (offset half a cycle).
    const tIn = 1 - ((cycle + phase + 0.5) % 1);

    const out = pointAt(line.coordinates, tOut);
    const inb = pointAt(line.coordinates, tIn);

    trains.push({
      type: "Feature",
      properties: {
        id: `${line.id}-out`,
        line: `GO ${line.name}`,
        color: GO_GREEN,
        direction: "outbound",
        speedKmh: 60 + ((li * 7) % 25),
        nextStation: stationLabel(line.name, out.nextIdx, line.coordinates.length),
      },
      geometry: { type: "Point", coordinates: [out.lon, out.lat] },
    });
    trains.push({
      type: "Feature",
      properties: {
        id: `${line.id}-in`,
        line: `GO ${line.name}`,
        color: GO_GREEN,
        direction: "inbound",
        speedKmh: 55 + ((li * 5) % 25),
        nextStation: inb.nextIdx <= 1 ? "Union Station" : "approaching Union",
      },
      geometry: { type: "Point", coordinates: [inb.lon, inb.lat] },
    });
  });

  return trains;
}

function stationLabel(line: string, nextIdx: number, total: number): string {
  if (nextIdx >= total - 1) return `${line} terminus`;
  if (nextIdx <= 1) return "departing Union Station";
  return `${line} line · stop ${nextIdx}`;
}

export function getGoTrains(): GoTrainCollection {
  return {
    type: "FeatureCollection",
    status: "demo",
    fetchedAt: nowIso(),
    note: "Synthetic GO Train positions (no Metrolinx Open Data key wired yet). Set METROLINX_API_KEY to go LIVE.",
    attribution: "GO Transit / Metrolinx (demo positions on real corridor geometry)",
    features: positions(),
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
