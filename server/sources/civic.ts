import { extractLatLon, queryDataset } from "../ckan.ts";
import { nowIso } from "../cache.ts";
import { loadRoadRestrictions } from "./road-live.ts";
import { loadBikeShare } from "./bikeshare.ts";
import { loadTtc } from "./ttc.ts";
import { loadTtcAlerts } from "./ttc-alerts.ts";
import { loadParking } from "./parking.ts";
import { loadFlights } from "./flights.ts";
import { loadEvents } from "./events/index.ts";
import type { CivicRecord, SourceResult } from "../types.ts";

/** Pick the first present, non-empty string field from a row. */
function pick(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

export interface CivicSourceDef {
  key: string;
  label: string;
  category: CivicRecord["category"];
  attribution: string;
  /** City of Toronto Open Data dataset slug (package id) — for CKAN sources. */
  slug?: string;
  limit?: number;
  /** Map a raw CKAN row to a normalized record (return null to skip). */
  map?: (row: Record<string, unknown>, i: number) => CivicRecord | null;
  /** Shown when the live feed is unreachable or empty. */
  demo?: CivicRecord[];
  /**
   * Custom loader for non-CKAN sources (live feeds, GBFS, GTFS-RT, …).
   * When present, this fully overrides the CKAN path.
   */
  load?: () => Promise<SourceResult<CivicRecord[]>>;
}

export const CIVIC_SOURCES: CivicSourceDef[] = [
  {
    key: "road-restrictions",
    label: "Road Restrictions & Construction",
    category: "construction",
    attribution: "City of Toronto — Road Restrictions (real-time)",
    load: loadRoadRestrictions,
    demo: [
      { id: "road-d1", category: "construction", title: "Gardiner Expwy EB", detail: "Lane reduction near Jarvis", lon: -79.366, lat: 43.642 },
      { id: "road-d2", category: "construction", title: "Bloor St W", detail: "Watermain work, single lane", lon: -79.41, lat: 43.667 },
    ],
  },
  {
    key: "bike-share",
    label: "Bike Share (Supply/Demand)",
    category: "bikeshare",
    attribution: "Bike Share Toronto (GBFS)",
    load: loadBikeShare,
    demo: [
      { id: "bike-d1", category: "bikeshare", title: "Fort York / Capreol", detail: "12 bikes · 33 docks · balanced", lon: -79.395954, lat: 43.639832 },
    ],
  },
  {
    key: "ttc-vehicles",
    label: "TTC Live Vehicles",
    category: "transit",
    attribution: "Toronto Transit Commission via Umo IQ",
    load: loadTtc,
    demo: [
      { id: "ttc-d1", category: "transit", title: "Route 504", detail: "King streetcar", lon: -79.4, lat: 43.645 },
    ],
  },
  {
    key: "311-requests",
    label: "311 Service Requests",
    category: "safety",
    slug: "311-service-requests-customer-initiated",
    limit: 200,
    attribution: "City of Toronto Open Data — 311 Service Requests",
    map: (row, i) => {
      const ll = extractLatLon(row);
      return {
        id: `311-${pick(row, ["id", "_id", "Service Request ID"]) ?? i}`,
        category: "safety",
        title: pick(row, ["Service Request Type", "type", "Type", "Division"]) ?? "311 request",
        detail: pick(row, ["Status", "status", "Ward", "ward", "First 3 Chars of Postal Code"]),
        lon: ll?.lon,
        lat: ll?.lat,
        meta: row,
      };
    },
    demo: [
      { id: "311-d1", category: "safety", title: "Pothole", detail: "Spadina–Fort York", lon: -79.4, lat: 43.64 },
      { id: "311-d2", category: "safety", title: "Graffiti", detail: "Toronto Centre", lon: -79.375, lat: 43.66 },
      { id: "311-d3", category: "safety", title: "Noise complaint", detail: "University–Rosedale", lon: -79.39, lat: 43.67 },
    ],
  },
  {
    key: "business-licences",
    label: "Business Licences",
    category: "business",
    slug: "municipal-licensing-and-standards-business-licences-and-permits",
    limit: 300,
    attribution: "City of Toronto Open Data — Business Licences & Permits",
    map: (row, i) => {
      const ll = extractLatLon(row);
      return {
        id: `lic-${pick(row, ["Licence No.", "_id"]) ?? i}`,
        category: "business",
        title: pick(row, ["Operating Name", "Client Name"]) ?? "Business licence",
        detail: [pick(row, ["Category"]), pick(row, ["Licence Address Line 1"])]
          .filter(Boolean)
          .join(" · "),
        lon: ll?.lon,
        lat: ll?.lat,
        meta: { ward: row.Ward, category: row.Category, issued: row.Issued },
      };
    },
    demo: [
      { id: "lic-d1", category: "business", title: "Sample Cafe Co.", detail: "Eating Establishment", lon: -79.395, lat: 43.658 },
      { id: "lic-d2", category: "business", title: "Queen St Retail", detail: "Retail Store", lon: -79.42, lat: 43.647 },
    ],
  },
  {
    key: "building-permits",
    label: "Building Permits (Active)",
    category: "permit",
    slug: "building-permits-active-permits",
    limit: 200,
    attribution: "City of Toronto Open Data — Active Building Permits",
    map: (row, i) => {
      const ll = extractLatLon(row);
      const num = pick(row, ["STREET_NUM"]);
      const street = pick(row, ["STREET_NAME"]);
      const stype = pick(row, ["STREET_TYPE"]);
      const address = [num, street, stype].filter(Boolean).join(" ");
      return {
        id: `permit-${pick(row, ["PERMIT_NUM", "_id"]) ?? i}`,
        category: "permit",
        title: address || "Building permit",
        detail:
          pick(row, ["DESCRIPTION", "WORK"]) ??
          [pick(row, ["PERMIT_TYPE"]), pick(row, ["STATUS"])].filter(Boolean).join(" · "),
        lon: ll?.lon,
        lat: ll?.lat,
        meta: { ward: row.WARD_GRID, status: row.STATUS, work: row.WORK, cost: row.EST_CONST_COST },
      };
    },
    demo: [
      { id: "permit-d1", category: "permit", title: "123 Adelaide St W", detail: "Interior alterations — restaurant", lon: -79.387, lat: 43.648 },
      { id: "permit-d2", category: "permit", title: "456 Yonge St", detail: "New mixed-use building", lon: -79.383, lat: 43.661 },
    ],
  },
  {
    key: "events",
    label: "Concerts, Games & Events",
    category: "event",
    attribution: "ESPN · Ticketmaster · PredictHQ",
    load: loadEvents,
    demo: [
      { id: "event-d1", category: "event", title: "Blue Jays vs. Yankees", detail: "MLB · Rogers Centre", lon: -79.3894, lat: 43.6414 },
      { id: "event-d2", category: "event", title: "Concert — Budweiser Stage", detail: "Live music", lon: -79.4155, lat: 43.6285 },
    ],
  },
  {
    key: "ttc-alerts",
    label: "TTC Service Alerts",
    category: "alert",
    attribution: "Toronto Transit Commission — Service Alerts",
    load: loadTtcAlerts,
    demo: [
      { id: "ttc-alert-d1", category: "alert", title: "Line 1 — Reduced service", detail: "Signal upgrade between St George and Eglinton" },
    ],
  },
  {
    key: "parking",
    label: "Green P Parking",
    category: "parking",
    attribution: "City of Toronto Open Data — Green P Parking",
    load: loadParking,
    demo: [
      { id: "parking-d1", category: "parking", title: "20 Charles St E", detail: "Garage · 641 spaces", lon: -79.3853, lat: 43.6693 },
    ],
  },
  {
    key: "flights",
    label: "Flight Arrivals (YYZ)",
    category: "aviation",
    attribution: "aviationstack / OpenSky",
    load: loadFlights,
    demo: [
      { id: "flight-d1", category: "aviation", title: "YYZ arrivals", detail: "Toronto Pearson — visitor inflow", lon: -79.6306, lat: 43.6777 },
    ],
  },
  {
    key: "film-permits",
    label: "Film & Road-Occupancy Permits",
    category: "permit",
    attribution: "City of Toronto — Film & Special Events Office",
    // No live open-data API exists for these in Toronto yet; representative
    // sample, badged DEMO so the agent/UI is honest about it.
    load: async () => ({
      source: "film-permits",
      status: "demo" as const,
      fetchedAt: nowIso(),
      note: "No live City of Toronto API for film/road-occupancy permits yet; representative sample.",
      data: [
        { id: "film-d1", category: "permit" as const, title: "Film shoot — King St E", detail: "Lane occupancy · trucks staging", lon: -79.368, lat: 43.6505 },
        { id: "film-d2", category: "permit" as const, title: "Road occupancy — Queen St W", detail: "Patio build · curb lane closed", lon: -79.42, lat: 43.6465 },
        { id: "film-d3", category: "permit" as const, title: "Special event setup — Distillery", detail: "Pedestrian zone · staging", lon: -79.3596, lat: 43.6503 },
      ],
      attribution: "City of Toronto — Film & Special Events Office",
    }),
    demo: [],
  },
];

export async function loadCivicSource(
  def: CivicSourceDef,
): Promise<SourceResult<CivicRecord[]>> {
  // Non-CKAN live sources provide their own loader.
  if (def.load) {
    try {
      return await def.load();
    } catch (err) {
      return {
        source: def.key,
        status: "error",
        fetchedAt: nowIso(),
        note: err instanceof Error ? err.message : "load error",
        data: def.demo ?? [],
        attribution: def.attribution,
      };
    }
  }
  try {
    const rows = await queryDataset(def.slug!, { limit: def.limit ?? 200 });
    const records = rows
      .map((r, i) => def.map!(r, i))
      .filter((r): r is CivicRecord => r !== null);
    if (records.length === 0) throw new Error("no records mapped");
    return {
      source: def.key,
      status: "live",
      fetchedAt: nowIso(),
      data: records,
      attribution: def.attribution,
    };
  } catch (err) {
    return {
      source: def.key,
      status: "demo",
      fetchedAt: nowIso(),
      note: `Live dataset unavailable (${err instanceof Error ? err.message : "error"}); showing demo data.`,
      data: def.demo ?? [],
      attribution: def.attribution,
    };
  }
}

export function getCivicSource(key: string): CivicSourceDef | undefined {
  return CIVIC_SOURCES.find((s) => s.key === key);
}
