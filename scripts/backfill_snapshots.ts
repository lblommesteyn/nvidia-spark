#!/usr/bin/env npx tsx
/**
 * Bootstrap the SQLite signal_snapshots table with real historical data.
 *
 * Sources:
 *   1. Open-Meteo Archive API           — real hourly Toronto weather, free, no key
 *   2. Toronto Open Data CKAN API:
 *        ttc-subway-delay-data          — TTC delay counts by date/hour
 *        ttc-bus-delay-data             — TTC bus delay counts by date/hour
 *        311-service-requests-customer-initiated — 311 call counts by date
 *        building-permits-active-permits         — active construction permits
 *
 * Usage:
 *   npx tsx scripts/backfill_snapshots.ts
 *   npx tsx scripts/backfill_snapshots.ts --days 60
 *   npx tsx scripts/backfill_snapshots.ts --days 30 --skip-existing
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// ---- CLI args ---------------------------------------------------------------
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DAYS_BACK = Number(arg("days", "90"));
const SKIP_EXISTING = process.argv.includes("--skip-existing");

// ---- Constants --------------------------------------------------------------
const DB_PATH = resolve(process.cwd(), "data/toronto-monitor.db");
const TORONTO = { lat: 43.6535, lon: -79.3839 };
const CKAN_BASE = "https://ckan0.cf.opendata.inter.prod-toronto.ca";
const METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";

const SAMPLE_LOCATIONS = [
  { name: "Financial District café",     businessType: "cafe",       lat: 43.6487, lon: -79.3806 },
  { name: "Kensington Market grocer",    businessType: "grocery",    lat: 43.6547, lon: -79.4003 },
  { name: "Distillery District restaurant", businessType: "restaurant", lat: 43.6503, lon: -79.3593 },
  { name: "Liberty Village gym",         businessType: "gym",        lat: 43.6376, lon: -79.4203 },
  { name: "The Beaches bakery",          businessType: "bakery",     lat: 43.6712, lon: -79.2986 },
  { name: "Yorkville boutique",          businessType: "retail",     lat: 43.6709, lon: -79.3923 },
  { name: "North York pharmacy",         businessType: "pharmacy",   lat: 43.7615, lon: -79.4112 },
  { name: "Scarborough Town diner",      businessType: "restaurant", lat: 43.7764, lon: -79.2578 },
  { name: "Junction brewery taproom",    businessType: "bar",        lat: 43.6654, lon: -79.4647 },
  { name: "Entertainment District bar",  businessType: "bar",        lat: 43.6447, lon: -79.3899 },
];

// ---- DB setup ---------------------------------------------------------------
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS signal_snapshots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at       TEXT NOT NULL,
    location          TEXT NOT NULL,
    business_type     TEXT,
    lon               REAL,
    lat               REAL,
    features          TEXT NOT NULL,
    digest            TEXT NOT NULL,
    forecast_score    REAL NOT NULL DEFAULT 0,
    forecast_level    TEXT NOT NULL DEFAULT 'moderate',
    forecast_headline TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_snap_captured ON signal_snapshots(captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_snap_location ON signal_snapshots(location);
`);

const insertStmt = db.prepare(`
  INSERT INTO signal_snapshots
    (captured_at, location, business_type, lon, lat, features, digest,
     forecast_score, forecast_level, forecast_headline)
  VALUES
    (@captured_at, @location, @business_type, @lon, @lat, @features, @digest,
     @forecast_score, @forecast_level, @forecast_headline)
`);

const existsStmt = db.prepare(
  "SELECT 1 FROM signal_snapshots WHERE captured_at = @captured_at AND location = @location LIMIT 1",
);

// ---- Helpers ----------------------------------------------------------------
const fmt = (d: Date): string => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T>(url: string, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "cityflow-backfill/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error("unreachable");
}

// Parse a simple CSV line respecting double-quoted fields.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === "," && !inQuote) { fields.push(cur.trim()); cur = ""; }
    else { cur += ch; }
  }
  fields.push(cur.trim());
  return fields;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? "").replace(/^"|"$/g, ""); });
    return row;
  });
}

// ---- Feature vector (must match server/ai/patterns.ts exactly) --------------
function toFeatureVector(digest: Record<string, unknown>): number[] {
  const hour = Number(digest.localHour ?? 12);
  const w = (digest.weather ?? {}) as Record<string, number>;
  const aq = (digest.airQuality ?? {}) as Record<string, number>;
  const c = (digest.counts ?? {}) as Record<string, number>;
  const date = new Date(String(digest._ts ?? new Date().toISOString()));
  const dow = date.getDay();
  const isWeekend = dow === 0 || dow === 6 ? 1 : 0;
  return [
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    Math.sin((2 * Math.PI * dow) / 7),
    Math.cos((2 * Math.PI * dow) / 7),
    isWeekend,
    Math.min(1, Math.max(0, (Number(w.temperatureC ?? 10) + 30) / 70)),
    Math.min(1, Number(w.precipMm ?? 0) / 20),
    Math.min(1, Number(w.windKph ?? 0) / 80),
    Math.min(1, Number(aq.usAqi ?? 0) / 150),
    Math.min(1, Number(c.events ?? 0) / 10),
    Math.min(1, Number(c.construction ?? 0) / 10),
    Math.min(1, Number(c.transit ?? 0) / 5),
    Math.min(1, Number(c.alerts ?? 0) / 5),
    Math.min(1, Number(c.aviation ?? 0) / 20),
  ];
}

function levelFromScore(s: number): string {
  if (s < 0.35) return "low";
  if (s < 0.55) return "moderate";
  if (s < 0.75) return "elevated";
  return "surge";
}

// ---- 1. Open-Meteo Archive: hourly weather for Toronto ----------------------
interface MeteoResponse {
  hourly: {
    time: string[];
    temperature_2m: number[];
    precipitation: number[];
    windspeed_10m: number[];
    weathercode: number[];
    apparent_temperature: number[];
    relativehumidity_2m: number[];
  };
}

console.log(`\n[backfill] fetching ${DAYS_BACK} days of hourly weather from Open-Meteo…`);
const endDate = new Date();
const startDate = new Date(endDate.getTime() - DAYS_BACK * 86_400_000);

const meteoUrl = [
  `${METEO_ARCHIVE}?latitude=${TORONTO.lat}&longitude=${TORONTO.lon}`,
  `&start_date=${fmt(startDate)}&end_date=${fmt(endDate)}`,
  `&hourly=temperature_2m,precipitation,windspeed_10m,weathercode,apparent_temperature,relativehumidity_2m`,
  `&timezone=America%2FToronto`,
].join("");

const meteo = await fetchJson<MeteoResponse>(meteoUrl);
const weatherByHour = new Map<string, {
  temperatureC: number; precipMm: number; windKph: number;
  feelsLikeC: number; humidity: number; weatherCode: number;
}>();
meteo.hourly.time.forEach((ts, i) => {
  weatherByHour.set(ts, {
    temperatureC: meteo.hourly.temperature_2m[i] ?? 10,
    precipMm: meteo.hourly.precipitation[i] ?? 0,
    windKph: meteo.hourly.windspeed_10m[i] ?? 0,
    feelsLikeC: meteo.hourly.apparent_temperature[i] ?? 10,
    humidity: meteo.hourly.relativehumidity_2m[i] ?? 60,
    weatherCode: meteo.hourly.weathercode[i] ?? 0,
  });
});
console.log(`  ✓ ${weatherByHour.size} hourly weather records`);

// ---- 2. Toronto Open Data: TTC subway + bus delay counts --------------------
// Delay data is published as monthly CSVs via CKAN. We download the last
// few months and aggregate into a map of "YYYY-MM-DD:HH" → delay count.
const transitDelaysByHour = new Map<string, number>();

async function ingestTtcDelayPackage(pkg: string): Promise<number> {
  let total = 0;
  try {
    const meta = await fetchJson<{ success: boolean; result: { resources: Array<{ id: string; name: string; format: string; url: string }> } }>(
      `${CKAN_BASE}/api/3/action/package_show?id=${pkg}`,
    );
    if (!meta.success) return 0;

    // Get CSV resources from recent months only (avoid massive downloads).
    const cutoff = new Date(startDate);
    const csvResources = meta.result.resources
      .filter((r) => r.format.toUpperCase() === "CSV")
      .slice(0, 4); // last 4 monthly files

    for (const resource of csvResources) {
      try {
        console.log(`  → fetching ${resource.name} (${pkg})…`);
        const text = await fetch(resource.url, {
          headers: { "User-Agent": "cityflow-backfill/1.0" },
          signal: AbortSignal.timeout(45_000),
        }).then((r) => r.text());

        const rows = parseCsv(text);
        for (const row of rows) {
          // TTC delay CSV columns vary slightly by dataset but date/time are consistent.
          const dateStr = row["Date"] ?? row["date"] ?? "";
          const timeStr = row["Time"] ?? row["time"] ?? "";
          if (!dateStr) continue;

          // Parse date — various formats: "2025/01/15" or "January 15, 2025" or "2025-01-15"
          let d: Date | null = null;
          const clean = dateStr.trim();
          if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(clean)) {
            d = new Date(clean.replace(/\//g, "-") + "T00:00:00");
          } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(clean)) {
            const [mo, day, yr] = clean.split("/");
            d = new Date(`${yr}-${mo!.padStart(2, "0")}-${day!.padStart(2, "0")}T00:00:00`);
          } else {
            d = new Date(clean);
          }
          if (!d || isNaN(d.getTime()) || d < cutoff) continue;

          const hour = timeStr ? Number(timeStr.split(":")[0]) : 0;
          const key = `${fmt(d)}:${String(hour).padStart(2, "0")}`;
          transitDelaysByHour.set(key, (transitDelaysByHour.get(key) ?? 0) + 1);
          total++;
        }
      } catch (err) {
        console.warn(`    ! ${resource.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    console.warn(`  ! ${pkg}: ${err instanceof Error ? err.message : err}`);
  }
  return total;
}

console.log("\n[backfill] fetching TTC delay data from Toronto Open Data…");
const subwayDelays = await ingestTtcDelayPackage("ttc-subway-delay-data");
const busDelays    = await ingestTtcDelayPackage("ttc-bus-delay-data");
console.log(`  ✓ ${subwayDelays + busDelays} delay events indexed across ${transitDelaysByHour.size} hours`);

// ---- 3. Toronto Open Data: 311 service requests count by date ---------------
// CKAN datastore — query counts per date bucket for the lookback window.
const callsByDate = new Map<string, number>();

async function ingest311(): Promise<void> {
  try {
    // Discover the datastore-active resource.
    const meta = await fetchJson<{ success: boolean; result: { resources: Array<{ id: string; datastore_active: boolean }> } }>(
      `${CKAN_BASE}/api/3/action/package_show?id=311-service-requests-customer-initiated`,
    );
    if (!meta.success) return;
    const resource = meta.result.resources.find((r) => r.datastore_active);
    if (!resource) { console.warn("  ! 311: no datastore-active resource"); return; }

    // Fetch in batches — max 32,000 rows per call.
    let offset = 0;
    const limit = 5000;
    let fetched = 0;
    console.log("  → streaming 311 records…");

    while (true) {
      const url = `${CKAN_BASE}/api/3/action/datastore_search?resource_id=${resource.id}&limit=${limit}&offset=${offset}`;
      const res = await fetchJson<{ success: boolean; result: { records: Record<string, unknown>[]; total: number } }>(url);
      if (!res.success || res.result.records.length === 0) break;

      for (const row of res.result.records) {
        const rawDate = String(row["Creation Date"] ?? row["creation_date"] ?? row["Date"] ?? "");
        if (!rawDate) continue;
        const d = new Date(rawDate);
        if (isNaN(d.getTime()) || d < startDate) continue;
        const key = fmt(d);
        callsByDate.set(key, (callsByDate.get(key) ?? 0) + 1);
        fetched++;
      }

      offset += res.result.records.length;
      if (offset >= res.result.total || offset >= 100_000) break; // cap at 100k rows
      await sleep(120); // be a polite API client
    }
    console.log(`  ✓ ${fetched} 311 records across ${callsByDate.size} dates`);
  } catch (err) {
    console.warn(`  ! 311: ${err instanceof Error ? err.message : err}`);
  }
}

console.log("\n[backfill] fetching 311 service requests from Toronto Open Data…");
await ingest311();

// ---- 4. Toronto Open Data: active building permits (construction signal) ----
// Not time-series — gives us a count of active permits in the city right now
// which we use as a baseline construction pressure for all historical rows.
let constructionBaseline = 3; // default if fetch fails

async function ingestPermits(): Promise<void> {
  try {
    const meta = await fetchJson<{ success: boolean; result: { resources: Array<{ id: string; datastore_active: boolean }> } }>(
      `${CKAN_BASE}/api/3/action/package_show?id=building-permits-active-permits`,
    );
    if (!meta.success) return;
    const resource = meta.result.resources.find((r) => r.datastore_active);
    if (!resource) return;

    const res = await fetchJson<{ success: boolean; result: { total: number } }>(
      `${CKAN_BASE}/api/3/action/datastore_search?resource_id=${resource.id}&limit=1`,
    );
    if (res.success) {
      // Normalize to a per-location signal: city has ~12k active permits, assume
      // ~2-5% affect any given 750m radius.
      constructionBaseline = Math.round(res.result.total * 0.035 / 1000);
      console.log(`  ✓ ${res.result.total} active building permits (baseline: ${constructionBaseline}/location)`);
    }
  } catch (err) {
    console.warn(`  ! permits: ${err instanceof Error ? err.message : err}`);
  }
}

console.log("\n[backfill] fetching building permit count from Toronto Open Data…");
await ingestPermits();

// ---- 5. Generate and insert historical snapshots ----------------------------
// For every hour in the lookback window × every sample location, build a
// feature vector from the real data collected above and insert into the DB.

console.log(`\n[backfill] inserting snapshots for ${DAYS_BACK} days × 24h × ${SAMPLE_LOCATIONS.length} locations…`);

const insertBatch = db.transaction((rows: Parameters<typeof insertStmt.run>[0][]) => {
  for (const row of rows) insertStmt.run(row);
});

let inserted = 0;
let skipped = 0;
let totalHours = 0;

// Walk every hour in the lookback window.
for (let daysAgo = DAYS_BACK; daysAgo >= 1; daysAgo--) {
  const day = new Date(endDate.getTime() - daysAgo * 86_400_000);
  const dateKey = fmt(day);
  const callCount = callsByDate.get(dateKey) ?? 0;

  const batch: Parameters<typeof insertStmt.run>[0][] = [];

  for (let hour = 0; hour < 24; hour++) {
    totalHours++;
    const ts = `${dateKey}T${String(hour).padStart(2, "0")}:00:00`;
    const meteoKey = `${dateKey}T${String(hour).padStart(2, "0")}:00`;
    const delayKey = `${dateKey}:${String(hour).padStart(2, "0")}`;

    const weather = weatherByHour.get(meteoKey) ?? {
      temperatureC: 10, precipMm: 0, windKph: 15,
      feelsLikeC: 8, humidity: 65, weatherCode: 0,
    };
    const transitDelays = transitDelaysByHour.get(delayKey) ?? 0;

    // Estimate flight inflow: YYZ has ~450 daily arrivals; distribute by hour
    // with a realistic intra-day curve (peaks 07-09 and 17-20).
    const flightHourWeight = [0.01,0.005,0.005,0.005,0.01,0.02,0.06,0.07,0.07,0.05,0.04,0.04,
                              0.04,0.05,0.05,0.05,0.06,0.07,0.07,0.06,0.04,0.03,0.02,0.01][hour] ?? 0.03;
    const estimatedFlights = Math.round(450 * flightHourWeight);

    // Events: assume 0 unless it's an evening hour on a weekend or major game night.
    const dow = day.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isEvening = hour >= 17 && hour <= 22;
    const estimatedEvents = isEvening && isWeekend ? 2 : isEvening ? 1 : 0;

    for (const loc of SAMPLE_LOCATIONS) {
      if (SKIP_EXISTING) {
        const exists = existsStmt.get({ captured_at: ts, location: loc.name });
        if (exists) { skipped++; continue; }
      }

      const counts = {
        events: estimatedEvents,
        aviation: estimatedFlights,
        construction: constructionBaseline,
        transit: Math.min(transitDelays, 5),
        alerts: Math.min(Math.round(callCount / 80), 5), // normalize 311 calls to 0-5 signal
        bikeshare: 0, // not location-specific without full CSV
      };

      const digest: Record<string, unknown> = {
        _ts: ts,
        localHour: hour,
        weather: {
          temperatureC: weather.temperatureC,
          precipMm: weather.precipMm,
          windKph: weather.windKph,
          feelsLikeC: weather.feelsLikeC,
          humidity: weather.humidity,
          description: weatherCodeDescription(weather.weatherCode),
        },
        airQuality: { usAqi: estimateAqi(weather) },
        counts,
        highlights: [],
      };

      const features = toFeatureVector(digest);

      // Compute demand score heuristic from the real signals.
      let score = 0.42; // Toronto baseline
      // Temperature: peak at 18-22°C, drops in extremes
      const tempScore = 1 - Math.abs(weather.temperatureC - 20) / 40;
      score += tempScore * 0.08;
      // Rain suppresses foot traffic
      if (weather.precipMm > 5) score -= 0.12;
      else if (weather.precipMm > 1) score -= 0.06;
      // Wind above 40kph suppresses foot traffic
      if (weather.windKph > 40) score -= 0.05;
      // Events lift demand
      score += estimatedEvents * 0.06;
      // Transit delays suppress walk-ins, slightly
      if (transitDelays > 3) score -= 0.08;
      else if (transitDelays > 0) score -= 0.03;
      // Hour-of-day: meal rush peaks
      const hourBoost = [
        -0.15,-0.2,-0.2,-0.2,-0.15,-0.05,0,0.04,0.08,0.06,0.04,0.08,
         0.12,0.08,0.06,0.05,0.06,0.10,0.12,0.08,0.04,0.02,-0.02,-0.08,
      ][hour] ?? 0;
      score += hourBoost;
      // Weekend lift
      if (isWeekend) score += 0.06;
      // High 311 call volume suggests disruption
      if (callCount > 500) score -= 0.04;

      score = Math.max(0, Math.min(1, score));
      const level = levelFromScore(score);
      const headline = buildHeadline(level, weather, transitDelays, estimatedEvents, loc.businessType);

      batch.push({
        captured_at: ts,
        location: loc.name,
        business_type: loc.businessType,
        lon: loc.lon,
        lat: loc.lat,
        features: JSON.stringify(features),
        digest: JSON.stringify(digest),
        forecast_score: score,
        forecast_level: level,
        forecast_headline: headline,
      });
    }
  }

  insertBatch(batch);
  inserted += batch.length;

  if (daysAgo % 10 === 0 || daysAgo === 1) {
    process.stdout.write(`  ${fmt(day)} — ${inserted} rows inserted\r`);
  }
}

// ---- helpers ----------------------------------------------------------------
function weatherCodeDescription(code: number): string {
  if (code === 0) return "Clear sky";
  if (code <= 3) return "Partly cloudy";
  if (code <= 9) return "Fog";
  if (code <= 19) return "Drizzle";
  if (code <= 29) return "Rain";
  if (code <= 39) return "Snow";
  if (code <= 49) return "Snow grains";
  if (code <= 59) return "Freezing drizzle";
  if (code <= 69) return "Freezing rain";
  if (code <= 79) return "Snow showers";
  if (code <= 84) return "Rain showers";
  if (code <= 94) return "Thunderstorm";
  return "Hail";
}

function estimateAqi(weather: { temperatureC: number; precipMm: number; windKph: number }): number {
  // Toronto AQI correlates with heat + low wind. No rain → smog accumulates.
  let aqi = 28;
  if (weather.temperatureC > 28) aqi += (weather.temperatureC - 28) * 2.5;
  if (weather.windKph < 10) aqi += 12;
  if (weather.precipMm > 2) aqi -= 10;
  return Math.max(5, Math.min(120, Math.round(aqi)));
}

function buildHeadline(
  level: string, weather: { temperatureC: number; precipMm: number; windKph: number },
  transitDelays: number, events: number, businessType: string,
): string {
  const biz = { cafe: "café", grocery: "grocer", restaurant: "restaurant",
    gym: "gym", bakery: "bakery", retail: "boutique", bar: "bar",
    pharmacy: "pharmacy" }[businessType] ?? "business";

  if (level === "surge")
    return `Strong demand surge expected — ${events > 0 ? "nearby events" : "weekend + good weather"} driving high foot traffic for this ${biz}.`;
  if (level === "elevated")
    return transitDelays > 2
      ? `Elevated demand despite ${transitDelays} transit delays — foot traffic rerouting through the area.`
      : `Above-average demand conditions for this ${biz}: weather and timing align.`;
  if (level === "low")
    return weather.precipMm > 3
      ? `Rain suppressing foot traffic — light demand expected for this ${biz}.`
      : `Quiet conditions — low foot traffic typical for this hour and day.`;
  return `Moderate conditions — typical demand for a ${biz} at this time.`;
}

// ---- summary ----------------------------------------------------------------
console.log(`\n\n[backfill] complete.`);
console.log(`  days covered:   ${DAYS_BACK}`);
console.log(`  locations:      ${SAMPLE_LOCATIONS.length}`);
console.log(`  rows inserted:  ${inserted}`);
console.log(`  rows skipped:   ${skipped} (already existed)`);
console.log(`  total in DB:    ${(db.prepare("SELECT COUNT(*) as n FROM signal_snapshots").get() as { n: number }).n}`);
console.log(`\n  Real data sources used:`);
console.log(`    Open-Meteo archive:   ${weatherByHour.size} hourly weather records`);
console.log(`    TTC delays:           ${subwayDelays + busDelays} events → ${transitDelaysByHour.size} hour buckets`);
console.log(`    311 service calls:    ${callsByDate.size} day buckets`);
console.log(`    Building permits:     baseline=${constructionBaseline}/location`);
console.log(`\nPattern store is ready. Start the server to begin serving historical context.`);

db.close();
