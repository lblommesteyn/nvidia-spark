import { distanceM } from "../geo.ts";
import {
  CIVIC_SOURCES,
  loadCivicSource,
} from "../sources/civic.ts";
import { getAirQuality, getWeather } from "../sources/environment.ts";
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
  weather: SourceResult<unknown>;
  airQuality: SourceResult<unknown>;
  civic: CivicGroup[];
  /** Compact, model-friendly bullet summary. */
  highlights: string[];
}

/**
 * Build a location-scoped, machine-readable context bundle: weather, air quality,
 * and all civic data sources filtered to records near the point. This is the
 * core "AI-friendly" artifact the agent (and external agents) consume.
 */
export async function buildContext(scope: ContextScope): Promise<LocationContext> {
  const [weather, airQuality, ...civicResults] = await Promise.all([
    getWeather(scope.point),
    getAirQuality(scope.point),
    ...CIVIC_SOURCES.map((def) => loadCivicSource(def)),
  ]);

  const civic: CivicGroup[] = civicResults.map((result, idx) => {
    const def = CIVIC_SOURCES[idx];
    const withCoords = result.data.filter((r) => r.lon != null && r.lat != null);
    const areaWide = withCoords.length === 0;

    let nearby: CivicRecord[];
    if (areaWide) {
      // No coordinates available — surface a small city-wide sample instead.
      nearby = result.data.slice(0, 6);
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
      fetchedAt: result.fetchedAt,
      note: result.note,
      nearby,
      totalConsidered: result.data.length,
      areaWide,
    };
  });

  const highlights = buildHighlights(scope, weather, airQuality, civic);

  return {
    scope,
    generatedAt: new Date().toISOString(),
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
