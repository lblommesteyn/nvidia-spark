/**
 * TTC live vehicle positions via the Umo IQ (NextBus) public feed.
 * Real-time bus & streetcar locations — a direct read on how the city is
 * moving right now. Capped to predictable vehicles to keep payloads sane.
 */

import { cached, fetchJson, nowIso } from "../cache.ts";
import type { CivicRecord, SourceResult } from "../types.ts";

const FEED =
  "https://retro.umoiq.com/service/publicJSONFeed?command=vehicleLocations&a=ttc&t=0";

interface Vehicle {
  id: string;
  routeTag?: string;
  dirTag?: string;
  lat?: string;
  lon?: string;
  speedKmHr?: string;
  heading?: string;
  predictable?: string;
  secsSinceReport?: string;
}

export interface TtcVehicle {
  id: string;
  route: string;
  lat: number;
  lon: number;
  speedKmh: number;
  heading: number;
}

export async function getTtcVehicles(): Promise<TtcVehicle[]> {
  return cached(
    "ttc:vehicles",
    async () => {
      const raw = await fetchJson<{ vehicle?: Vehicle[] }>(FEED, { timeoutMs: 12_000 });
      const list = raw.vehicle ?? [];
      const vehicles: TtcVehicle[] = [];
      for (const v of list) {
        if (v.predictable !== "true") continue;
        const lat = Number(v.lat);
        const lon = Number(v.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        // Drop stale reports (> 2 min old).
        if (Number(v.secsSinceReport ?? 0) > 120) continue;
        vehicles.push({
          id: v.id,
          route: v.routeTag ?? "?",
          lat,
          lon,
          speedKmh: Number(v.speedKmHr ?? 0),
          heading: Number(v.heading ?? 0),
        });
      }
      return vehicles;
    },
    30 * 1000,
  );
}

export async function loadTtc(): Promise<SourceResult<CivicRecord[]>> {
  const vehicles = await getTtcVehicles();
  const records: CivicRecord[] = vehicles.map((v) => ({
    id: `ttc-${v.id}`,
    category: "transit",
    title: `Route ${v.route}`,
    detail: `${v.speedKmh} km/h`,
    lon: v.lon,
    lat: v.lat,
    meta: { route: v.route, speedKmh: v.speedKmh, heading: v.heading },
  }));
  return {
    source: "ttc-vehicles",
    status: "live",
    fetchedAt: nowIso(),
    data: records,
    attribution: "Toronto Transit Commission via Umo IQ",
  };
}
