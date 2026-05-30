/**
 * Toronto venue coordinate map.
 *
 * Most event/sports feeds (notably ESPN's hidden schedule API) return a venue
 * name + city but NOT lat/lon. To place games and concerts on the map we map
 * the major Toronto venues to known coordinates. Matching is done by loose
 * substring on a normalized name so "Rogers Centre", "rogers centre" and
 * "Rogers Centre, Toronto" all resolve.
 */

import type { GeoPoint } from "../../types.ts";

export interface Venue {
  name: string;
  lon: number;
  lat: number;
  /** Lowercased aliases/substrings that should resolve to this venue. */
  match: string[];
}

export const TORONTO_VENUES: Venue[] = [
  { name: "Rogers Centre", lon: -79.3894, lat: 43.6414, match: ["rogers centre", "rogers center", "skydome"] },
  { name: "Scotiabank Arena", lon: -79.3791, lat: 43.6435, match: ["scotiabank arena", "air canada centre", "scotiabank"] },
  { name: "BMO Field", lon: -79.4185, lat: 43.6332, match: ["bmo field"] },
  { name: "Budweiser Stage", lon: -79.4155, lat: 43.6285, match: ["budweiser stage", "molson amphitheatre"] },
  { name: "Coca-Cola Coliseum", lon: -79.4156, lat: 43.6349, match: ["coca-cola coliseum", "ricoh coliseum", "coliseum"] },
  { name: "Sankofa Square", lon: -79.3807, lat: 43.6555, match: ["sankofa square", "yonge-dundas", "dundas square"] },
  { name: "Roy Thomson Hall", lon: -79.3866, lat: 43.6466, match: ["roy thomson hall"] },
  { name: "Massey Hall", lon: -79.3784, lat: 43.6544, match: ["massey hall"] },
  { name: "Meridian Hall", lon: -79.3760, lat: 43.6469, match: ["meridian hall", "sony centre", "o'keefe centre"] },
  { name: "History", lon: -79.3306, lat: 43.6655, match: ["history"] },
  { name: "Danforth Music Hall", lon: -79.3520, lat: 43.6762, match: ["danforth music hall"] },
  { name: "Exhibition Place", lon: -79.4156, lat: 43.6324, match: ["exhibition place", "the ex", "cne"] },
  { name: "Nathan Phillips Square", lon: -79.3839, lat: 43.6525, match: ["nathan phillips square", "city hall"] },
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Resolve a venue name (and optional city) to coordinates, or null. */
export function venueCoords(
  venueName?: string | null,
  city?: string | null,
): GeoPoint | null {
  if (!venueName) return null;
  const n = normalize(venueName);
  for (const v of TORONTO_VENUES) {
    if (v.match.some((m) => n.includes(m))) {
      return { lon: v.lon, lat: v.lat };
    }
  }
  return null;
}
