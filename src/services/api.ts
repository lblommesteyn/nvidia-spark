/** Typed client for the Toronto Monitor backend (proxied through Vite at /api). */

export interface Business {
  id: string;
  name: string;
  businessType: string;
  address: string;
  lon: number;
  lat: number;
  ward?: string;
  neighbourhood?: string;
  headcount: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CivicRecord {
  id: string;
  category: "mobility" | "construction" | "transit" | "bikeshare" | "safety" | "business" | "permit" | "event" | "environment" | "alert" | "parking" | "aviation";
  title: string;
  detail?: string;
  lon?: number;
  lat?: number;
  distanceM?: number;
}

export interface CivicGroup {
  source: string;
  label: string;
  category: CivicRecord["category"];
  status: "live" | "demo" | "error";
  attribution?: string;
  fetchedAt: string;
  note?: string;
  nearby: CivicRecord[];
  totalConsidered: number;
  areaWide: boolean;
}

export interface SourceResult<T> {
  source: string;
  status: "live" | "demo" | "error";
  fetchedAt: string;
  note?: string;
  data: T;
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

export interface LocationContext {
  scope: { point: { lon: number; lat: number }; radiusM: number; businessType?: string; name?: string };
  generatedAt: string;
  weather: SourceResult<WeatherNow>;
  airQuality: SourceResult<AirQualityNow>;
  civic: CivicGroup[];
  highlights: string[];
}

export interface AgentAnswer {
  text: string;
  provider: string;
  model: string;
  contextUsed: { name?: string; businessType?: string; radiusM: number; highlights: string[] };
}

export type DemandLevel = "low" | "moderate" | "elevated" | "surge";

export interface ForecastDriver {
  signal: string;
  impact: "up" | "down";
  detail: string;
}

export interface ForecastWindow {
  label: string;
  level: DemandLevel;
  note: string;
}

export interface DemandForecast {
  generatedAt: string;
  provider: string;
  model: string;
  method: "heuristic" | "llm";
  horizonHours: number;
  level: DemandLevel;
  score: number;
  headline: string;
  drivers: ForecastDriver[];
  windows: ForecastWindow[];
  actions: string[];
  reasoning?: string;
  contextUsed: { name?: string; businessType?: string; radiusM: number; highlights: string[] };
}

export interface ForecastDay {
  date: string;
  dayName: string;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  peakScore: number;
  peakLevel: DemandLevel;
  peakWindow: string;
  avgScore: number;
  avgLevel: DemandLevel;
  highTempC?: number;
  lowTempC?: number;
  weather?: string;
  events: number;
  drivers: ForecastDriver[];
  note: string;
}

export interface WeeklyForecast {
  generatedAt: string;
  provider: string;
  model: string;
  method: "heuristic";
  horizonHours: number;
  headline: string;
  days: ForecastDay[];
  weatherStatus: "live" | "demo" | "error";
  basis: string;
  contextUsed: {
    name?: string;
    businessType?: string;
    radiusM: number;
    structural: { construction: number; transit: number };
  };
}

export interface LiveChannelSummary {
  id: string;
  name: string;
  description: string;
}

export interface LiveResolution {
  channel: { id: string; name: string; handle: string; description: string };
  videoId: string | null;
  embedUrl: string | null;
  status: "live" | "demo" | "error";
  fetchedAt: string;
  note?: string;
}

export interface GeoFeatureCollection {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: {
      id: string;
      category: CivicRecord["category"];
      title: string;
      detail: string;
      severity: string | null;
      pressure: string | null;
      route: string | null;
    };
  }[];
}

export interface FlowComponent {
  construction: number;
  bikeDemand: number;
  transit: number;
  issues: number;
  development: number;
  events: number;
}

export interface FlowFeatureProps {
  id: string;
  name: string;
  score: number;
  level: "low" | "moderate" | "high" | "intense";
  breakdown: FlowComponent;
  topSignal: string;
}

export interface FlowCollection {
  type: "FeatureCollection";
  generatedAt: string;
  features: {
    type: "Feature";
    properties: FlowFeatureProps;
    geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
  }[];
}

export type Congestion = "free" | "moderate" | "heavy" | "severe";

export interface TrafficCollection {
  type: "FeatureCollection";
  status: "live" | "demo";
  fetchedAt: string;
  note?: string;
  attribution: string;
  features: {
    type: "Feature";
    geometry: { type: "LineString"; coordinates: [number, number][] };
    properties: {
      road: string;
      congestion: Congestion;
      speed: number;
      freeFlow: number;
      ratio: number;
      color: string;
    };
  }[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then(json<{ ok: boolean; provider: string }>),

  listBusinesses: () => fetch("/api/businesses").then(json<Business[]>),

  createBusiness: (input: {
    name: string;
    businessType: string;
    address: string;
    headcount: number;
    notes?: string;
  }) =>
    fetch("/api/businesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(json<Business>),

  deleteBusiness: (id: string) =>
    fetch(`/api/businesses/${id}`, { method: "DELETE" }).then(json<{ deleted: boolean }>),

  context: (params: { businessId?: string; lon?: number; lat?: number; radius?: number }) => {
    const q = new URLSearchParams();
    if (params.businessId) q.set("businessId", params.businessId);
    if (params.lon != null) q.set("lon", String(params.lon));
    if (params.lat != null) q.set("lat", String(params.lat));
    if (params.radius != null) q.set("radius", String(params.radius));
    return fetch(`/api/context?${q.toString()}`).then(json<LocationContext>);
  },

  forecast: (params: { businessId?: string; lon?: number; lat?: number; radius?: number; type?: string }) => {
    const q = new URLSearchParams();
    if (params.businessId) q.set("businessId", params.businessId);
    if (params.lon != null) q.set("lon", String(params.lon));
    if (params.lat != null) q.set("lat", String(params.lat));
    if (params.radius != null) q.set("radius", String(params.radius));
    if (params.type) q.set("type", params.type);
    return fetch(`/api/forecast?${q.toString()}`).then(json<DemandForecast>);
  },

  forecastWeek: (params: { businessId?: string; lon?: number; lat?: number; radius?: number; type?: string }) => {
    const q = new URLSearchParams();
    if (params.businessId) q.set("businessId", params.businessId);
    if (params.lon != null) q.set("lon", String(params.lon));
    if (params.lat != null) q.set("lat", String(params.lat));
    if (params.radius != null) q.set("radius", String(params.radius));
    if (params.type) q.set("type", params.type);
    return fetch(`/api/forecast/week?${q.toString()}`).then(json<WeeklyForecast>);
  },

  mapRecords: () =>
    fetch("/api/data/map").then(json<{ count: number; records: CivicRecord[] }>),

  liveChannels: () => fetch("/api/livetv").then(json<LiveChannelSummary[]>),

  liveChannel: (id: string) => fetch(`/api/livetv/${id}`).then(json<LiveResolution>),

  mapGeo: () => fetch("/api/map/geo").then(json<GeoFeatureCollection>),

  flow: () => fetch("/api/flow").then(json<FlowCollection>),

  traffic: () => fetch("/api/traffic").then(json<TrafficCollection>),

  agent: (body: { question: string; businessId?: string; lon?: number; lat?: number; radiusM?: number }) =>
    fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<AgentAnswer>),
};
