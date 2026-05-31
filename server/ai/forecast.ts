/**
 * Demand forecasting for a Toronto location/business.
 *
 * Two layers, both shipping today:
 *   1. A deterministic HEURISTIC baseline computed from the live context bundle
 *      (events nearby, inbound flights, weather, construction friction, transit,
 *      and time-of-day meal rushes). This guarantees a useful, grounded forecast
 *      even on the no-key mock provider.
 *   2. When a real LLM provider is active (ideally a Nemotron NIM on the GX10),
 *      we ask the model to reason over the same signals and return strict JSON.
 *      On any parse failure we fall back to the heuristic — never a blank tile.
 */
import { buildContext, scopeFromBusiness, type LocationContext } from "./context.ts";
import { activeProvider, chat } from "./provider.ts";
import { findSimilarMoments, historicalPatternBlock } from "./patterns.ts";
import { getWeatherForecast, type WeatherHour } from "../sources/environment.ts";
import { businesses } from "../db.ts";
import type { BusinessProfile, CivicRecord, GeoPoint } from "../types.ts";

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
  /** "heuristic" when computed locally, "llm" when reasoned by the model. */
  method: "heuristic" | "llm";
  horizonHours: number;
  level: DemandLevel;
  /** 0..1 normalized demand pressure. */
  score: number;
  headline: string;
  drivers: ForecastDriver[];
  windows: ForecastWindow[];
  actions: string[];
  /** Optional model reasoning summary (Nemotron thinking, condensed). */
  reasoning?: string;
  contextUsed: {
    name?: string;
    businessType?: string;
    radiusM: number;
    highlights: string[];
  };
}

/** One day in the week-ahead forecast. */
export interface ForecastDay {
  date: string;
  dayName: string;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  peakScore: number;
  peakLevel: DemandLevel;
  /** Local clock label of the busiest window, e.g. "18:00–20:00". */
  peakWindow: string;
  avgScore: number;
  avgLevel: DemandLevel;
  highTempC?: number;
  lowTempC?: number;
  weather?: string;
  /** Scheduled events landing on this day within range. */
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
  /** Provenance of the forecasted weather (live forecast vs demo fallback). */
  weatherStatus: "live" | "demo" | "error";
  /** Honest description of which signals are future-valid. */
  basis: string;
  contextUsed: {
    name?: string;
    businessType?: string;
    radiusM: number;
    structural: { construction: number; transit: number };
  };
}

function levelFromScore(score: number): DemandLevel {
  if (score < 0.35) return "low";
  if (score < 0.55) return "moderate";
  if (score < 0.75) return "elevated";
  return "surge";
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Count nearby records in a civic group by source key. */
function groupCount(ctx: LocationContext, source: string): number {
  return ctx.civic.find((g) => g.source === source)?.nearby.length ?? 0;
}

/** Sum nearby records across categories. */
function categoryCount(ctx: LocationContext, category: string): number {
  return ctx.civic
    .filter((g) => g.category === category)
    .reduce((n, g) => n + g.nearby.length, 0);
}

/**
 * Deterministic demand-pressure model. Starts from a time-of-day baseline and
 * nudges up/down per signal, collecting human-readable drivers along the way.
 */
function heuristicForecast(ctx: LocationContext): {
  score: number;
  drivers: ForecastDriver[];
  windows: ForecastWindow[];
} {
  const drivers: ForecastDriver[] = [];
  const now = new Date();
  // Toronto local hour (server may be UTC); approximate with -5/-4 offset.
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/Toronto",
    }).format(now),
  );
  const day = new Intl.DateTimeFormat("en-CA", {
    weekday: "short",
    timeZone: "America/Toronto",
  }).format(now);
  const isWeekend = day === "Sat" || day === "Sun";

  // --- Time-of-day baseline (meal rushes drive most foot traffic) ---
  let score = 0.3;
  const lunch = hour >= 11 && hour <= 14;
  const dinner = hour >= 17 && hour <= 20;
  const morning = hour >= 7 && hour <= 10;
  if (lunch) {
    score += 0.18;
    drivers.push({ signal: "Lunch rush", impact: "up", detail: "Midday meal window (11:00–14:00)." });
  } else if (dinner) {
    score += 0.2;
    drivers.push({ signal: "Dinner rush", impact: "up", detail: "Evening meal window (17:00–20:00)." });
  } else if (morning) {
    score += 0.1;
    drivers.push({ signal: "Morning commute", impact: "up", detail: "AM coffee/commute window." });
  } else if (hour >= 0 && hour <= 5) {
    score -= 0.12;
    drivers.push({ signal: "Overnight lull", impact: "down", detail: "Low ambient demand overnight." });
  }
  if (isWeekend) {
    score += 0.05;
    drivers.push({ signal: "Weekend", impact: "up", detail: `${day}: higher discretionary foot traffic.` });
  }

  // --- Events nearby: strong demand magnet ---
  const events = categoryCount(ctx, "event");
  if (events > 0) {
    const bump = Math.min(0.22, 0.07 * events);
    score += bump;
    drivers.push({
      signal: "Nearby events",
      impact: "up",
      detail: `${events} event${events > 1 ? "s" : ""} in range pulling crowds.`,
    });
  }

  // --- Inbound flights (aviation, area-wide): tourism / arrivals pressure ---
  const flights = categoryCount(ctx, "aviation");
  if (flights > 0) {
    const bump = Math.min(0.1, 0.012 * flights);
    score += bump;
    drivers.push({
      signal: "Air arrivals",
      impact: "up",
      detail: `${flights} aircraft tracked near the city — inbound visitor demand.`,
    });
  }

  // --- Weather: rain suppresses walk-ins, extreme cold/heat too ---
  const w = ctx.weather.data as { temperatureC?: number; description?: string } | undefined;
  if (w?.description) {
    const desc = w.description.toLowerCase();
    const wet = /rain|drizzle|snow|storm|shower/.test(desc);
    if (wet) {
      score -= 0.12;
      drivers.push({ signal: "Wet weather", impact: "down", detail: `${w.description} — fewer walk-ins, more delivery.` });
    } else if (/clear|sun/.test(desc)) {
      score += 0.05;
      drivers.push({ signal: "Clear skies", impact: "up", detail: `${w.description} — favourable for foot traffic.` });
    }
    if (typeof w.temperatureC === "number") {
      if (w.temperatureC <= -10 || w.temperatureC >= 32) {
        score -= 0.08;
        drivers.push({
          signal: "Temperature extreme",
          impact: "down",
          detail: `${w.temperatureC}°C suppresses outdoor movement.`,
        });
      }
    }
  }

  // --- Construction friction: harder access dampens spontaneous visits ---
  const construction = categoryCount(ctx, "construction");
  if (construction > 0) {
    score -= Math.min(0.1, 0.03 * construction);
    drivers.push({
      signal: "Construction nearby",
      impact: "down",
      detail: `${construction} work zone${construction > 1 ? "s" : ""} adding access friction.`,
    });
  }

  // --- Transit access: more service = easier arrivals ---
  const transit = categoryCount(ctx, "transit");
  if (transit > 0) {
    score += Math.min(0.08, 0.02 * transit);
    drivers.push({
      signal: "Transit access",
      impact: "up",
      detail: `${transit} transit signal${transit > 1 ? "s" : ""} nearby easing arrivals.`,
    });
  }

  // --- Safety/alerts: dampen demand ---
  const alerts = categoryCount(ctx, "alert") + categoryCount(ctx, "safety");
  if (alerts > 0) {
    score -= Math.min(0.1, 0.03 * alerts);
    drivers.push({
      signal: "Safety alerts",
      impact: "down",
      detail: `${alerts} active alert${alerts > 1 ? "s" : ""} in the area.`,
    });
  }

  score = clamp01(score);

  // --- Project the next few windows from the same baseline ---
  const windows = projectWindows(hour, score, { lunch, dinner });

  return { score, drivers, windows };
}

function projectWindows(
  hour: number,
  baseScore: number,
  flags: { lunch: boolean; dinner: boolean },
): ForecastWindow[] {
  const make = (label: string, delta: number, note: string): ForecastWindow => {
    const s = clamp01(baseScore + delta);
    return { label, level: levelFromScore(s), note };
  };
  const windows: ForecastWindow[] = [];
  // Next 2h
  windows.push(make("Next 2h", 0, "Carrying the current demand trend."));
  // Approaching meal rush?
  if (hour < 11) {
    windows.push(make("Lunch (11–14)", 0.18, "Midday meal surge approaching."));
  } else if (hour < 17) {
    windows.push(make("Dinner (17–20)", 0.2, "Evening meal surge approaching."));
  } else if (hour < 22) {
    windows.push(make("Late evening", -0.12, "Demand tapering after dinner."));
  } else {
    windows.push(make("Overnight", -0.2, "Low ambient demand overnight."));
  }
  windows.push(make("Tomorrow AM", flags.dinner ? -0.05 : 0.05, "Commute-window baseline."));
  return windows;
}

function defaultActions(level: DemandLevel, drivers: ForecastDriver[]): string[] {
  const down = drivers.filter((d) => d.impact === "down").map((d) => d.signal.toLowerCase());
  const actions: string[] = [];
  switch (level) {
    case "surge":
      actions.push("Add floor/kitchen staff for the next window.");
      actions.push("Pre-stock fast-moving items; prep ahead of the rush.");
      break;
    case "elevated":
      actions.push("Schedule one extra hand for peak coverage.");
      actions.push("Stage popular items near the front to speed service.");
      break;
    case "moderate":
      actions.push("Hold current staffing; watch the next window for upgrades.");
      break;
    case "low":
      actions.push("Run a slow-period promo or tackle prep/cleaning.");
      actions.push("Consider trimming a shift if the lull holds.");
      break;
  }
  if (down.some((d) => d.includes("wet") || d.includes("weather"))) {
    actions.push("Lean into delivery/pickup — push it on your channels.");
  }
  if (down.some((d) => d.includes("construction"))) {
    actions.push("Post clear access/parking guidance to offset construction friction.");
  }
  return actions;
}

export function buildHeuristic(ctx: LocationContext): Omit<DemandForecast, "provider" | "model" | "contextUsed"> {
  const { score, drivers, windows } = heuristicForecast(ctx);
  const level = levelFromScore(score);
  const top = drivers[0]?.signal ?? "current conditions";
  const headline =
    level === "surge"
      ? `Surge expected — driven by ${top.toLowerCase()}.`
      : level === "elevated"
        ? `Elevated demand building — ${top.toLowerCase()} in play.`
        : level === "moderate"
          ? `Steady, moderate demand near you.`
          : `Quiet stretch — demand running low.`;
  return {
    generatedAt: new Date().toISOString(),
    method: "heuristic",
    horizonHours: 12,
    level,
    score: Number(score.toFixed(2)),
    headline,
    drivers,
    windows,
    actions: defaultActions(level, drivers),
  };
}

/** Compact signal digest the LLM reasons over (and that we also log for datasets). */
export function signalDigest(ctx: LocationContext): Record<string, unknown> {
  return {
    now: ctx.now,
    localHour: ctx.now.hour,
    weather: ctx.weather.data,
    airQuality: ctx.airQuality.data,
    counts: {
      events: categoryCount(ctx, "event"),
      aviation: categoryCount(ctx, "aviation"),
      construction: categoryCount(ctx, "construction"),
      transit: categoryCount(ctx, "transit"),
      alerts: categoryCount(ctx, "alert") + categoryCount(ctx, "safety"),
      bikeshare: groupCount(ctx, "bikeshare"),
      parking: categoryCount(ctx, "parking"),
      permits: categoryCount(ctx, "permit") + categoryCount(ctx, "business"),
    },
    highlights: ctx.highlights,
  };
}

export function llmPrompt(ctx: LocationContext, business?: BusinessProfile): string {
  const digest = signalDigest(ctx);
  const patterns = findSimilarMoments(ctx, 8);
  const patternBlock = historicalPatternBlock(patterns);
  const n = ctx.now;
  const who = business
    ? `${business.name}, a ${business.businessType} (${business.headcount} staff) at ${business.address}${business.neighbourhood ? `, ${business.neighbourhood}` : ""}.`
    : "a Toronto small business at the given location.";
  return [
    "You are a Toronto demand-forecasting model for small businesses.",
    `Business: ${who}`,
    `Right now: ${n.weekday} ${n.date}, ${n.time} Toronto time (${n.partOfDay}, ${n.season}, ${n.isWeekend ? "weekend" : "weekday"}).`,
    "Reason over the live signals AND historical patterns below to forecast demand for the next ~12 hours.",
    "Translate each signal into business impact: weather → walk-ins vs delivery, events/transit → crowd timing,",
    "construction/alerts → access friction, air quality → outdoor/patio viability. Tailor actions to the business type.",
    "",
    "LIVE SIGNALS (JSON):",
    JSON.stringify(digest, null, 2),
    "",
    patternBlock,
    "",
    "Return ONLY a JSON object, no prose, with this exact shape:",
    `{
  "score": <0..1 demand pressure>,
  "level": "low" | "moderate" | "elevated" | "surge",
  "headline": "<one tight sentence>",
  "drivers": [{"signal": "<short>", "impact": "up" | "down", "detail": "<why>"}],
  "windows": [{"label": "<e.g. Lunch (11-14)>", "level": "<level>", "note": "<short>"}],
  "actions": ["<concrete owner action>"]
}`,
    "3-5 drivers, 3 windows, 2-4 actions. If historical patterns are present, factor them into score and headline.",
  ].filter(Boolean).join("\n");
}

function parseLlmForecast(text: string): Partial<DemandForecast> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (typeof obj !== "object" || obj == null) return null;
    return obj as Partial<DemandForecast>;
  } catch {
    return null;
  }
}

async function forecastFromContext(
  ctx: LocationContext,
  business: BusinessProfile | undefined,
  radiusM: number,
): Promise<DemandForecast> {
  const base = buildHeuristic(ctx);
  const contextUsed = {
    name: business?.name ?? ctx.scope.name,
    businessType: business?.businessType ?? ctx.scope.businessType,
    radiusM,
    highlights: ctx.highlights,
  };
  const provider = activeProvider();

  if (provider === "mock") {
    return { ...base, provider, model: "rule-based", contextUsed };
  }

  // Real provider available — ask it to reason, but never trust it blindly.
  try {
    const result = await chat(
      [
        { role: "system", content: "You output strict JSON. No markdown, no commentary." },
        { role: "user", content: llmPrompt(ctx, business) },
      ],
      { reasoning: false, temperature: 0.2, maxTokens: 900 },
    );
    const parsed = parseLlmForecast(result.text);
    if (parsed && typeof parsed.score === "number") {
      const score = clamp01(parsed.score);
      const level = (parsed.level as DemandLevel) ?? levelFromScore(score);
      return {
        ...base,
        method: "llm",
        provider: result.provider,
        model: result.model,
        score: Number(score.toFixed(2)),
        level,
        headline: parsed.headline ?? base.headline,
        drivers: Array.isArray(parsed.drivers) && parsed.drivers.length ? parsed.drivers : base.drivers,
        windows: Array.isArray(parsed.windows) && parsed.windows.length ? parsed.windows : base.windows,
        actions: Array.isArray(parsed.actions) && parsed.actions.length ? parsed.actions : base.actions,
        contextUsed,
      };
    }
    // Parse failed — heuristic but credit the provider that was tried.
    return { ...base, provider: result.provider, model: result.model, contextUsed };
  } catch {
    return { ...base, provider, model: "fallback", contextUsed };
  }
}

// ============================================================================
// WEEK-AHEAD FORECAST (7 days / 168h)
// ----------------------------------------------------------------------------
// The future cannot be measured, so a week-ahead forecast can only stand on
// signals that are themselves future-valid:
//   • forecasted weather  — Open-Meteo 7-day hourly (no key)
//   • calendar + holidays — deterministic (Ontario statutory days)
//   • scheduled events    — sports/concerts carry real future start dates
//   • structural friction — construction zones & transit access persist all week
// Transient "now" signals (live flights, 311 spikes) are NOT projected forward.
// ============================================================================

interface HourFeatures {
  hour: number;
  isWeekend: boolean;
  isHoliday: boolean;
  temperatureC?: number;
  wet: boolean;
  events: number;
  construction: number;
  transit: number;
}

/** Pure unit model: features for one hour -> demand pressure + drivers. */
function scoreHour(f: HourFeatures): { score: number; drivers: ForecastDriver[] } {
  const drivers: ForecastDriver[] = [];
  let score = 0.3;

  const lunch = f.hour >= 11 && f.hour <= 14;
  const dinner = f.hour >= 17 && f.hour <= 20;
  const morning = f.hour >= 7 && f.hour <= 10;
  if (lunch) {
    score += 0.18;
    drivers.push({ signal: "Lunch rush", impact: "up", detail: "Midday meal window (11:00–14:00)." });
  } else if (dinner) {
    score += 0.2;
    drivers.push({ signal: "Dinner rush", impact: "up", detail: "Evening meal window (17:00–20:00)." });
  } else if (morning) {
    score += 0.1;
    drivers.push({ signal: "Morning commute", impact: "up", detail: "AM coffee/commute window." });
  } else if (f.hour >= 0 && f.hour <= 5) {
    score -= 0.12;
    drivers.push({ signal: "Overnight lull", impact: "down", detail: "Low ambient demand overnight." });
  }

  if (f.isHoliday) {
    score += 0.06;
    drivers.push({ signal: "Holiday", impact: "up", detail: "Statutory holiday — discretionary foot traffic." });
  } else if (f.isWeekend) {
    score += 0.05;
    drivers.push({ signal: "Weekend", impact: "up", detail: "Higher discretionary foot traffic." });
  }

  if (f.events > 0) {
    const bump = Math.min(0.22, 0.07 * f.events);
    score += bump;
    drivers.push({
      signal: "Scheduled events",
      impact: "up",
      detail: `${f.events} event${f.events > 1 ? "s" : ""} booked nearby that day.`,
    });
  }

  if (f.wet) {
    score -= 0.12;
    drivers.push({ signal: "Wet weather", impact: "down", detail: "Forecast rain/snow — fewer walk-ins, more delivery." });
  }
  if (typeof f.temperatureC === "number" && (f.temperatureC <= -10 || f.temperatureC >= 32)) {
    score -= 0.08;
    drivers.push({
      signal: "Temperature extreme",
      impact: "down",
      detail: `${f.temperatureC}°C forecast suppresses outdoor movement.`,
    });
  }

  if (f.construction > 0) {
    score -= Math.min(0.1, 0.03 * f.construction);
    drivers.push({
      signal: "Construction nearby",
      impact: "down",
      detail: `${f.construction} work zone${f.construction > 1 ? "s" : ""} adding access friction.`,
    });
  }
  if (f.transit > 0) {
    score += Math.min(0.08, 0.02 * f.transit);
    drivers.push({
      signal: "Transit access",
      impact: "up",
      detail: `${f.transit} transit signal${f.transit > 1 ? "s" : ""} nearby easing arrivals.`,
    });
  }

  return { score: clamp01(score), drivers };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Gauss computus — Gregorian Easter Sunday for a year. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Nth weekday (0=Sun) of a month -> "YYYY-MM-DD". */
function nthWeekday(year: number, month1: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay();
  const day = 1 + ((7 + weekday - first) % 7) + (n - 1) * 7;
  return `${year}-${pad(month1)}-${pad(day)}`;
}

/** Ontario statutory holidays for a year as date -> name. */
function ontarioHolidays(year: number): Map<string, string> {
  const m = new Map<string, string>();
  m.set(`${year}-01-01`, "New Year's Day");
  m.set(nthWeekday(year, 2, 1, 3), "Family Day");
  const easter = easterSunday(year);
  const gf = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  m.set(`${gf.getUTCFullYear()}-${pad(gf.getUTCMonth() + 1)}-${pad(gf.getUTCDate())}`, "Good Friday");
  const may24 = new Date(Date.UTC(year, 4, 24)).getUTCDay();
  const vicDay = 24 - ((may24 + 6) % 7);
  m.set(`${year}-05-${pad(vicDay)}`, "Victoria Day");
  m.set(`${year}-07-01`, "Canada Day");
  m.set(nthWeekday(year, 8, 1, 1), "Civic Holiday");
  m.set(nthWeekday(year, 9, 1, 1), "Labour Day");
  m.set(nthWeekday(year, 10, 1, 2), "Thanksgiving");
  m.set(`${year}-12-25`, "Christmas Day");
  m.set(`${year}-12-26`, "Boxing Day");
  return m;
}

/** Map a record's meta.start ISO datetime to a Toronto YYYY-MM-DD, or null. */
function eventDate(rec: CivicRecord): string | null {
  const start = rec.meta?.start;
  if (typeof start !== "string") return null;
  const t = new Date(start);
  if (Number.isNaN(t.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(t);
}

function peakWindowLabel(hour: number): string {
  const end = Math.min(23, hour + 2);
  return `${pad(hour)}:00–${pad(end)}:00`;
}

function mode(arr: string[]): string | undefined {
  if (arr.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const s of arr) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function weekHeadline(days: ForecastDay[]): string {
  if (days.length === 0) return "Week ahead: not enough signal to forecast.";
  const busiest = [...days].sort((a, b) => b.peakScore - a.peakScore)[0];
  const quietest = [...days].sort((a, b) => a.avgScore - b.avgScore)[0];
  const parts = [`Busiest: ${busiest.dayName} ${busiest.peakWindow} (${busiest.peakLevel}).`];
  if (quietest.date !== busiest.date) parts.push(`Quietest: ${quietest.dayName}.`);
  const surge = days.filter((d) => d.peakLevel === "surge" || d.peakLevel === "elevated").length;
  if (surge > 0) parts.push(`${surge} day${surge > 1 ? "s" : ""} with elevated+ peaks.`);
  return parts.join(" ");
}

/**
 * Build a 7-day / 168h demand forecast. Heuristic-only by design: a week ahead
 * is a structural projection over future-valid signals, not an LLM guess.
 */
export async function weekForecast(
  point: GeoPoint,
  ctx: LocationContext,
  meta: { name?: string; businessType?: string; radiusM: number },
): Promise<WeeklyForecast> {
  const wx = await getWeatherForecast(point);
  const hours = wx.data;

  const wxByDay = new Map<string, Map<number, WeatherHour>>();
  for (const h of hours) {
    const date = h.time.slice(0, 10);
    const hr = Number(h.time.slice(11, 13));
    if (!wxByDay.has(date)) wxByDay.set(date, new Map());
    wxByDay.get(date)!.set(hr, h);
  }

  // Day list derived from the forecast (DST-safe); synthesize 7 days if absent.
  let dates: string[];
  if (wxByDay.size > 0) {
    dates = [...wxByDay.keys()].sort().slice(0, 7);
  } else {
    const todayStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const anchor = new Date(`${todayStr}T12:00:00Z`);
    dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(anchor.getTime() + i * 86400000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    });
  }

  // Structural friction persists across the whole week.
  const construction = categoryCount(ctx, "construction");
  const transit = categoryCount(ctx, "transit");

  // Bucket scheduled events by Toronto day.
  const eventGroup = ctx.civic.find((g) => g.category === "event");
  const eventsByDay = new Map<string, number>();
  for (const rec of eventGroup?.nearby ?? []) {
    const d = eventDate(rec);
    if (d) eventsByDay.set(d, (eventsByDay.get(d) ?? 0) + 1);
  }

  const holidays = new Map<string, string>();
  for (const y of new Set(dates.map((d) => Number(d.slice(0, 4))))) {
    for (const [k, v] of ontarioHolidays(y)) holidays.set(k, v);
  }

  const days: ForecastDay[] = dates.map((date) => {
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const dayName = WEEKDAYS[dow];
    const isWeekend = dow === 0 || dow === 6;
    const holidayName = holidays.get(date);
    const isHoliday = holidayName != null;
    const dayWx = wxByDay.get(date);
    const eventsToday = eventsByDay.get(date) ?? 0;

    let peakScore = 0;
    let peakHour = 12;
    let sum = 0;
    let peakDrivers: ForecastDriver[] = [];
    let hi = -Infinity;
    let lo = Infinity;
    const descSamples: string[] = [];

    for (let hr = 0; hr < 24; hr++) {
      const w = dayWx?.get(hr);
      if (w) {
        hi = Math.max(hi, w.temperatureC);
        lo = Math.min(lo, w.temperatureC);
        if (hr >= 9 && hr <= 21) descSamples.push(w.description);
      }
      const wet =
        w != null && (w.precipitationMm > 0.2 || /rain|drizzle|snow|storm|shower/i.test(w.description));
      const { score, drivers } = scoreHour({
        hour: hr,
        isWeekend,
        isHoliday,
        temperatureC: w?.temperatureC,
        wet,
        events: eventsToday,
        construction,
        transit,
      });
      sum += score;
      if (score > peakScore) {
        peakScore = score;
        peakHour = hr;
        peakDrivers = drivers;
      }
    }

    const avgScore = sum / 24;
    const note = dayWx
      ? `Weather + calendar${eventsToday ? " + events" : ""}${construction || transit ? " + structural access" : ""}.`
      : "Calendar baseline only (no weather forecast available).";

    return {
      date,
      dayName,
      isWeekend,
      isHoliday,
      holidayName,
      peakScore: Number(peakScore.toFixed(2)),
      peakLevel: levelFromScore(peakScore),
      peakWindow: peakWindowLabel(peakHour),
      avgScore: Number(avgScore.toFixed(2)),
      avgLevel: levelFromScore(avgScore),
      highTempC: hi === -Infinity ? undefined : hi,
      lowTempC: lo === Infinity ? undefined : lo,
      weather: mode(descSamples),
      events: eventsToday,
      drivers: peakDrivers.slice(0, 4),
      note,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    provider: activeProvider(),
    model: "structural-heuristic",
    method: "heuristic",
    horizonHours: 168,
    headline: weekHeadline(days),
    days,
    weatherStatus: wx.status,
    basis:
      "Future-valid signals only: forecasted weather (Open-Meteo), Ontario calendar/holidays, scheduled events, and persistent construction/transit access. Live transient signals are not projected past today.",
    contextUsed: {
      name: meta.name ?? ctx.scope.name,
      businessType: meta.businessType ?? ctx.scope.businessType,
      radiusM: meta.radiusM,
      structural: { construction, transit },
    },
  };
}

export async function weekForecastForBusiness(businessId: string, radiusM = 750): Promise<WeeklyForecast> {
  const business = businesses.get(businessId);
  if (!business) throw new Error("business not found");
  const ctx = await buildContext(scopeFromBusiness(business, radiusM));
  return weekForecast(
    { lon: business.lon, lat: business.lat },
    ctx,
    { name: business.name, businessType: business.businessType, radiusM },
  );
}

export async function weekForecastForPoint(
  lon: number,
  lat: number,
  opts: { radiusM?: number; businessType?: string } = {},
): Promise<WeeklyForecast> {
  const radiusM = opts.radiusM ?? 750;
  const ctx = await buildContext({ point: { lon, lat }, radiusM, businessType: opts.businessType });
  return weekForecast({ lon, lat }, ctx, { businessType: opts.businessType, radiusM });
}

export async function forecastForBusiness(businessId: string, radiusM = 750): Promise<DemandForecast> {
  const business = businesses.get(businessId);
  if (!business) throw new Error("business not found");
  const ctx = await buildContext(scopeFromBusiness(business, radiusM));
  return forecastFromContext(ctx, business, radiusM);
}

export async function forecastForPoint(
  lon: number,
  lat: number,
  opts: { radiusM?: number; businessType?: string } = {},
): Promise<DemandForecast> {
  const radiusM = opts.radiusM ?? 750;
  const ctx = await buildContext({ point: { lon, lat }, radiusM, businessType: opts.businessType });
  return forecastFromContext(ctx, undefined, radiusM);
}
