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
// Polylines trace the real path of each road/highway (multi-point, following
// the actual alignment) so the coloured congestion traces sit on top of the
// streets on the basemap instead of cutting across the city. baseRatio is the
// typical off-peak speed ratio for that class of road.
const ARTERIES: { road: string; coords: [number, number][]; baseRatio: number; freeFlow?: number }[] = [
  // Gardiner Expressway — Humber River east to the DVP interchange, hugging the lake.
  { road: "Gardiner Expressway", baseRatio: 0.5, freeFlow: 90, coords: [
    [-79.4759, 43.6316], [-79.4530, 43.6330], [-79.4300, 43.6344], [-79.4194, 43.6355],
    [-79.4020, 43.6372], [-79.3900, 43.6389], [-79.3807, 43.6404], [-79.3700, 43.6428],
    [-79.3600, 43.6466], [-79.3535, 43.6505],
  ] },
  // Don Valley Parkway — Gardiner interchange north through the Don Valley to the 401.
  { road: "Don Valley Parkway", baseRatio: 0.46, freeFlow: 90, coords: [
    [-79.3535, 43.6505], [-79.3556, 43.6605], [-79.3541, 43.6700], [-79.3486, 43.6802],
    [-79.3450, 43.6905], [-79.3406, 43.7008], [-79.3369, 43.7120], [-79.3347, 43.7240],
    [-79.3336, 43.7360],
  ] },
  // Highway 401 — the macro east-west spine across the top of the city.
  { road: "Highway 401", baseRatio: 0.42, freeFlow: 100, coords: [
    [-79.6090, 43.6905], [-79.5600, 43.7045], [-79.5100, 43.7175], [-79.4600, 43.7285],
    [-79.4100, 43.7355], [-79.3600, 43.7475], [-79.3100, 43.7600], [-79.2600, 43.7715],
    [-79.2100, 43.7800],
  ] },
  // Lake Shore Blvd — arterial paralleling the Gardiner just to the south.
  { road: "Lake Shore Blvd", baseRatio: 0.66, coords: [
    [-79.4750, 43.6300], [-79.4500, 43.6314], [-79.4200, 43.6332], [-79.3950, 43.6358],
    [-79.3750, 43.6394], [-79.3550, 43.6440], [-79.3400, 43.6486],
  ] },
  // Yonge Street — the N-S downtown spine (Union up to Finch), following the grid tilt.
  { road: "Yonge Street", baseRatio: 0.58, coords: [
    [-79.3776, 43.6444], [-79.3807, 43.6561], [-79.3835, 43.6606], [-79.3857, 43.6709],
    [-79.3934, 43.6880], [-79.3984, 43.7056], [-79.4055, 43.7350], [-79.4109, 43.7615],
    [-79.4148, 43.7805],
  ] },
  // Bloor St / Danforth Ave — continuous E-W corridor across midtown.
  { road: "Bloor–Danforth", baseRatio: 0.6, coords: [
    [-79.4530, 43.6571], [-79.4280, 43.6626], [-79.4043, 43.6668], [-79.3857, 43.6709],
    [-79.3585, 43.6767], [-79.3450, 43.6797], [-79.3230, 43.6845],
  ] },
  // University Ave → Avenue Rd — N-S from Front up past St Clair.
  { road: "University Ave / Avenue Rd", baseRatio: 0.64, coords: [
    [-79.3866, 43.6448], [-79.3880, 43.6540], [-79.3901, 43.6605], [-79.3945, 43.6690],
    [-79.3990, 43.6800], [-79.4030, 43.6880],
  ] },
  // Spadina Ave — N-S from Bloor down to the lake.
  { road: "Spadina Avenue", baseRatio: 0.66, coords: [
    [-79.4043, 43.6675], [-79.4019, 43.6571], [-79.3985, 43.6486], [-79.3934, 43.6400],
    [-79.3859, 43.6388],
  ] },
  // Queen Street — downtown E-W (follows the 501 streetcar alignment).
  { road: "Queen Street", baseRatio: 0.6, coords: [
    [-79.4486, 43.6391], [-79.4200, 43.6465], [-79.3886, 43.6512], [-79.3585, 43.6585],
    [-79.3247, 43.6664], [-79.2986, 43.6709],
  ] },
  // King Street — parallel downtown E-W corridor (504 alignment).
  { road: "King Street", baseRatio: 0.58, coords: [
    [-79.4203, 43.6398], [-79.4012, 43.6438], [-79.3886, 43.6471], [-79.3786, 43.6486],
    [-79.3585, 43.6552], [-79.3499, 43.6595],
  ] },
  // Bathurst Street — N-S from the lake up through midtown (grid tilts west going north).
  { road: "Bathurst Street", baseRatio: 0.63, coords: [
    [-79.4030, 43.6360], [-79.4060, 43.6470], [-79.4095, 43.6600], [-79.4118, 43.6675],
    [-79.4185, 43.6810], [-79.4240, 43.6960],
  ] },
  // Dufferin Street — N-S west-end arterial.
  { road: "Dufferin Street", baseRatio: 0.62, coords: [
    [-79.4265, 43.6360], [-79.4300, 43.6520], [-79.4340, 43.6680], [-79.4390, 43.6850],
    [-79.4430, 43.7010],
  ] },
  // Eglinton Ave — E-W crosstown corridor through Yonge & Eglinton.
  { road: "Eglinton Avenue", baseRatio: 0.55, coords: [
    [-79.4640, 43.6890], [-79.4300, 43.6960], [-79.3984, 43.7056], [-79.3650, 43.7150],
    [-79.3350, 43.7250],
  ] },
  // Allen Road — short N-S expressway spur feeding Eglinton.
  { road: "Allen Road", baseRatio: 0.54, freeFlow: 80, coords: [
    [-79.4520, 43.7000], [-79.4530, 43.7250], [-79.4535, 43.7480],
  ] },
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
    const freeFlow = a.freeFlow ?? 50; // expressways run ~90–100, surface arterials ~50
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
