/**
 * Green P parking — Toronto Parking Authority municipal car parks.
 *
 * Source: City of Toronto Open Data "green-p-parking" (JSON resource). Provides
 * 250+ municipal lots/garages with coordinates, capacity, type and rates. This
 * is location + capacity data (a supply signal), not live space-by-space
 * availability, so we badge it honestly in the note.
 */

import { cached, fetchJson, nowIso } from "../cache.ts";
import type { CivicRecord, SourceResult } from "../types.ts";

const GREEN_P_JSON =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/b66466c3-69c8-4825-9c8b-04b270069193/resource/8549d588-30b0-482e-b872-b21beefdda22/download/green-p-parking-2019.json";

interface GreenPCarpark {
  id?: string;
  address?: string;
  lat?: string;
  lng?: string;
  capacity?: string;
  carpark_type_str?: string;
  rate?: string;
  is_ttc?: boolean;
  is_under_construction?: boolean;
}

export async function loadParking(): Promise<SourceResult<CivicRecord[]>> {
  return cached(
    "parking:greenp",
    async () => {
      const payload = await fetchJson<{ carparks?: GreenPCarpark[] }>(GREEN_P_JSON, {
        timeoutMs: 9000,
      });
      const lots = payload.carparks ?? [];
      const records: CivicRecord[] = [];
      for (const lot of lots) {
        const lat = lot.lat ? Number(lot.lat) : NaN;
        const lon = lot.lng ? Number(lot.lng) : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const capacity = lot.capacity ? Number(lot.capacity) : undefined;
        records.push({
          id: `parking-${lot.id ?? `${lat},${lon}`}`,
          category: "parking",
          title: lot.address ?? "Green P parking",
          detail: [
            lot.carpark_type_str,
            capacity ? `${capacity} spaces` : null,
            lot.rate?.trim(),
          ]
            .filter(Boolean)
            .join(" · "),
          lon,
          lat,
          meta: {
            provider: "greenp",
            capacity,
            type: lot.carpark_type_str,
            rate: lot.rate?.trim(),
            ttc: lot.is_ttc,
            underConstruction: lot.is_under_construction,
          },
        });
      }
      if (records.length === 0) throw new Error("no carparks parsed");
      return {
        source: "parking",
        status: "live" as const,
        fetchedAt: nowIso(),
        note: "Locations & capacity (supply), not real-time space availability.",
        data: records,
        attribution: "City of Toronto Open Data — Green P Parking",
      };
    },
    6 * 60 * 60 * 1000, // locations change rarely
  );
}
