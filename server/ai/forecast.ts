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
import { businesses } from "../db.ts";
import type { BusinessProfile } from "../types.ts";

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
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", { hour: "numeric", hour12: false, timeZone: "America/Toronto" }).format(new Date()),
  );
  return {
    localHour: hour,
    weather: ctx.weather.data,
    airQuality: ctx.airQuality.data,
    counts: {
      events: categoryCount(ctx, "event"),
      aviation: categoryCount(ctx, "aviation"),
      construction: categoryCount(ctx, "construction"),
      transit: categoryCount(ctx, "transit"),
      alerts: categoryCount(ctx, "alert") + categoryCount(ctx, "safety"),
      bikeshare: groupCount(ctx, "bikeshare"),
    },
    highlights: ctx.highlights,
  };
}

export function llmPrompt(ctx: LocationContext, business?: BusinessProfile): string {
  const digest = signalDigest(ctx);
  const who = business
    ? `${business.name}, a ${business.businessType} (${business.headcount} staff) at ${business.address}${business.neighbourhood ? `, ${business.neighbourhood}` : ""}.`
    : "a Toronto small business at the given location.";
  return [
    "You are a Toronto demand-forecasting model for small businesses.",
    `Business: ${who}`,
    "Reason over the live signals below and forecast customer demand for the next ~12 hours.",
    "",
    "SIGNALS (JSON):",
    JSON.stringify(digest, null, 2),
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
    "Keep it grounded strictly in the signals. 3-5 drivers, 3 windows, 2-4 actions.",
  ].join("\n");
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
