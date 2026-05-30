/** Toronto City Hall — default map center. */
export const TORONTO_CENTER = { lon: -79.3839, lat: 43.6535 };

/**
 * City of Toronto bounding box (with a little padding) used to lock the map
 * so users can't pan/zoom out of the city.
 * Format: [[west, south], [east, north]]
 */
export const TORONTO_BOUNDS: [[number, number], [number, number]] = [
  [-79.66, 43.56],
  [-79.1, 43.88],
];

export type DataStatus = "live" | "demo" | "loading" | "error";

export interface PanelData<T> {
  status: DataStatus;
  data: T;
  /** ISO timestamp of when the data was fetched. */
  fetchedAt: string;
  /** Human-readable note (e.g. why we fell back to demo data). */
  note?: string;
}

/** A geolocated point that can be plotted on the map. */
export interface MapPoint {
  id: string;
  lon: number;
  lat: number;
  label: string;
  category: "mobility" | "construction" | "transit" | "bikeshare" | "safety" | "business" | "permit" | "event" | "environment";
  detail?: string;
}

export interface WeatherNow {
  temperatureC: number;
  feelsLikeC: number;
  windKph: number;
  humidity: number;
  description: string;
  isDay: boolean;
}

export interface AirQualityNow {
  usAqi: number;
  pm25: number;
  pm10: number;
  category: string;
}

export interface TransitAlert {
  id: string;
  route: string;
  title: string;
  severity: "info" | "minor" | "major";
}

export interface TrafficIncident {
  id: string;
  name: string;
  detail: string;
  lon: number;
  lat: number;
}

export interface ServiceRequest311 {
  id: string;
  type: string;
  ward: string;
  lon: number;
  lat: number;
}

export interface CityEvent {
  id: string;
  name: string;
  venue: string;
  date: string;
  category: string;
}
