import { buildContext, scopeFromBusiness, type LocationContext } from "./context.ts";
import { chat, type ChatResult } from "./provider.ts";
import { findSimilarMoments, historicalPatternBlock } from "./patterns.ts";
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

function systemPrompt(ctx: LocationContext, business?: BusinessProfile): string {
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

  return [
    "You are a local-intelligence assistant for a Toronto small-business owner.",
    "Answer ONLY from the Toronto data provided below. Be concrete and practical:",
    "tie observations to business impact (foot traffic, deliveries, staffing, safety, opportunities).",
    "When HISTORICAL_PATTERNS are provided, cite them explicitly: 'Based on N similar past moments...'",
    "If data is marked [demo], note it may be placeholder. Cite distances when relevant.",
    "Keep answers tight and actionable.",
    "",
    profileBlock,
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
  const result = await chat([
    { role: "system", content: systemPrompt(ctx, business) },
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
