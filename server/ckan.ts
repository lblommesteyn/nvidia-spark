import { cached, fetchJson } from "./cache.ts";

/**
 * Client for the City of Toronto Open Data portal (CKAN).
 * Docs: https://open.toronto.ca/ → each dataset's "Developers" tab.
 */
const BASE = "https://ckan0.cf.opendata.inter.prod-toronto.ca";

export interface CkanResource {
  id: string;
  name: string;
  format: string;
  datastore_active: boolean;
}

interface PackageShowResponse {
  success: boolean;
  result: { resources: CkanResource[] };
}

interface DatastoreSearchResponse {
  success: boolean;
  result: {
    records: Record<string, unknown>[];
    total: number;
    fields: { id: string; type: string }[];
  };
}

/** Resolve a dataset slug to its resources (cached 6h — resources rarely change). */
export async function packageShow(slug: string): Promise<CkanResource[]> {
  return cached(
    `ckan:pkg:${slug}`,
    async () => {
      const res = await fetchJson<PackageShowResponse>(
        `${BASE}/api/3/action/package_show?id=${encodeURIComponent(slug)}`,
        { timeoutMs: 12_000 },
      );
      if (!res.success) throw new Error(`package_show failed for ${slug}`);
      return res.result.resources;
    },
    6 * 60 * 60 * 1000,
  );
}

/** First query-able (datastore_active) resource for a dataset, if any. */
export async function activeResourceId(slug: string): Promise<string | null> {
  const resources = await packageShow(slug);
  const active = resources.find((r) => r.datastore_active);
  return active?.id ?? null;
}

export interface DatastoreQuery {
  limit?: number;
  /** Full-text search across the resource. */
  q?: string;
  /** Field equality filters. */
  filters?: Record<string, string>;
}

/** Query rows from a datastore resource. */
export async function datastoreSearch(
  resourceId: string,
  query: DatastoreQuery = {},
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    resource_id: resourceId,
    limit: String(query.limit ?? 100),
  });
  if (query.q) params.set("q", query.q);
  if (query.filters) params.set("filters", JSON.stringify(query.filters));

  const key = `ckan:ds:${resourceId}:${params.toString()}`;
  return cached(
    key,
    async () => {
      const res = await fetchJson<DatastoreSearchResponse>(
        `${BASE}/api/3/action/datastore_search?${params.toString()}`,
        { timeoutMs: 12_000 },
      );
      if (!res.success) throw new Error(`datastore_search failed`);
      return res.result.records;
    },
    10 * 60 * 1000,
  );
}

/** Convenience: resolve slug → active resource → rows in one call. */
export async function queryDataset(
  slug: string,
  query: DatastoreQuery = {},
): Promise<Record<string, unknown>[]> {
  const resourceId = await activeResourceId(slug);
  if (!resourceId) throw new Error(`No datastore-active resource for ${slug}`);
  return datastoreSearch(resourceId, query);
}

/**
 * Best-effort extraction of a lat/lon from an arbitrary CKAN row.
 * Toronto datasets use many conventions (geometry GeoJSON, lat/long columns, etc.).
 */
export function extractLatLon(
  row: Record<string, unknown>,
): { lat: number; lon: number } | null {
  // Direct columns (various casings).
  const latKeys = ["latitude", "lat", "LATITUDE", "LAT", "Latitude", "y", "Y"];
  const lonKeys = [
    "longitude",
    "lon",
    "lng",
    "long",
    "LONGITUDE",
    "LON",
    "Longitude",
    "x",
    "X",
  ];
  const num = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : (v as number);
    return Number.isFinite(n) ? n : null;
  };
  let lat: number | null = null;
  let lon: number | null = null;
  for (const k of latKeys) if (k in row) { lat = num(row[k]); if (lat !== null) break; }
  for (const k of lonKeys) if (k in row) { lon = num(row[k]); if (lon !== null) break; }
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    // Some datasets store projected coords in x/y — sanity check it's lat/lon-ish.
    if (Math.abs(lat) > 1 && Math.abs(lon) > 1) return { lat, lon };
  }

  // GeoJSON geometry blob.
  const geo = row.geometry ?? row.geom ?? row.Geometry;
  if (typeof geo === "string") {
    try {
      const parsed = JSON.parse(geo) as { coordinates?: number[] };
      if (parsed.coordinates && parsed.coordinates.length >= 2) {
        return { lon: parsed.coordinates[0], lat: parsed.coordinates[1] };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}
