/**
 * Live traffic flow — Waze-style red/amber/green congestion traces.
 *
 * Provider-agnostic:
 *   - TOMTOM_API_KEY → TomTom Traffic "Flow Segment Data": we sample a grid of
 *     points across the core, each returning a road segment polyline with
 *     currentSpeed vs freeFlowSpeed. The speed ratio drives the colour.
 *   - (none)         → a built-in demo that synthesizes congestion on Toronto's
 *     major arteries, weighted by time of day (rush hours run red), so the map
 *     is alive and demoable before a key is added.
 *
 * Returns a GeoJSON FeatureCollection of LineStrings — rendered as coloured
 * lines on the MapLibre map.
 */

import { cached, fetchJson, nowIso } from "../cache.ts";

export type Congestion = "free" | "moderate" | "heavy" | "severe";

export interface TrafficFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: {
    road: string;
    congestion: Congestion;
    speed: number;
    freeFlow: number;
    ratio: number;
    color: string;
  };
}

export interface TrafficCollection {
  type: "FeatureCollection";
  status: "live" | "demo";
  fetchedAt: string;
  note?: string;
  attribution: string;
  features: TrafficFeature[];
}

const COLOR: Record<Congestion, string> = {
  free: "#2dd4bf",
  moderate: "#ffd000",
  heavy: "#ff7b00",
  severe: "#ff3b3b",
};

export function tomtomEnabled(): boolean {
  return Boolean(process.env.TOMTOM_API_KEY);
}

/** ratio = currentSpeed / freeFlowSpeed → congestion bucket. */
function bucket(ratio: number): Congestion {
  if (ratio >= 0.85) return "free";
  if (ratio >= 0.6) return "moderate";
  if (ratio >= 0.35) return "heavy";
  return "severe";
}

// ---- Major Toronto arteries for the demo (lon,lat polylines) ----
const ARTERIES: { road: string; coords: [number, number][]; baseRatio: number }[] = [
  { road: "Gardiner Expressway", baseRatio: 0.55, coords: [[-79.478, 43.628], [-79.43, 43.633], [-79.39, 43.638], [-79.36, 43.643], [-79.33, 43.652]] },
  { road: "Don Valley Parkway", baseRatio: 0.5, coords: [[-79.349, 43.651], [-79.355, 43.676], [-79.345, 43.705], [-79.33, 43.73]] },
  { road: "Lake Shore Blvd", baseRatio: 0.7, coords: [[-79.47, 43.626], [-79.41, 43.631], [-79.37, 43.64], [-79.33, 43.65]] },
  { road: "Yonge Street", baseRatio: 0.6, coords: [[-79.383, 43.645], [-79.385, 43.665], [-79.4, 43.69], [-79.41, 43.715]] },
  { road: "Bloor Street", baseRatio: 0.62, coords: [[-79.45, 43.667], [-79.41, 43.667], [-79.38, 43.671], [-79.35, 43.677]] },
  { road: "University Ave / Avenue Rd", baseRatio: 0.66, coords: [[-79.388, 43.647], [-79.39, 43.662], [-79.397, 43.68]] },
  { road: "Spadina Avenue", baseRatio: 0.68, coords: [[-79.395, 43.64], [-79.4, 43.658], [-79.404, 43.668]] },
  { road: "Queen Street", baseRatio: 0.64, coords: [[-79.42, 43.643], [-79.39, 43.649], [-79.36, 43.656]] },
  { road: "Lakeshore / Queens Quay", baseRatio: 0.72, coords: [[-79.41, 43.638], [-79.38, 43.64], [-79.355, 43.644]] },
  { road: "Allen Road", baseRatio: 0.58, coords: [[-79.45, 43.705], [-79.445, 43.725], [-79.44, 43.745]] },
];

/** Rush-hour multiplier so the demo "breathes" through the day (Toronto time). */
function rushFactor(): number {
  const h = Number(new Date().toLocaleString("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hour12: false }));
  const morning = Math.max(0, 1 - Math.abs(h - 8.5) / 2.5);
  const evening = Math.max(0, 1 - Math.abs(h - 17.5) / 3);
  return Math.max(morning, evening); // 0 (off-peak) … 1 (peak)
}

function demoTraffic(): TrafficCollection {
  const peak = rushFactor();
  const minute = new Date().getMinutes();
  const features: TrafficFeature[] = ARTERIES.map((a, i) => {
    // Heavier at peak, with a small stable per-road wobble.
    const wobble = (Math.sin((minute + i * 13) / 9) + 1) / 2; // 0..1
    const ratio = Math.max(0.18, Math.min(0.98, a.baseRatio - peak * 0.45 - wobble * 0.12));
    const freeFlow = 80;
    const congestion = bucket(ratio);
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: a.coords },
      properties: {
        road: a.road,
        congestion,
        speed: Math.round(freeFlow * ratio),
        freeFlow,
        ratio: Number(ratio.toFixed(2)),
        color: COLOR[congestion],
      },
    };
  });
  return {
    type: "FeatureCollection",
    status: "demo",
    fetchedAt: nowIso(),
    note: "Synthetic congestion (time-of-day weighted). Set TOMTOM_API_KEY for live road speeds.",
    attribution: "Demo congestion model",
    features,
  };
}

// ---- TomTom live path ----
interface TomTomFlow {
  flowSegmentData?: {
    currentSpeed?: number;
    freeFlowSpeed?: number;
    coordinates?: { coordinate?: { latitude: number; longitude: number }[] };
  };
}

// Sample grid across the core + midtown.
const SAMPLE_POINTS: [number, number][] = [
  [43.643, -79.38], [43.65, -79.39], [43.655, -79.40], [43.64, -79.40],
  [43.66, -79.385], [43.67, -79.39], [43.648, -79.36], [43.652, -79.41],
  [43.68, -79.40], [43.70, -79.40], [43.66, -79.36], [43.63, -79.42],
];

async function liveTraffic(): Promise<TrafficCollection> {
  const key = process.env.TOMTOM_API_KEY!;
  const results = await Promise.allSettled(
    SAMPLE_POINTS.map(([lat, lon]) =>
      fetchJson<TomTomFlow>(
        `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/12/json?point=${lat},${lon}&unit=KMPH&key=${encodeURIComponent(key)}`,
        { timeoutMs: 8000 },
      ),
    ),
  );
  const features: TrafficFeature[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const seg = r.value.flowSegmentData;
    const coords = seg?.coordinates?.coordinate;
    if (!seg || !coords || coords.length < 2) continue;
    const line = coords.map((c) => [c.longitude, c.latitude] as [number, number]);
    const key2 = `${line[0].join()}|${line[line.length - 1].join()}`;
    if (seen.has(key2)) continue;
    seen.add(key2);
    const cur = seg.currentSpeed ?? 0;
    const free = seg.freeFlowSpeed ?? cur ?? 1;
    const ratio = free > 0 ? cur / free : 1;
    const congestion = bucket(ratio);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: line },
      properties: {
        road: "Road segment",
        congestion,
        speed: Math.round(cur),
        freeFlow: Math.round(free),
        ratio: Number(ratio.toFixed(2)),
        color: COLOR[congestion],
      },
    });
  }
  if (features.length === 0) throw new Error("no live segments");
  return {
    type: "FeatureCollection",
    status: "live",
    fetchedAt: nowIso(),
    attribution: "TomTom Traffic Flow",
    features,
  };
}

export async function getTraffic(): Promise<TrafficCollection> {
  return cached(
    "traffic:flow",
    async () => {
      if (!tomtomEnabled()) return demoTraffic();
      try {
        return await liveTraffic();
      } catch {
        return demoTraffic();
      }
    },
    60 * 1000,
  );
}
