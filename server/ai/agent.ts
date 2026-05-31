import { buildContext, scopeFromBusiness, type LocationContext } from "./context.ts";
import { chat, type ChatResult } from "./provider.ts";
import { findSimilarMoments, historicalPatternBlock } from "./patterns.ts";
import { businessHistoryBlock } from "./bizdata.ts";
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

function systemPrompt(ctx: LocationContext, business?: BusinessProfile, bizHistoryBlock = ""): string {
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
    "You have access to THREE layers of intelligence:",
    "  1. LIVE Toronto civic data (weather, transit, events, construction) around their location",
    "  2. HISTORICAL city signal patterns — similar moments from the past 90 days",
    "  3. THE OWNER'S OWN business data — their actual revenue, customer counts, and staff schedule",
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
    "",
    nowBlock,
    profileBlock,
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

export async function askForBusiness(
  businessId: string,
  question: string,
  radiusM = 750,
): Promise<AgentAnswer> {
  const business = businesses.get(businessId);
  if (!business) throw new Error("business not found");
  const ctx = await buildContext(scopeFromBusiness(business, radiusM));

  // Pull business's own history + upcoming schedule for the agent
  const summary   = businessHistory.summary(businessId);
  const upcoming  = businessSchedule.upcoming(businessId, 7);
  const histBlock = businessHistoryBlock(businessId, business.businessType, summary, upcoming);

  const result = await chat([
    { role: "system", content: systemPrompt(ctx, business, histBlock) },
    { role: "user", content: question },
  ]);
  return {
    ...result,
    contextUsed: {
      name: business.name,
      businessType: business.businessType,
      radiusM,
      highlights: ctx.highlights,
    },
  };
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
