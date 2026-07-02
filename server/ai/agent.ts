import { buildContext, scopeFromBusiness, type LocationContext } from "./context.ts";
import { chat, type ChatMessage, type ChatOptions, type ChatResult, type PreferredProvider } from "./provider.ts";
import { findSimilarMoments, historicalPatternBlock } from "./patterns.ts";
import { businessHistoryBlock } from "./bizdata.ts";
import { weekForecastForBusiness } from "./forecast.ts";
import { getResearchBlock } from "./web-agent.ts";
import { mlWeeklyProfile } from "./mlforecast.ts";
import { businesses, businessHistory, businessSchedule } from "../db.ts";
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

export type AgentMode = "nemotron-ml" | "claude";

function weekForecastBlock(businessId: string, week: Awaited<ReturnType<typeof weekForecastForBusiness>>): string {
  const dayLines = week.days
    .slice(0, 7)
    .map((d) => `  ${d.dayName} (${d.date}): peak ${d.peakWindow} [${d.peakLevel}], avg ${d.avgLevel}${d.events ? `, ${d.events} events` : ""}`);
  return [
    "<WEEK_FORECAST>",
    week.headline,
    ...dayLines,
    `Basis: ${week.basis}`,
    "</WEEK_FORECAST>",
  ].join("\n");
}

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
        .slice(0, 8)
        .map((r) => `  - ${r.title}${r.detail ? ` (${r.detail})` : ""}${r.distanceM != null ? ` ~${r.distanceM}m` : ""}`)
        .join("\n");
      return `${g.label} [${g.status}]:\n${items}`;
    })
    .join("\n\n");

  const patterns = findSimilarMoments(ctx, 12);
  const patternBlock = historicalPatternBlock(patterns);

  const n = ctx.now;
  const nowBlock =
    `<NOW>It is ${n.weekday} ${n.date}, ${n.time} Toronto time — ${n.partOfDay}, ${n.season}, ${n.isWeekend ? "weekend" : "weekday"}. ` +
    `Anchor every recommendation to this moment: distinguish "right now / next few hours" from "later today", "tonight", and "this week".</NOW>`;

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
    `<HIGHLIGHTS>\n${ctx.highlights.map((h) => `- ${h}`).join("\n")}\n</HIGHLIGHTS>`,
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

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function buildMlBlock(
  businessType: string,
  grid: number[][],
  model: string,
  archetype: string,
): string {
  const DOW = DOW_LABELS;
  const flat = grid.flat();
  const max = Math.max(...flat, 1);
  // Show peak hour per day
  const dayLines = grid.map((row, d) => {
    const peakH = row.indexOf(Math.max(...row));
    const peakV = Math.round(row[peakH]);
    const avgV  = Math.round(row.reduce((a, b) => a + b, 0) / 24);
    return `  ${DOW[d]}: peak ${String(peakH).padStart(2, "0")}:00 (~${peakV} customers), avg ~${avgV}/hr`;
  });
  return [
    `<ML_DEMAND_MODEL model="${model}" archetype="${archetype}" business_type="${businessType}">`,
    "Predicted customer counts from CityFlow gradient-boosting model (trained on Toronto demand simulation).",
    "Use this to anchor staffing and timing recommendations to data-driven peaks, not just intuition.",
    ...dayLines,
    `Peak fraction of max: this hour vs ${Math.round(max)} peak customers.`,
    "</ML_DEMAND_MODEL>",
  ].join("\n");
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
  const scope = scopeFromBusiness(business, radiusM);
  const [ctx, week, mlProfile] = await Promise.all([
    buildContext(scope),
    weekForecastForBusiness(businessId, radiusM),
    // Only consult the gradient demand model when the user opts into it.
    useGradient ? mlWeeklyProfile(business.businessType).catch(() => null) : Promise.resolve(null),
  ]);

  // Pull business's own history + upcoming schedule for the agent
  const summary   = businessHistory.summary(businessId);
  const upcoming  = businessSchedule.upcoming(businessId, 7);
  const histBlock = businessHistoryBlock(businessId, business.businessType, summary, upcoming);
  const researchBlock = getResearchBlock(businessId);
  const weekBlock = weekForecastBlock(businessId, week);
  const mlBlock =
    useGradient && mlProfile
      ? buildMlBlock(business.businessType, mlProfile.grid, mlProfile.model, mlProfile.archetype) +
        "\nGROUND your staffing/timing numbers in the ML_DEMAND_MODEL above when it is present."
      : "";

  return {
    messages: [
      { role: "system", content: systemPrompt(ctx, business, histBlock, { researchBlock, weekBlock, mlBlock }) },
      { role: "user", content: question },
    ],
    opts: { reasoning: false, maxTokens: 512 },
    gradientUsed: useGradient && !!mlProfile,
    contextUsed: {
      name: business.name,
      businessType: business.businessType,
      radiusM,
      highlights: ctx.highlights,
    },
  };
}

export async function askForBusiness(
  businessId: string,
  question: string,
  radiusM = 750,
  opts: { useGradient?: boolean; preferredProvider?: PreferredProvider } = {},
): Promise<AgentAnswer> {
  const { messages, opts: chatOpts, contextUsed } = await buildBusinessAgentRequest(businessId, question, radiusM, opts);
  const result = await chat(messages, chatOpts, opts.preferredProvider, false);
  return { ...result, contextUsed };
}

export async function askForPoint(
  lon: number,
  lat: number,
  question: string,
  opts: { radiusM?: number; businessType?: string } = {},
): Promise<AgentAnswer> {
  const radiusM = opts.radiusM ?? 750;
  const ctx = await buildContext({ point: { lon, lat }, radiusM, businessType: opts.businessType });
  const result = await chat([
    { role: "system", content: systemPrompt(ctx) },
    { role: "user", content: question },
  ]);
  return {
    ...result,
    contextUsed: { businessType: opts.businessType, radiusM, highlights: ctx.highlights },
  };
}
