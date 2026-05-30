/**
 * Curated transit route geometry for Toronto — drawn as colored "line" shapes
 * on the map, Apple-Maps / TTC-map fashion.
 *
 * Hand-built GeoJSON (no external feed needed) covering:
 *   - TTC subway lines  (L1 Yonge-University, L2 Bloor-Danforth, L4 Sheppard)
 *   - Key TTC streetcars (501 Queen, 504 King, 510 Spadina)
 *   - GO Transit rail corridors (the 7 lines radiating from Union)
 *
 * Coordinates are simplified station/waypoint polylines — accurate enough to
 * read as the real network at city zoom, with official line colours.
 */

import type { SourceResult } from "../types.ts";
import { nowIso } from "../cache.ts";
import { goRoutes } from "./go-gtfs.ts";

export type TransitMode = "subway" | "streetcar" | "go";

export interface RouteProps {
  id: string;
  name: string;
  line: string;
  mode: TransitMode;
  color: string;
}

export interface RouteFeature {
  type: "Feature";
  properties: RouteProps;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

export interface RouteCollection {
  type: "FeatureCollection";
  features: RouteFeature[];
}

// Official TTC line colours.
const L1 = "#F8C300"; // Yonge-University — yellow
const L2 = "#00923F"; // Bloor-Danforth — green
const L4 = "#A21A68"; // Sheppard — purple/magenta
const STREETCAR = "#DA251D"; // TTC red

function feature(
  id: string,
  name: string,
  line: string,
  mode: TransitMode,
  color: string,
  coordinates: [number, number][],
): RouteFeature {
  return {
    type: "Feature",
    properties: { id, name, line, mode, color },
    geometry: { type: "LineString", coordinates },
  };
}

// ---- TTC subway ----------------------------------------------------------

// Line 1 — U-shape: Vaughan → down University/Spadina → Union → up Yonge → Finch.
const LINE1: [number, number][] = [
  [-79.5278, 43.7942], // Vaughan Metropolitan Centre
  [-79.4622, 43.7497], // Sheppard West
  [-79.4474, 43.7246], // Yorkdale
  [-79.4357, 43.6981], // Cedarvale (Eglinton West)
  [-79.4156, 43.684], // St Clair West
  [-79.4043, 43.6675], // Spadina
  [-79.3995, 43.668], // St George
  [-79.3946, 43.6595], // Museum
  [-79.3886, 43.6512], // Osgoode
  [-79.3806, 43.6452], // Union
  [-79.3786, 43.6486], // King
  [-79.3805, 43.6561], // Dundas
  [-79.3835, 43.6606], // College
  [-79.3857, 43.6709], // Bloor-Yonge
  [-79.3984, 43.7056], // Eglinton
  [-79.4109, 43.7615], // Sheppard-Yonge
  [-79.4148, 43.7805], // Finch
];

// Line 2 — Bloor-Danforth: Kipling → Kennedy.
const LINE2: [number, number][] = [
  [-79.5357, 43.6377], // Kipling
  [-79.4839, 43.65], // Jane
  [-79.4595, 43.6557], // Keele
  [-79.453, 43.6571], // Dundas West
  [-79.4043, 43.6675], // Spadina
  [-79.3995, 43.668], // St George
  [-79.3857, 43.6709], // Bloor-Yonge
  [-79.3585, 43.6767], // Broadview
  [-79.345, 43.6797], // Pape
  [-79.3017, 43.689], // Main Street
  [-79.2636, 43.7323], // Kennedy
];

// Line 4 — Sheppard: Sheppard-Yonge → Don Mills.
const LINE4: [number, number][] = [
  [-79.4109, 43.7615], // Sheppard-Yonge
  [-79.3866, 43.7672], // Bayview
  [-79.3766, 43.769], // Bessarion
  [-79.3656, 43.7714], // Leslie
  [-79.3464, 43.7757], // Don Mills
];

// ---- TTC streetcars (downtown spine) -------------------------------------

const QUEEN_501: [number, number][] = [
  [-79.4486, 43.6391], // Roncesvalles
  [-79.42, 43.6465], // Queen & Bathurst
  [-79.3886, 43.6512], // Queen & Yonge
  [-79.3585, 43.6585], // Queen & Broadview
  [-79.3247, 43.6664], // Leslie
  [-79.2986, 43.6709], // Coxwell
];

const KING_504: [number, number][] = [
  [-79.4203, 43.6398], // Dundas West / Roncesvalles
  [-79.4012, 43.6438], // Bathurst
  [-79.3886, 43.6471], // King & Spadina
  [-79.3786, 43.6486], // King & Yonge
  [-79.3585, 43.6552], // Broadview
  [-79.3499, 43.6595], // Distillery / Sumach
];

const SPADINA_510: [number, number][] = [
  [-79.4043, 43.6675], // Spadina Station (Bloor)
  [-79.4019, 43.6571], // College
  [-79.3964, 43.6486], // Spadina & King
  [-79.3859, 43.6388], // Queens Quay (Spadina loop)
];

// ---- GO Transit rail corridors (real geometry from GO GTFS shapes) -------

/**
 * Build a route line per GO line from the GTFS-derived geometry. Uses the
 * outbound ("0", Union → terminus) shape, falling back to inbound if absent.
 */
function goFeatures(): RouteFeature[] {
  return goRoutes()
    .map((r) => {
      const coords = r.geometry["0"] ?? r.geometry["1"];
      if (!coords || coords.length < 2) return null;
      return feature(`go-${r.short.toLowerCase()}`, `GO ${r.name}`, r.name, "go", r.color, coords);
    })
    .filter((f): f is RouteFeature => f !== null);
}

function buildFeatures(): RouteFeature[] {
  return [
    // GO first so subway/streetcar draw on top.
    ...goFeatures(),
    feature("ttc-501", "501 Queen", "501", "streetcar", STREETCAR, QUEEN_501),
    feature("ttc-504", "504 King", "504", "streetcar", STREETCAR, KING_504),
    feature("ttc-510", "510 Spadina", "510", "streetcar", STREETCAR, SPADINA_510),
    feature("ttc-l1", "Line 1 Yonge-University", "1", "subway", L1, LINE1),
    feature("ttc-l2", "Line 2 Bloor-Danforth", "2", "subway", L2, LINE2),
    feature("ttc-l4", "Line 4 Sheppard", "4", "subway", L4, LINE4),
  ];
}

let featureCache: RouteFeature[] | null = null;

export function getTransitRoutes(): RouteCollection {
  if (!featureCache) featureCache = buildFeatures();
  return { type: "FeatureCollection", features: featureCache };
}

export function loadTransitRoutes(): SourceResult<RouteCollection> {
  return {
    source: "transit-routes",
    status: "live",
    fetchedAt: nowIso(),
    data: getTransitRoutes(),
    attribution: "TTC subway/streetcar (curated) + GO Transit corridors (GO GTFS shapes)",
  };
}
