import { cached, fetchJson } from "./cache.ts";
import type { GeoPoint } from "./types.ts";

const TORONTO_BBOX = { minLon: -79.66, minLat: 43.56, maxLon: -79.1, maxLat: 43.88 };

export function inToronto(p: GeoPoint): boolean {
  return (
    p.lon >= TORONTO_BBOX.minLon &&
    p.lon <= TORONTO_BBOX.maxLon &&
    p.lat >= TORONTO_BBOX.minLat &&
    p.lat <= TORONTO_BBOX.maxLat
  );
}

/** Haversine distance in metres. */
export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: { suburb?: string; neighbourhood?: string; city_district?: string };
}

export interface GeocodeResult extends GeoPoint {
  displayName: string;
  neighbourhood?: string;
}

/**
 * Geocode a Toronto address using OpenStreetMap Nominatim (free, no key).
 * Biased + bounded to Toronto. Cached for a day.
 */
export async function geocode(address: string): Promise<GeocodeResult | null> {
  const q = encodeURIComponent(`${address}, Toronto, Ontario, Canada`);
  const url =
    `https://nominatim.openstreetmap.org/search?q=${q}` +
    `&format=json&addressdetails=1&limit=1&countrycodes=ca` +
    `&viewbox=${TORONTO_BBOX.minLon},${TORONTO_BBOX.maxLat},${TORONTO_BBOX.maxLon},${TORONTO_BBOX.minLat}&bounded=1`;

  return cached(
    `geocode:${address.toLowerCase().trim()}`,
    async () => {
      const results = await fetchJson<NominatimResult[]>(url, { timeoutMs: 8000 });
      const r = results[0];
      if (!r) return null;
      const point: GeocodeResult = {
        lat: Number(r.lat),
        lon: Number(r.lon),
        displayName: r.display_name,
        neighbourhood:
          r.address?.neighbourhood ??
          r.address?.suburb ??
          r.address?.city_district,
      };
      return inToronto(point) ? point : null;
    },
    24 * 60 * 60 * 1000,
  );
}
