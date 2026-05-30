/**
 * Bike Share Toronto — GBFS (General Bikeshare Feed Specification).
 * Merges static station info with live status to expose real-time supply
 * (bikes available) and demand pressure (docks full / bikes empty) at each
 * station. This is one of the cleanest real-time supply/demand signals in
 * the city, so it also feeds the neighbourhood "flow" model.
 */

import { cached, fetchJson, nowIso } from "../cache.ts";
import type { CivicRecord, SourceResult } from "../types.ts";

const BASE = "https://tor.publicbikesystem.net/ube/gbfs/v1/en";

interface StationInfo {
  station_id: string;
  name: string;
  lat: number;
  lon: number;
  capacity: number;
}

interface StationStatus {
  station_id: string;
  num_bikes_available: number;
  num_docks_available: number;
  num_ebikes_available?: number;
  num_bikes_available_types?: { mechanical?: number; ebike?: number };
  is_renting: number;
  is_installed: number;
}

export interface BikeStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  capacity: number;
  bikes: number;
  ebikes: number;
  docks: number;
  /** 0 = empty of bikes, 1 = full of bikes. */
  fillRatio: number;
  /** Heuristic pressure: high when a station is empty (unmet demand) or full (no docks). */
  pressure: "empty" | "low" | "balanced" | "full";
}

function classify(bikes: number, docks: number, capacity: number): BikeStation["pressure"] {
  if (bikes === 0) return "empty";
  if (docks === 0) return "full";
  const ratio = capacity > 0 ? bikes / capacity : 0.5;
  if (ratio <= 0.2) return "low";
  return "balanced";
}

export async function getBikeStations(): Promise<BikeStation[]> {
  return cached(
    "bikeshare:stations",
    async () => {
      const [info, status] = await Promise.all([
        fetchJson<{ data: { stations: StationInfo[] } }>(`${BASE}/station_information`),
        fetchJson<{ data: { stations: StationStatus[] } }>(`${BASE}/station_status`),
      ]);
      const statusById = new Map(status.data.stations.map((s) => [s.station_id, s]));
      const stations: BikeStation[] = [];
      for (const s of info.data.stations) {
        const st = statusById.get(s.station_id);
        if (!st || st.is_installed !== 1) continue;
        const bikes = st.num_bikes_available;
        const docks = st.num_docks_available;
        stations.push({
          id: s.station_id,
          name: s.name.replace(/\s+/g, " ").trim(),
          lat: s.lat,
          lon: s.lon,
          capacity: s.capacity,
          bikes,
          ebikes: st.num_bikes_available_types?.ebike ?? st.num_ebikes_available ?? 0,
          docks,
          fillRatio: s.capacity > 0 ? bikes / s.capacity : 0.5,
          pressure: classify(bikes, docks, s.capacity),
        });
      }
      return stations;
    },
    60 * 1000, // refresh every minute — this is live status
  );
}

export async function loadBikeShare(): Promise<SourceResult<CivicRecord[]>> {
  const stations = await getBikeStations();
  const records: CivicRecord[] = stations.map((s) => ({
    id: `bike-${s.id}`,
    category: "bikeshare",
    title: s.name,
    detail: `${s.bikes} bikes (${s.ebikes} e) · ${s.docks} docks · ${s.pressure}`,
    lon: s.lon,
    lat: s.lat,
    meta: {
      bikes: s.bikes,
      ebikes: s.ebikes,
      docks: s.docks,
      capacity: s.capacity,
      fillRatio: s.fillRatio,
      pressure: s.pressure,
    },
  }));
  return {
    source: "bike-share",
    status: "live",
    fetchedAt: nowIso(),
    data: records,
    attribution: "Bike Share Toronto (GBFS)",
  };
}
