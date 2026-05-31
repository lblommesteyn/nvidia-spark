import { distanceM } from "../geo.ts";
import {
  CIVIC_SOURCES,
  loadCivicSource,
  sourceUrl,
  type CivicSourceDef,
} from "../sources/civic.ts";
import { getAirQuality, getWeather, type AirQualityNow, type WeatherNow } from "../sources/environment.ts";
import { nowIso } from "../cache.ts";
import type {
  BusinessProfile,
  CivicRecord,
  GeoPoint,
  SourceResult,
} from "../types.ts";

export interface ContextScope {
  point: GeoPoint;
  /** Radius in metres for "nearby" civic records. */
  radiusM: number;
  businessType?: string;
  name?: string;
}

export interface CivicGroup {
  source: string;
  label: string;
  category: CivicRecord["category"];
  status: SourceResult<unknown>["status"];
  attribution?: string;
  /** Public "view source" link (Open Data Toronto dataset page or provider site). */
  url?: string;
  /** When this source's data was fetched (ISO), for "updated X ago" in the UI. */
  fetchedAt: string;
  note?: string;
  nearby: CivicRecord[];
  totalConsidered: number;
  /** True when records have no coordinates, so this is a city-wide sample, not distance-scoped. */
  areaWide: boolean;
}

export interface LocationContext {
  scope: ContextScope;
  generatedAt: string;
  /** Toronto-local temporal context so the model can reason about "right now". */
  now: TemporalContext;
  weather: SourceResult<unknown>;
  airQuality: SourceResult<unknown>;
  civic: CivicGroup[];
  /** Compact, model-friendly bullet summary. */
  highlights: string[];
}

export interface TemporalContext {
  /** ISO timestamp of generation. */
  iso: string;
  /** Toronto-local date, e.g. "2026-05-30". */
  date: string;
  /** Toronto-local 24h clock, e.g. "18:42". */
  time: string;
  /** Hour of day 0–23 (Toronto). */
  hour: number;
  /** Weekday short name, e.g. "Fri". */
  weekday: string;
  /** Coarse part of day for human/owner phrasing. */
  partOfDay: "overnight" | "early morning" | "morning" | "midday" | "afternoon" | "evening" | "late night";
  isWeekend: boolean;
  /** Meteorological season for Toronto's hemisphere. */
  season: "winter" | "spring" | "summer" | "fall";
}

const TZ = "America/Toronto";

/** Build a Toronto-local temporal snapshot the model can reason over. */
export function temporalContext(at: Date = new Date()): TemporalContext {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  let hourStr = get("hour");
  if (hourStr === "24") hourStr = "00"; // some ICU builds emit 24 at midnight
  const hour = Number(hourStr);
  const minute = get("minute");
  const weekday = get("weekday");
  const isWeekend = weekday === "Sat" || weekday === "Sun";

  let partOfDay: TemporalContext["partOfDay"];
  if (hour < 5) partOfDay = "overnight";
  else if (hour < 8) partOfDay = "early morning";
  else if (hour < 11) partOfDay = "morning";
  else if (hour < 14) partOfDay = "midday";
  else if (hour < 17) partOfDay = "afternoon";
  else if (hour < 22) partOfDay = "evening";
  else partOfDay = "late night";

  const m = Number(month);
  const season: TemporalContext["season"] =
    m <= 2 || m === 12 ? "winter" : m <= 5 ? "spring" : m <= 8 ? "summer" : "fall";

  return {
    iso: at.toISOString(),
    date: `${year}-${month}-${day}`,
    time: `${hourStr}:${minute}`,
    hour,
    weekday,
    partOfDay,
    isWeekend,
    season,
  };
}

/**
 * Per-source soft deadline (ms). Each source already degrades to demo data on
 * *error*, but a hung upstream can still leave a request waiting on that
 * source's own (longer) network timeout. This bounds cold-load: if any one
 * source hasn't settled within the deadline, we resolve a degraded fallback so
 * the dashboard renders fast and that tile fills in on the next poll.
 */
const SOURCE_DEADLINE_MS = 3500;

function withDeadline<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(fallback()), ms);
    p.then(done, () => done(fallback()));
  });
}

function weatherFallback(): SourceResult<WeatherNow> {
  return {
    source: "weather",
    status: "demo",
    fetchedAt: nowIso(),
    note: "source slow — showing placeholder; refreshes shortly",
    data: { temperatureC: -3, feelsLikeC: -9, windKph: 22, humidity: 71, description: "Light snow", isDay: true },
  };
}

function airQualityFallback(): SourceResult<AirQualityNow> {
  return {
    source: "airquality",
    status: "demo",
    fetchedAt: nowIso(),
    note: "source slow — showing placeholder; refreshes shortly",
    data: { usAqi: 34, pm25: 8, pm10: 14, category: "Good" },
  };
}

function civicFallback(def: CivicSourceDef): SourceResult<CivicRecord[]> {
  return {
    source: def.key,
    status: "demo",
    fetchedAt: nowIso(),
    note: "source slow — showing demo data; refreshes shortly",
    data: def.demo ?? [],
    attribution: def.attribution,
  };
}

/**
 * Build a location-scoped, machine-readable context bundle: weather, air quality,
 * and all civic data sources filtered to records near the point. This is the
 * core "AI-friendly" artifact the agent (and external agents) consume.
 */
export async function buildContext(scope: ContextScope): Promise<LocationContext> {
  const [weather, airQuality, ...civicResults] = await Promise.all([
    withDeadline(getWeather(scope.point), SOURCE_DEADLINE_MS, weatherFallback),
    withDeadline(getAirQuality(scope.point), SOURCE_DEADLINE_MS, airQualityFallback),
    ...CIVIC_SOURCES.map((def) =>
      withDeadline(loadCivicSource(def), SOURCE_DEADLINE_MS, () => civicFallback(def)),
    ),
  ]);

  const civic: CivicGroup[] = civicResults.map((result, idx) => {
    const def = CIVIC_SOURCES[idx];
    const withCoords = result.data.filter((r) => r.lon != null && r.lat != null);
    // A source is "area-wide" if it has no coordinates to scope by, OR it's
    // explicitly flagged as a city/region-wide signal (e.g. airport flights).
    const areaWide = withCoords.length === 0 || def.areaWide === true;

    let nearby: CivicRecord[];
    if (areaWide) {
      // Not distance-scoped — surface a sample, annotated with distance when
      // coordinates exist (so the UI can still show how far, e.g. to YYZ).
      const base = withCoords.length > 0 ? withCoords : result.data;
      nearby = base
        .map((rec) =>
          rec.lon != null && rec.lat != null
            ? { ...rec, distanceM: distanceM(scope.point, { lon: rec.lon, lat: rec.lat }) }
            : rec,
        )
        .slice(0, 15);
    } else {
      nearby = withCoords
        .map((rec) => ({
          ...rec,
          distanceM: distanceM(scope.point, { lon: rec.lon!, lat: rec.lat! }),
        }))
        .filter((rec) => rec.distanceM! <= scope.radiusM)
        .sort((a, b) => a.distanceM! - b.distanceM!)
        .slice(0, 15);
    }

    return {
      source: result.source,
      label: def.label,
      category: def.category,
      status: result.status,
      attribution: result.attribution,
      url: sourceUrl(def),
      fetchedAt: result.fetchedAt,
      note: result.note,
      nearby,
      totalConsidered: result.data.length,
      areaWide,
    };
  });

  const highlights = buildHighlights(scope, weather, airQuality, civic);
  const now = temporalContext();
  highlights.unshift(
    `Now: ${now.weekday} ${now.date}, ${now.time} (${now.partOfDay}, ${now.season}${now.isWeekend ? ", weekend" : ", weekday"}).`,
  );

  return {
    scope,
    generatedAt: new Date().toISOString(),
    now,
    weather,
    airQuality,
    civic,
    highlights,
  };
}

function buildHighlights(
  scope: ContextScope,
  weather: SourceResult<unknown>,
  air: SourceResult<unknown>,
  civic: CivicGroup[],
): string[] {
  const out: string[] = [];
  const w = weather.data as { temperatureC: number; description: string };
  if (w) out.push(`Weather: ${w.temperatureC}°C, ${w.description}.`);
  const a = air.data as { usAqi: number; category: string };
  if (a) out.push(`Air quality: US AQI ${a.usAqi} (${a.category}).`);

  for (const group of civic) {
    if (group.nearby.length === 0) continue;
    const closest = group.nearby[0];
    if (group.areaWide) {
      out.push(
        `${group.label}: city-wide sample of ${group.nearby.length} (no coordinates in dataset). e.g. ${closest.title}.`,
      );
    } else {
      const dist = closest.distanceM != null ? ` (~${closest.distanceM}m)` : "";
      out.push(
        `${group.label}: ${group.nearby.length} within ${Math.round(scope.radiusM)}m. Nearest: ${closest.title}${dist}.`,
      );
    }
  }
  return out;
}

export function scopeFromBusiness(
  b: BusinessProfile,
  radiusM = 750,
): ContextScope {
  return {
    point: { lon: b.lon, lat: b.lat },
    radiusM,
    businessType: b.businessType,
    name: b.name,
  };
}
