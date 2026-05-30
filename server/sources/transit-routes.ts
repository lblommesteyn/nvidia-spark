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
const GO = "#0F7A3D"; // GO Transit green (rendered dashed to distinguish)

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

// ---- GO Transit rail corridors (from Union) ------------------------------

const GO_LAKESHORE_WEST: [number, number][] = [
  [-79.3806, 43.6452], // Union
  [-79.4163, 43.6343], // Exhibition
  [-79.4977, 43.6157], // Mimico
  [-79.5435, 43.5926], // Long Branch
  [-79.586, 43.5547], // Port Credit
  [-79.631, 43.5183], // Clarkson
  [-79.6833, 43.4561], // Oakville
];

const GO_LAKESHORE_EAST: [number, number][] = [
  [-79.3806, 43.6452], // Union
  [-79.2879, 43.6864], // Danforth
  [-79.2614, 43.7148], // Eglinton
  [-79.1956, 43.7551], // Guildwood
  [-79.0857, 43.8336], // Pickering
  [-79.0265, 43.852], // Ajax
  [-78.8658, 43.892], // Oshawa
];

const GO_KITCHENER: [number, number][] = [
  [-79.3806, 43.6452], // Union
  [-79.4636, 43.6618], // Bloor GO
  [-79.517, 43.7], // Weston
  [-79.5605, 43.7095], // Etobicoke North
  [-79.628, 43.7065], // Malton
  [-79.762, 43.6915], // Brampton
  [-79.92, 43.652], // Georgetown
];

const GO_MILTON: [number, number][] = [
  [-79.3806, 43.6452], // Union
  [-79.536, 43.6365], // Kipling
  [-79.578, 43.619], // Dixie
  [-79.621, 43.579], // Cooksville
  [-79.71, 43.555], // Streetsville
  [-79.883, 43.523], // Milton
];

const GO_BARRIE: [number, number][] = [
  [-79.3806, 43.6452], // Union
  [-79.4663, 43.6817], // Caledonia
  [-79.4781, 43.753], // Downsview Park
  [-79.516, 43.8419], // Rutherford
  [-79.4596, 43.9966], // Aurora
  [-79.6903, 44.389], // Barrie South
];

const GO_RICHMOND_HILL: [number, number][] = [
  [-79.3806, 43.6452], // Union
  [-79.3779, 43.777], // Oriole
  [-79.4079, 43.83], // Langstaff
  [-79.425, 43.877], // Richmond Hill
];

const GO_STOUFFVILLE: [number, number][] = [
  [-79.3806, 43.6452], // Union
  [-79.2636, 43.7323], // Kennedy
  [-79.2862, 43.7858], // Agincourt
  [-79.311, 43.853], // Unionville
  [-79.2643, 43.9035], // Markham
  [-79.244, 43.971], // Stouffville
];

/** The GO corridors, exposed for the (mock) live train generator. */
export const GO_LINES: { id: string; name: string; coordinates: [number, number][] }[] = [
  { id: "go-lw", name: "Lakeshore West", coordinates: GO_LAKESHORE_WEST },
  { id: "go-le", name: "Lakeshore East", coordinates: GO_LAKESHORE_EAST },
  { id: "go-kit", name: "Kitchener", coordinates: GO_KITCHENER },
  { id: "go-mil", name: "Milton", coordinates: GO_MILTON },
  { id: "go-bar", name: "Barrie", coordinates: GO_BARRIE },
  { id: "go-rh", name: "Richmond Hill", coordinates: GO_RICHMOND_HILL },
  { id: "go-stf", name: "Stouffville", coordinates: GO_STOUFFVILLE },
];

const FEATURES: RouteFeature[] = [
  // GO first so subway/streetcar draw on top.
  ...GO_LINES.map((l) => feature(l.id, `GO ${l.name}`, l.name, "go", GO, l.coordinates)),
  feature("ttc-501", "501 Queen", "501", "streetcar", STREETCAR, QUEEN_501),
  feature("ttc-504", "504 King", "504", "streetcar", STREETCAR, KING_504),
  feature("ttc-510", "510 Spadina", "510", "streetcar", STREETCAR, SPADINA_510),
  feature("ttc-l1", "Line 1 Yonge-University", "1", "subway", L1, LINE1),
  feature("ttc-l2", "Line 2 Bloor-Danforth", "2", "subway", L2, LINE2),
  feature("ttc-l4", "Line 4 Sheppard", "4", "subway", L4, LINE4),
];

export function getTransitRoutes(): RouteCollection {
  return { type: "FeatureCollection", features: FEATURES };
}

export function loadTransitRoutes(): SourceResult<RouteCollection> {
  return {
    source: "transit-routes",
    status: "live",
    fetchedAt: nowIso(),
    data: getTransitRoutes(),
    attribution: "Curated TTC subway/streetcar + GO Transit corridor geometry",
  };
}
