/**
 * Neighbourhood boundaries + the "city flow" model.
 *
 * We load Toronto's 158 neighbourhood polygons, then aggregate live point
 * signals (construction, bike-share supply/demand, transit movement, 311
 * issues, building permits, events) into a per-neighbourhood *flow score* —
 * a v1 heuristic for where demand/activity is concentrated right now.
 *
 * This is intentionally a transparent heuristic, not a trained model: it gives
 * the map its highlighted areas and gives the agent a sense of where the city
 * is "hot". The component breakdown is returned so it can be explained.
 */

import { datastoreSearch, activeResourceId } from "../ckan.ts";
import { cached, nowIso } from "../cache.ts";
import type { CivicRecord, GeoPoint } from "../types.ts";

type Ring = [number, number][];
interface Hood {
  id: string;
  name: string;
  /** One or more polygons, each an array of rings (first = outer). */
  polygons: Ring[][];
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
}

interface RawGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

function ringsFromGeometry(geo: RawGeometry): Ring[][] {
  if (geo.type === "Polygon") {
    return [(geo.coordinates as number[][][]).map((r) => r as Ring)];
  }
  return (geo.coordinates as number[][][][]).map((poly) =>
    poly.map((r) => r as Ring),
  );
}

function bboxOf(polygons: Ring[][]): [number, number, number, number] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const poly of polygons)
    for (const ring of poly)
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
  return [minLon, minLat, maxLon, maxLat];
}

/** Ray-casting point-in-polygon for a single ring. */
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function inHood(p: GeoPoint, h: Hood): boolean {
  const [minLon, minLat, maxLon, maxLat] = h.bbox;
  if (p.lon < minLon || p.lon > maxLon || p.lat < minLat || p.lat > maxLat) return false;
  for (const poly of h.polygons) {
    if (!poly.length) continue;
    if (inRing(p.lon, p.lat, poly[0])) {
      // Subtract holes.
      let inHole = false;
      for (let k = 1; k < poly.length; k++) {
        if (inRing(p.lon, p.lat, poly[k])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

export async function getNeighbourhoods(): Promise<Hood[]> {
  return cached(
    "hoods",
    async () => {
      const rid = await activeResourceId("neighbourhoods");
      if (!rid) throw new Error("no neighbourhoods resource");
      const rows = await datastoreSearch(rid, { limit: 200 });
      const hoods: Hood[] = [];
      for (const row of rows) {
        const name = (row.AREA_NAME as string) ?? "Neighbourhood";
        const raw = row.geometry;
        if (typeof raw !== "string") continue;
        try {
          const geo = JSON.parse(raw) as RawGeometry;
          const polygons = ringsFromGeometry(geo);
          hoods.push({
            id: String(row.AREA_SHORT_CODE ?? row._id),
            name: name.replace(/\s*\(\d+\)\s*$/, "").trim(),
            polygons,
            bbox: bboxOf(polygons),
          });
        } catch {
          /* skip malformed geometry */
        }
      }
      return hoods;
    },
    24 * 60 * 60 * 1000, // boundaries are static
  );
}

export interface FlowComponent {
  construction: number;
  bikeDemand: number;
  transit: number;
  issues: number;
  development: number;
  events: number;
}

export interface FlowFeatureProps {
  id: string;
  name: string;
  score: number; // 0..1 normalized activity/pressure
  level: "low" | "moderate" | "high" | "intense";
  breakdown: FlowComponent;
  topSignal: string;
}

const WEIGHTS: Record<keyof FlowComponent, number> = {
  bikeDemand: 0.28,
  transit: 0.22,
  construction: 0.2,
  issues: 0.12,
  development: 0.12,
  events: 0.06,
};

const levelFor = (score: number): FlowFeatureProps["level"] => {
  if (score >= 0.66) return "intense";
  if (score >= 0.4) return "high";
  if (score >= 0.18) return "moderate";
  return "low";
};

export interface FlowFeature {
  type: "Feature";
  properties: FlowFeatureProps;
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}

export interface FlowCollection {
  type: "FeatureCollection";
  generatedAt: string;
  features: FlowFeature[];
}

/**
 * Compute the flow GeoJSON. Caller passes already-loaded civic records so we
 * don't double-fetch; we bucket them by neighbourhood and score each.
 */
export async function computeFlow(records: CivicRecord[]): Promise<FlowCollection> {
  const hoods = await getNeighbourhoods();
  const raw = new Map<string, FlowComponent>();
  for (const h of hoods)
    raw.set(h.id, { construction: 0, bikeDemand: 0, transit: 0, issues: 0, development: 0, events: 0 });

  for (const r of records) {
    if (r.lon == null || r.lat == null) continue;
    const p = { lon: r.lon, lat: r.lat };
    const hood = hoods.find((h) => inHood(p, h));
    if (!hood) continue;
    const c = raw.get(hood.id)!;
    switch (r.category) {
      case "construction":
      case "mobility":
        c.construction += 1;
        break;
      case "bikeshare": {
        const pressure = (r.meta?.pressure as string) ?? "balanced";
        c.bikeDemand += pressure === "empty" || pressure === "full" ? 1 : pressure === "low" ? 0.5 : 0.1;
        break;
      }
      case "transit":
        c.transit += 1;
        break;
      case "safety":
        c.issues += 1;
        break;
      case "permit":
      case "business":
        c.development += 1;
        break;
      case "event":
        c.events += 1;
        break;
    }
  }

  // Normalize each component across neighbourhoods (0..1 by max).
  const maxes: FlowComponent = { construction: 0, bikeDemand: 0, transit: 0, issues: 0, development: 0, events: 0 };
  for (const c of raw.values())
    for (const k of Object.keys(maxes) as (keyof FlowComponent)[])
      if (c[k] > maxes[k]) maxes[k] = c[k];

  const features: FlowFeature[] = hoods.map((h) => {
    const c = raw.get(h.id)!;
    let score = 0;
    const normalized: FlowComponent = { ...c };
    for (const k of Object.keys(WEIGHTS) as (keyof FlowComponent)[]) {
      const n = maxes[k] > 0 ? c[k] / maxes[k] : 0;
      normalized[k] = Math.round(n * 100) / 100;
      score += n * WEIGHTS[k];
    }
    score = Math.round(Math.min(1, score) * 100) / 100;
    const topSignal =
      (Object.keys(normalized) as (keyof FlowComponent)[]).sort(
        (a, b) => normalized[b] - normalized[a],
      )[0] ?? "construction";

    const props: FlowFeatureProps = {
      id: h.id,
      name: h.name,
      score,
      level: levelFor(score),
      breakdown: c,
      topSignal,
    };
    return {
      type: "Feature",
      properties: props,
      geometry: {
        type: "MultiPolygon",
        coordinates: h.polygons.map((poly) => poly.map((ring) => ring)),
      },
    };
  });

  return { type: "FeatureCollection", generatedAt: nowIso(), features };
}
