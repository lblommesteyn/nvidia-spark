/**
 * Loads the compact GO rail schedule + geometry extracted from the Metrolinx
 * GO GTFS feed (see scripts/build-go-gtfs.py → server/data/go-gtfs.json).
 *
 * Provides:
 *   - real route line geometry per direction (for the map's route layer)
 *   - the ordered stations per line
 *   - the full timetable as [short, dir, depSec, durSec, dayType] tuples,
 *     used to replay schedule-accurate train positions against wall-clock time.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface GoStation {
  name: string;
  lon: number;
  lat: number;
}

export interface GoRoute {
  short: string;
  name: string;
  color: string;
  /** Polyline per direction id ("0" = outbound from Union, "1" = inbound). */
  geometry: Record<string, [number, number][]>;
  stations: Record<string, GoStation[]>;
}

export type DayType = "weekday" | "sat" | "sun";

/** Compact trip row: [short, dir, depSec(seconds since midnight), durSec, dayType]. */
export type GoTrip = [string, number, number, number, DayType];

export interface GoGtfs {
  generatedFrom: string;
  feedVersion: string;
  routes: GoRoute[];
  trips: GoTrip[];
  tripCounts: Record<string, number>;
}

let cache: GoGtfs | null = null;

export function loadGoGtfs(): GoGtfs {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "..", "data", "go-gtfs.json");
  cache = JSON.parse(readFileSync(path, "utf8")) as GoGtfs;
  return cache;
}

export function goRoutes(): GoRoute[] {
  return loadGoGtfs().routes;
}
