import { CIVIC_SOURCES } from "./sources/civic.ts";
import { activeProvider } from "./ai/provider.ts";

/**
 * Machine-readable description of the API so external AI agents (or an MCP
 * bridge) can discover and call Toronto Monitor as a tool set.
 */
export function aiManifest() {
  return {
    schemaVersion: "v1",
    name: "Toronto Monitor",
    description:
      "Real-time City of Toronto civic intelligence, scoped to a business location. " +
      "Provides weather, air quality, road restrictions, 311, business licences, " +
      "building permits, and events, plus a grounded assistant for business owners.",
    llmProvider: activeProvider(),
    dataSources: CIVIC_SOURCES.map((s) => ({
      key: s.key,
      label: s.label,
      category: s.category,
      attribution: s.attribution,
    })),
    tools: [
      {
        name: "get_location_context",
        description:
          "Return a location-scoped digest (weather, air quality, and nearby civic records) for a point or saved business.",
        http: { method: "GET", path: "/api/context" },
        parameters: {
          businessId: "string (optional) — saved business id",
          lon: "number (optional) — longitude if no businessId",
          lat: "number (optional) — latitude if no businessId",
          radius: "number (optional, metres, default 750)",
          type: "string (optional) — business type hint",
        },
      },
      {
        name: "ask_business_agent",
        description:
          "Ask a natural-language question; answered grounded in Toronto data near the business/point.",
        http: { method: "POST", path: "/api/agent" },
        parameters: {
          question: "string (required)",
          businessId: "string (optional)",
          lon: "number (optional)",
          lat: "number (optional)",
          radiusM: "number (optional, default 750)",
        },
      },
      {
        name: "list_civic_records",
        description: "All geolocated civic records for map rendering.",
        http: { method: "GET", path: "/api/data/map" },
        parameters: {},
      },
      {
        name: "geocode_address",
        description: "Geocode a Toronto address to coordinates + neighbourhood.",
        http: { method: "GET", path: "/api/geocode" },
        parameters: { q: "string (required) — address" },
      },
    ],
  };
}
