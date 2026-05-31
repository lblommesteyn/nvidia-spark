/**
 * Toronto traffic cameras (City of Toronto Open Data).
 *
 * 336 public CCTV cameras across the city. The dataset gives each camera's
 * location + intersection; each camera also exposes a JPEG snapshot that the
 * city refreshes ~every 60s. We cache the (rarely-changing) camera list and
 * expose the nearest camera to a point, plus a same-origin image proxy so the
 * browser always gets a fresh https frame.
 *
 * Dataset: https://open.toronto.ca/dataset/traffic-cameras/
 */

import { cached } from "../cache.ts";
import { distanceM } from "../geo.ts";
import type { GeoPoint } from "../types.ts";

const CAMERA_LIST_URL =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/a3309088-5fd4-4d34-8297-77c8301840ac/resource/4a568300-c7f8-496d-b150-dff6f5dc6d4f/download/traffic-camera-list-4326.geojson";

const LIST_TTL_MS = 6 * 60 * 60 * 1000; // camera locations basically never move

export interface TrafficCamera {
  recId: number;
  name: string;
  mainRoad: string;
  crossRoad: string;
  lon: number;
  lat: number;
  /** Upstream City of Toronto snapshot URL (https, refreshes ~60s). */
  imageUrl: string;
}

interface CameraFeature {
  properties?: {
    REC_ID?: number | string;
    IMAGEURL?: string;
    MAINROAD?: string;
    CROSSROAD?: string;
  };
  geometry?: { coordinates?: number[] | number[][] };
}

function firstCoord(geom: CameraFeature["geometry"]): [number, number] | null {
  const c = geom?.coordinates;
  if (!c) return null;
  // MultiPoint -> [[lon,lat]]; Point -> [lon,lat]
  const pair = Array.isArray(c[0]) ? (c[0] as number[]) : (c as number[]);
  if (typeof pair[0] === "number" && typeof pair[1] === "number") {
    return [pair[0], pair[1]];
  }
  return null;
}

/** Fetch + cache the full camera list (parsed, with valid coords only). */
export async function loadCameras(): Promise<TrafficCamera[]> {
  return cached(
    "traffic-cameras:list",
    async () => {
      const res = await fetch(CAMERA_LIST_URL, {
        headers: { Accept: "application/json", "User-Agent": "TorontoMonitor/0.2" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`camera list HTTP ${res.status}`);
      const data = (await res.json()) as { features?: CameraFeature[] };
      const out: TrafficCamera[] = [];
      for (const f of data.features ?? []) {
        const p = f.properties ?? {};
        const coord = firstCoord(f.geometry);
        const recId = Number(p.REC_ID);
        if (!coord || !p.IMAGEURL || !Number.isFinite(recId)) continue;
        const mainRoad = (p.MAINROAD ?? "").trim();
        const crossRoad = (p.CROSSROAD ?? "").trim();
        out.push({
          recId,
          name: [mainRoad, crossRoad].filter(Boolean).join(" & ") || `Camera ${recId}`,
          mainRoad,
          crossRoad,
          lon: coord[0],
          lat: coord[1],
          imageUrl: p.IMAGEURL.replace(/^http:/, "https:"),
        });
      }
      return out;
    },
    LIST_TTL_MS,
  );
}

export interface NearestCamera extends TrafficCamera {
  distanceM: number;
}

/** Cameras nearest to a point, closest first. */
export async function nearestCameras(point: GeoPoint, n = 1): Promise<NearestCamera[]> {
  const cams = await loadCameras();
  return cams
    .map((c) => ({ ...c, distanceM: distanceM(point, { lon: c.lon, lat: c.lat }) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, Math.max(1, n));
}

/** Upstream snapshot URL for a known camera id (null if unknown — avoids SSRF). */
export async function cameraImageUrl(recId: number): Promise<string | null> {
  const cams = await loadCameras();
  return cams.find((c) => c.recId === recId)?.imageUrl ?? null;
}
