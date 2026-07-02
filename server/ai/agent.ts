import { type LocationContext } from "./context.ts";
import {
  chat,
  warmNemotron,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type PreferredProvider,
} from "./provider.ts";
import { findSimilarMoments, historicalPatternBlock } from "./patterns.ts";
import { loadAgentContextBundle } from "./agent-cache.ts";
import { mlWeeklyProfile, type MLWeeklyProfile } from "./mlforecast.ts";
import { businesses } from "../db.ts";
import type { BusinessProfile } from "../types.ts";

export interface AgentAnswer extends ChatResult {
  contextUsed: {
    name?: string;
    businessType?: string;
    radiusM: number;
    highlights: string[];
  };
}

export interface AgentRequest {
  messages: ChatMessage[];
  opts: ChatOptions;
  gradientUsed: boolean;
  contextUsed: AgentAnswer["contextUsed"];
}

export type AgentMode = "nemotron-ml" | "claude" | "ml";

/** Fewer civic rows + patterns → smaller prompts, faster inference. */
const CIVIC_ROWS = 4;
const PATTERN_COUNT = 5;
const HIGHLIGHT_ROWS = 8;

function systemPrompt(
  ctx: LocationContext,
  business?: BusinessProfile,
  bizHistoryBlock = "",
  extras: { researchBlock?: string; weekBlock?: string; mlBlock?: string } = {},
): string {
  const profileBlock = business
    ? `<BUSINESS>${business.name} — a ${business.businessType} with ${business.headcount} staff at ${business.address}${business.neighbourhood ? ` (${business.neighbourhood})` : ""}.${business.notes ? ` Notes: ${business.notes}` : ""}</BUSINESS>`
    : "";

  const civicBlock = ctx.civic
    .filter((g) => g.nearby.length > 0)
    .map((g) => {
      const items = g.nearby
        .slice(0, CIVIC_ROWS)
        .map((r) => `  - ${r.title}${r.detail ? ` (${r.detail})` : ""}${r.distanceM != null ? ` ~${r.distanceM}m` : ""}`)
        .join("\n");
      return `${g.label} [${g.status}]:\n${items}`;
    })
    .join("\n\n");

  const patterns = findSimilarMoments(ctx, PATTERN_COUNT);
  const patternBlock = historicalPatternBlock(patterns);

  const n = ctx.now;
  const nowBlock =
    `<NOW>It is ${n.weekday} ${n.date}, ${n.time} Toronto time — ${n.partOfDay}, ${n.season}, ${n.isWeekend ? "weekend" : "weekday"}. ` +
    `Anchor every recommendation to this moment: distinguish "right now / next few hours" from "later today", "tonight", and "this week".</NOW>`;

  const highlights = ctx.highlights.slice(0, HIGHLIGHT_ROWS);

  return [
    "You are a custom local-intelligence agent for a Toronto small-business owner.",
    "You have access to FOUR layers of intelligence:",
    "  1. STREET_RESEARCH — cached briefing from the web agent (Toronto open data, traffic, neighbourhood)",
    "  2. LIVE Toronto civic data (weather, transit, events, construction) around their location",
    "  3. HISTORICAL city signal patterns — similar moments from the past 90 days",
    "  4. THE OWNER'S OWN business data — revenue, customers, staff schedule, and WEEK_FORECAST",
    "  5. ML DEMAND MODEL — CityFlow gradient-boosting model trained on Toronto demand simulation",
    "Answer ONLY from the data provided. Be concrete and actionable:",
    "  - Always ground timing in <NOW>: say WHEN to act (e.g. 'before the 17:00 dinner window'), not just what.",
    "  - Tie city signals to business impact (foot traffic, deliveries, staffing, revenue opportunities)",
    "  - Translate raw numbers into action: weather (rain/snow/heat → patio, delivery push, walk-in dip),",
    "    air quality (high AQI → caution on patio/outdoor seating), events & transit → expected crowd timing.",
    "  - When HISTORICAL_PATTERNS are present, cite: 'Based on N similar past moments...'",
    "  - When BUSINESS_HISTORY is present, compare upcoming schedule against forecast demand.",
    "    Explicitly flag under-staffing: 'Your forecast shows SURGE demand Friday 6–9pm but you have X staff scheduled.'",
    "    Explicitly flag over-staffing: 'Tuesday afternoon is historically slow — you may be over-scheduled.'",
    "  - When the owner asks about revenue or customers, use their actual numbers, not generic estimates.",
    "If data is marked [demo], note it may be placeholder. Cite distances when relevant.",
    "Format the answer so it is easy to skim: a short headline, then concise bullets, then an action or recommendation line.",
    "",
    nowBlock,
    profileBlock,
    extras.researchBlock ?? "",
    extras.weekBlock ?? "",
    extras.mlBlock ?? "",
    bizHistoryBlock,
    `<HIGHLIGHTS>\n${highlights.map((h) => `- ${h}`).join("\n")}\n</HIGHLIGHTS>`,
    "",
    patternBlock,
    "",
    "LIVE NEARBY DATA:",
    civicBlock || "(no nearby civic records)",
    "",
    `Weather: ${JSON.stringify(ctx.weather.data)}`,
    `Air quality: ${JSON.stringify(ctx.airQuality.data)}`,
  ].filter(Boolean).join("\n");
}

export async function buildBusinessAgentRequest(
  businessId: string,
  question: string,
  radiusM = 750,
  opts: { useGradient?: boolean; preferredProvider?: PreferredProvider } = {},
): Promise<AgentRequest> {
  const useGradient = opts.useGradient ?? true;
  const business = businesses.get(businessId);
  if (!business) throw new Error("business not found");

  const { ctx, researchBlock, weekBlock, mlBlock, histBlock, gradientUsed } =
    await loadAgentContextBundle(business, radiusM, useGradient);

  const mlBlockWithHint =
    mlBlock
      ? `${mlBlock}\nGROUND your staffing/timing numbers in the ML_DEMAND_MODEL above when it is present.`
      : "";

  return {
    messages: [
      {
        role: "system",
        content: systemPrompt(ctx, business, histBlock, {
          researchBlock,
          weekBlock,
          mlBlock: mlBlockWithHint,
        }),
      },
      { role: "user", content: question },
    ],
    opts: { reasoning: false, maxTokens: 1536 },
    gradientUsed,
    contextUsed: {
      name: business.name,
      businessType: business.businessType,
      radiusM,
      highlights: ctx.highlights.slice(0, HIGHLIGHT_ROWS),
    },
  };
}

export async function askForBusiness(
  businessId: string,
  question: string,
  radiusM = 750,
  opts: { useGradient?: boolean; preferredProvider?: PreferredProvider } = {},
): Promise<AgentAnswer> {
  const preferred = opts.preferredProvider;
  if (preferred === "nemotron") await warmNemotron();
  const { messages, opts: chatOpts, contextUsed } = await buildBusinessAgentRequest(
    businessId,
    question,
    radiusM,
    opts,
  );
  const result = await chat(messages, chatOpts, preferred, true);
  return { ...result, contextUsed };
}

const DOW_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Current Toronto hour (0-23) and ML day-of-week (Mon=0..Sun=6). */
function torontoNow(): { hour: number; mlDow: number } {
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", { hour: "numeric", hour12: false, timeZone: "America/Toronto" }).format(new Date()),
  ) % 24;
  const jsDay = new Date(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date()),
  ).getDay();
  return { hour, mlDow: (jsDay + 6) % 7 };
}

/** Format the raw ML demand grid into a readable answer — no LLM interpretation. */
function formatMlOnlyAnswer(business: BusinessProfile, profile: MLWeeklyProfile): string {
  const { grid, model, archetype } = profile;
  const peakMax = Math.max(...grid.flat(), 1);
  const { hour, mlDow } = torontoNow();
  const todayRow = grid[mlDow] ?? [];
  const pct = (v: number) => Math.round((v / peakMax) * 100);

  const nowVal = Math.round(todayRow[hour] ?? 0);
  const todayPeakH = todayRow.length ? todayRow.indexOf(Math.max(...todayRow)) : 0;
  const todayPeakV = Math.round(todayRow[todayPeakH] ?? 0);

  const nextHours: string[] = [];
  for (let h = hour; h < Math.min(hour + 6, 24); h++) {
    const v = todayRow[h] ?? 0;
    nextHours.push(`  ${String(h).padStart(2, "0")}:00 — ~${Math.round(v)} customers/hr (${pct(v)}% of peak)`);
  }

  const weekLines = grid.map((row, d) => {
    const ph = row.indexOf(Math.max(...row));
    const pv = Math.round(row[ph] ?? 0);
    const avg = Math.round(row.reduce((a, b) => a + b, 0) / 24);
    return `  ${DOW_FULL[d]}: peak ${String(ph).padStart(2, "0")}:00 (~${pv}/hr), avg ~${avg}/hr${d === mlDow ? "  ← today" : ""}`;
  });

  return [
    `CityFlow ML demand model — ${business.businessType} (${archetype} archetype, ${model === "ml" ? "gradient-boosting" : "heuristic"} model)`,
    "",
    `Right now (${DOW_FULL[mlDow]} ${String(hour).padStart(2, "0")}:00): ~${nowVal} customers/hr — ${pct(todayRow[hour] ?? 0)}% of the weekly peak (${Math.round(peakMax)}/hr).`,
    `Today's peak: ${String(todayPeakH).padStart(2, "0")}:00 (~${todayPeakV} customers/hr).`,
    "",
    "Next hours today:",
    ...nextHours,
    "",
    "Weekly demand peaks:",
    ...weekLines,
    "",
    "Raw ML forecast — no language-model interpretation applied.",
  ].join("\n");
}

/** ML-only answer: the raw gradient demand model, bypassing every LLM. */
export async function mlOnlyAnswer(businessId: string, radiusM = 750): Promise<AgentAnswer> {
  const business = businesses.get(businessId);
  if (!business) throw new Error("business not found");
  const profile = await mlWeeklyProfile(business.businessType).catch(() => null);
  if (!profile) throw new Error("ML demand model unavailable");
  return {
    text: formatMlOnlyAnswer(business, profile),
    provider: "ml",
    model: `cityflow-${profile.model}`,
    contextUsed: { name: business.name, businessType: business.businessType, radiusM, highlights: [] },
  };
}

export async function askForPoint(
  lon: number,
  lat: number,
  question: string,
  opts: { radiusM?: number; businessType?: string } = {},
): Promise<AgentAnswer> {
  const radiusM = opts.radiusM ?? 750;
  const { buildContext } = await import("./context.ts");
  const ctx = await buildContext({ point: { lon, lat }, radiusM, businessType: opts.businessType });
  const result = await chat([
    { role: "system", content: systemPrompt(ctx) },
    { role: "user", content: question },
  ]);
  return {
    ...result,
    contextUsed: { businessType: opts.businessType, radiusM, highlights: ctx.highlights.slice(0, HIGHLIGHT_ROWS) },
  };
}
