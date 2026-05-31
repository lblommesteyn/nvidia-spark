/**
 * Derive a business's transit context from its geocoded location.
 *
 * Given a point, we measure the shortest distance to each curated TTC subway /
 * streetcar line and GO corridor (from transit-routes.ts), then surface:
 *   - the nearby routes (within a walkable threshold), nearest first
 *   - a qualitative "transit relevance" label + 0-1 score the demand model can use
 *
 * No external calls — works off the in-process route geometry.
 */

import type { GeoPoint } from "../types.ts";
import { distanceM } from "../geo.ts";
import { getTransitRoutes, type TransitMode } from "./transit-routes.ts";

export interface NearbyRoute {
  id: string;
  name: string;
  mode: TransitMode;
  color: string;
  distanceM: number;
}

export type TransitRelevance = "high" | "medium" | "low" | "minimal";

export interface TransitContext {
  /** Qualitative label for quick display. */
  relevance: TransitRelevance;
  /** 0-1 score for the demand model (closer + more lines = higher). */
  score: number;
  /** Distance to the single nearest route, metres (null if none in range). */
  nearestM: number | null;
  /** Nearby routes, nearest first. */
  routes: NearbyRoute[];
}

/** Shortest distance (m) from point p to the segment a-b, via local planar projection. */
function distanceToSegmentM(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  // Project lon/lat to a local equirectangular metric plane around p.
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const px = 0;
  const py = 0;
  const ax = (a.lon - p.lon) * mPerDegLon;
  const ay = (a.lat - p.lat) * mPerDegLat;
  const bx = (b.lon - p.lon) * mPerDegLon;
  const by = (b.lat - p.lat) * mPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(ax - px, ay - py);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function routeDistanceM(p: GeoPoint, coords: [number, number][]): number {
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = { lon: coords[i][0], lat: coords[i][1] };
    const b = { lon: coords[i + 1][0], lat: coords[i + 1][1] };
    const d = distanceToSegmentM(p, a, b);
    if (d < min) min = d;
  }
  // Single-vertex routes (shouldn't happen) fall back to vertex distance.
  if (!Number.isFinite(min) && coords.length > 0) {
    min = distanceM(p, { lon: coords[0][0], lat: coords[0][1] });
  }
  return min;
}

/**
 * Compute the transit context for a point.
 * @param maxM routes within this distance count as "nearby" (default 700m, ~9 min walk)
 */
export function transitContext(point: GeoPoint, maxM = 700): TransitContext {
  const routes: NearbyRoute[] = getTransitRoutes()
    .features.map((f) => ({
      id: f.properties.id,
      name: f.properties.name,
      mode: f.properties.mode,
      color: f.properties.color,
      distanceM: Math.round(routeDistanceM(point, f.geometry.coordinates)),
    }))
    .filter((r) => Number.isFinite(r.distanceM) && r.distanceM <= maxM)
    .sort((a, b) => a.distanceM - b.distanceM);

  const nearestM = routes.length ? routes[0].distanceM : null;

  // Score blends proximity of the nearest line with how many lines are close.
  // Subway/GO weighted a touch higher than streetcar for "relevance".
  let score = 0;
  if (nearestM !== null) {
    const proximity = Math.max(0, 1 - nearestM / maxM); // 1 at the doorstep → 0 at maxM
    const breadth = Math.min(1, routes.length / 4); // saturates at ~4 nearby lines
    const rapidBonus = routes.some((r) => r.mode === "subway" || r.mode === "go") ? 0.15 : 0;
    score = Math.min(1, proximity * 0.7 + breadth * 0.15 + rapidBonus);
  }

  const relevance: TransitRelevance =
    score >= 0.66 ? "high" : score >= 0.4 ? "medium" : score > 0 ? "low" : "minimal";

  return { relevance, score: Math.round(score * 100) / 100, nearestM, routes };
}
