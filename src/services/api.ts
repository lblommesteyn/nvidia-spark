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
  // Demand-model inputs
  opensAt?: number;
  closesAt?: number;
  eventRadiusKm?: number;
  customersPerWorkerHour?: number;
  hourlyWage?: number;
  minStaff?: number;
  maxStaffPerHour?: number;
  allowedShiftLengths?: number[];
  // Derived from address
  transitRelevance?: string;
  nearbyRoutes?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TransitNearby {
  lon: number;
  lat: number;
  address?: string;
  relevance: "high" | "medium" | "low" | "minimal";
  score: number;
  nearestM: number | null;
  routes: { id: string; name: string; mode: "subway" | "streetcar" | "go"; color: string; distanceM: number }[];
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
  url?: string;
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

export interface TemporalContext {
  iso: string;
  date: string;
  time: string;
  hour: number;
  weekday: string;
  partOfDay: "overnight" | "early morning" | "morning" | "midday" | "afternoon" | "evening" | "late night";
  isWeekend: boolean;
  season: "winter" | "spring" | "summer" | "fall";
}

export interface LocationContext {
  scope: { point: { lon: number; lat: number }; radiusM: number; businessType?: string; name?: string };
  generatedAt: string;
  now: TemporalContext;
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
  mlPowered?: boolean;
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

export type TransitMode = "subway" | "streetcar" | "go";

export interface RouteCollection {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { id: string; name: string; line: string; mode: TransitMode; color: string };
    geometry: { type: "LineString"; coordinates: [number, number][] };
  }[];
}

export interface GoTrainCollection {
  type: "FeatureCollection";
  status: "demo";
  fetchedAt: string;
  dayType: "weekday" | "sat" | "sun";
  serviceSecond: number;
  activeTrains: number;
  note: string;
  attribution: string;
  features: {
    type: "Feature";
    properties: {
      id: string;
      line: string;
      color: string;
      direction: "inbound" | "outbound";
      speedKmh: number;
      nextStation: string;
    };
    geometry: { type: "Point"; coordinates: [number, number] };
  }[];
}

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
    opensAt?: number;
    closesAt?: number;
    eventRadiusKm?: number;
    customersPerWorkerHour?: number;
    hourlyWage?: number;
    minStaff?: number;
    maxStaffPerHour?: number;
    allowedShiftLengths?: number[];
  }) =>
    fetch("/api/businesses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(json<Business>),

  transitNearby: (address: string) =>
    fetch(`/api/transit/nearby?address=${encodeURIComponent(address)}`).then(json<TransitNearby>),

  businessResearch: (businessId: string) =>
    fetch(`/api/businesses/${businessId}/research`).then(
      json<{
        businessId: string;
        status: "pending" | "ready" | "error";
        briefing: string;
        sources: string[];
        generatedAt: string | null;
        error?: string;
      }>,
    ),

  refreshBusinessResearch: (businessId: string) =>
    fetch(`/api/businesses/${businessId}/research`, { method: "POST" }).then(
      json<{
        businessId: string;
        status: "pending" | "ready" | "error";
        briefing: string;
        sources: string[];
        generatedAt: string;
        error?: string;
      }>,
    ),

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

  transitRoutes: () => fetch("/api/transit/routes").then(json<RouteCollection>),

  goTrains: () => fetch("/api/transit/go").then(json<GoTrainCollection>),

  agent: (body: { question: string; businessId?: string; lon?: number; lat?: number; radiusM?: number }) =>
    fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<AgentAnswer>),

  /**
   * Streaming agent. Calls `onEvent` for each SSE frame as tokens arrive
   * (`delta`), once for metadata (`provider`/`model`), and a final `done`.
   * Resolves when the stream closes.
   */
  agentStream: async (
    body: { question: string; businessId: string; radiusM?: number; useGradient?: boolean },
    onEvent: (e: { delta?: string; provider?: string; model?: string; gradientUsed?: boolean; done?: boolean; error?: string }) => void,
  ): Promise<void> => {
    const res = await fetch("/api/agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  },

  bizHistory: (businessId: string) =>
    fetch(`/api/businesses/${businessId}/history`).then(json<{
      summary: {
        totalDays: number;
        avgDailyRevenue: number | null;
        avgDailyCustomers: number | null;
        peakHour: number | null;
        peakDow: number | null;
      };
      rows: Array<{ date: string; hour: number; revenue: number | null; customer_count: number | null; notes: string | null }>;
    }>),

  bizSchedule: (businessId: string) =>
    fetch(`/api/businesses/${businessId}/schedule`).then(json<{
      upcoming: Array<{ date: string; hour: number; staff_count: number; role: string | null }>;
      recent:   Array<{ date: string; hour: number; staff_count: number; role: string | null }>;
    }>),

  bizGenerate: (businessId: string) =>
    fetch(`/api/businesses/${businessId}/generate`, { method: "POST" }).then(json<{ historyRows: number; scheduleRows: number }>),

  bizUploadHistory: (businessId: string, rows: object[]) =>
    fetch(`/api/businesses/${businessId}/history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    }).then(json<{ inserted: number }>),

  bizUploadSchedule: (businessId: string, rows: object[]) =>
    fetch(`/api/businesses/${businessId}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    }).then(json<{ inserted: number }>),

  asrHealth: () =>
    fetch("/api/asr/health").then(json<{
      available: boolean;
      loaded?: boolean;
      url?: string;
      error?: string;
      hint?: string;
    }>),

  asrTranscribe: async (audio: Blob, filename = "recording.webm") => {
    const form = new FormData();
    form.append("audio", audio, filename);
    const res = await fetch("/api/asr/transcribe", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(err || `HTTP ${res.status}`);
    }
    return res.json() as Promise<{ text: string }>;
  },

  nearestCamera: (lon: number, lat: number) =>
    fetch(`/api/cameras/nearest?lon=${lon}&lat=${lat}&n=1`).then(
      json<TrafficCamera[]>,
    ),
};

export interface TrafficCamera {
  recId: number;
  name: string;
  mainRoad: string;
  crossRoad: string;
  lon: number;
  lat: number;
  distanceM: number;
  /** Same-origin proxy URL for the latest snapshot. */
  imageUrl: string;
  /** Direct upstream https snapshot (fallback if the proxy can't fetch it). */
  directUrl?: string;
}
