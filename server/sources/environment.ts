import { cached, fetchJson, nowIso } from "../cache.ts";
import type { GeoPoint, SourceResult } from "../types.ts";

const WMO: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
};

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

function aqiCategory(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy (sensitive)";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

export async function getWeather(p: GeoPoint): Promise<SourceResult<WeatherNow>> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day" +
    "&wind_speed_unit=kmh&timezone=America%2FToronto";
  try {
    const raw = await cached(`weather:${p.lat.toFixed(3)},${p.lon.toFixed(3)}`, () =>
      fetchJson<{ current: Record<string, number> }>(url),
    );
    const c = raw.current;
    return {
      source: "weather",
      status: "live",
      fetchedAt: nowIso(),
      attribution: "Open-Meteo",
      data: {
        temperatureC: Math.round(c.temperature_2m),
        feelsLikeC: Math.round(c.apparent_temperature),
        windKph: Math.round(c.wind_speed_10m),
        humidity: Math.round(c.relative_humidity_2m),
        description: WMO[c.weather_code] ?? "Unknown",
        isDay: c.is_day === 1,
      },
    };
  } catch (err) {
    return {
      source: "weather",
      status: "demo",
      fetchedAt: nowIso(),
      note: err instanceof Error ? err.message : "error",
      data: { temperatureC: -3, feelsLikeC: -9, windKph: 22, humidity: 71, description: "Light snow", isDay: true },
    };
  }
}

export async function getAirQuality(p: GeoPoint): Promise<SourceResult<AirQualityNow>> {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat}&longitude=${p.lon}` +
    "&current=us_aqi,pm2_5,pm10&timezone=America%2FToronto";
  try {
    const raw = await cached(`aq:${p.lat.toFixed(3)},${p.lon.toFixed(3)}`, () =>
      fetchJson<{ current: Record<string, number> }>(url),
    );
    const c = raw.current;
    return {
      source: "air-quality",
      status: "live",
      fetchedAt: nowIso(),
      attribution: "Open-Meteo Air Quality",
      data: {
        usAqi: Math.round(c.us_aqi),
        pm25: Math.round(c.pm2_5),
        pm10: Math.round(c.pm10),
        category: aqiCategory(c.us_aqi),
      },
    };
  } catch (err) {
    return {
      source: "air-quality",
      status: "demo",
      fetchedAt: nowIso(),
      note: err instanceof Error ? err.message : "error",
      data: { usAqi: 34, pm25: 8, pm10: 14, category: aqiCategory(34) },
    };
  }
}
