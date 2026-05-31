/**
 * Shared server types. Kept framework-free so adapters and the AI layer can
 * import them without pulling in Hono.
 */

export type SourceStatus = "live" | "demo" | "error";

/** Every data adapter returns this envelope so the UI/AI can show provenance. */
export interface SourceResult<T> {
  source: string;
  status: SourceStatus;
  fetchedAt: string;
  /** Why we fell back to demo, or any caveat the agent should know. */
  note?: string;
  data: T;
  /** Optional attribution / dataset link for AI citations. */
  attribution?: string;
}

export interface GeoPoint {
  lon: number;
  lat: number;
}

/** A normalized, geolocated record any source can emit for the map + agent. */
export interface CivicRecord {
  id: string;
  category:
    | "mobility"
    | "construction"
    | "transit"
    | "bikeshare"
    | "safety"
    | "business"
    | "permit"
    | "event"
    | "environment"
    | "alert"
    | "parking"
    | "aviation";
  title: string;
  detail?: string;
  lon?: number;
  lat?: number;
  /** Distance in metres from a reference point, filled in when scoped. */
  distanceM?: number;
  /** Source-specific extra fields, kept for the agent. */
  meta?: Record<string, unknown>;
}

export interface BusinessProfile {
  id: string;
  name: string;
  businessType: string;
  address: string;
  lon: number;
  lat: number;
  ward?: string;
  neighbourhood?: string;
  headcount: number;
  /** Free-form notes the owner provides to tailor the agent. */
  notes?: string;

  // --- Demand-model inputs (CityFlow gradient-boosting staffing model) ---
  /** Opening hour, 0-23. */
  opensAt?: number;
  /** Closing hour, 0-23. */
  closesAt?: number;
  /** Radius (km) within which nearby events affect demand. */
  eventRadiusKm?: number;
  /** Customers a single worker can serve per hour (service rate). */
  customersPerWorkerHour?: number;
  /** Hourly wage in CAD. */
  hourlyWage?: number;
  /** Minimum staff on the floor whenever open. */
  minStaff?: number;
  /** Maximum staff per hour (optional cap). */
  maxStaffPerHour?: number;
  /** Allowed shift lengths in hours (e.g. [4, 6, 8]). */
  allowedShiftLengths?: number[];

  // --- Derived from the geocoded address (not user-entered) ---
  /** Qualitative transit access label: high | medium | low | minimal. */
  transitRelevance?: string;
  /** Nearby TTC/GO route names, nearest first. */
  nearbyRoutes?: string[];

  createdAt: string;
  updatedAt: string;
}
