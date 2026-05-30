/**
 * Flight arrivals — inbound air traffic to Toronto (YYZ Pearson + YTZ Billy
 * Bishop) as a tourism / visitor-inflow signal.
 *
 * Provider-agnostic:
 *   - AVIATIONSTACK_KEY → aviationstack arrivals (scheduled flights, terminals)
 *   - (none)            → OpenSky live aircraft in the YYZ approach box (keyless,
 *                         best-effort) and, failing that, a small demo set.
 *
 * Arrivals are plotted at the airport (a single inflow point) so the agent and
 * flow model can reason about visitor surges; individual aircraft positions
 * from OpenSky are not mapped (too noisy) but counted in meta.
 */

import { cached, fetchJson, nowIso } from "../cache.ts";
import type { CivicRecord, SourceResult } from "../types.ts";

const YYZ = { lon: -79.6306, lat: 43.6777, name: "Toronto Pearson (YYZ)" };

export function aviationstackEnabled(): boolean {
  return Boolean(process.env.AVIATIONSTACK_KEY);
}

interface AviationstackFlight {
  flight_status?: string;
  arrival?: { airport?: string; scheduled?: string; terminal?: string; iata?: string };
  departure?: { airport?: string; iata?: string };
  airline?: { name?: string };
  flight?: { iata?: string };
}

async function viaAviationstack(): Promise<SourceResult<CivicRecord[]>> {
  const key = process.env.AVIATIONSTACK_KEY!;
  const url = `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(key)}&arr_iata=YYZ&flight_status=active&limit=40`;
  const res = await fetchJson<{ data?: AviationstackFlight[]; error?: { message?: string } }>(url, { timeoutMs: 9000 });
  if (res.error) {
    // e.g. usage_limit_reached on the free plan — signal caller to fall back.
    return { source: "flights", status: "demo", fetchedAt: nowIso(), note: `aviationstack: ${res.error.message ?? "unavailable"}`, data: [], attribution: "aviationstack — flight arrivals" };
  }
  const flights = res.data ?? [];
  const records: CivicRecord[] = flights.map((f, i) => ({
    id: `flight-${f.flight?.iata ?? i}`,
    category: "aviation",
    title: `${f.flight?.iata ?? "Flight"} → YYZ`,
    detail: [
      f.airline?.name,
      f.departure?.iata ? `from ${f.departure.iata}` : null,
      f.arrival?.terminal ? `T${f.arrival.terminal}` : null,
      f.arrival?.scheduled ? new Date(f.arrival.scheduled).toLocaleString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" }) : null,
    ]
      .filter(Boolean)
      .join(" · "),
    lon: YYZ.lon,
    lat: YYZ.lat,
    meta: { provider: "aviationstack", from: f.departure?.iata, airline: f.airline?.name, scheduled: f.arrival?.scheduled },
  }));
  return {
    source: "flights",
    status: records.length > 0 ? ("live" as const) : ("demo" as const),
    fetchedAt: nowIso(),
    data: records,
    attribution: "aviationstack — flight arrivals",
  };
}

interface OpenSkyResponse {
  states?: unknown[][];
}

/**
 * Keyless live fallback: individual aircraft currently over the Toronto area via
 * OpenSky. Each airborne aircraft becomes a mappable record (real position,
 * callsign, altitude), sorted lowest-first so arrivals on final approach lead.
 */
async function viaOpenSky(): Promise<SourceResult<CivicRecord[]>> {
  const url =
    "https://opensky-network.org/api/states/all?lamin=43.4&lomin=-80.1&lamax=43.95&lomax=-79.2";
  const res = await fetchJson<OpenSkyResponse>(url, { timeoutMs: 9000 });
  const states = res.states ?? [];
  const airborne = states.filter((s) => !Boolean(s[8]) && s[5] != null && s[6] != null);
  const records: CivicRecord[] = airborne
    .map((s) => {
      const callsign = String(s[1] ?? "").trim() || "Unknown";
      const lon = Number(s[5]);
      const lat = Number(s[6]);
      const altM = Number(s[7]);
      const velMs = Number(s[9]);
      const country = String(s[2] ?? "").trim();
      const approaching = Number.isFinite(altM) && altM < 3000;
      return {
        id: `flight-${String(s[0])}`,
        category: "aviation" as const,
        title: callsign,
        detail: [
          approaching ? "On approach" : "Overflight",
          Number.isFinite(altM) ? `${Math.round(altM).toLocaleString()} m` : null,
          Number.isFinite(velMs) ? `${Math.round(velMs * 3.6)} km/h` : null,
          country || null,
        ]
          .filter(Boolean)
          .join(" · "),
        lon,
        lat,
        meta: { provider: "opensky", altitudeM: Number.isFinite(altM) ? altM : null, country, approaching },
      };
    })
    .sort((a, b) => ((a.meta.altitudeM as number) ?? Infinity) - ((b.meta.altitudeM as number) ?? Infinity))
    .slice(0, 30);
  const onApproach = records.filter((r) => r.meta?.approaching).length;
  return {
    source: "flights",
    status: "live" as const,
    fetchedAt: nowIso(),
    note: `${airborne.length} aircraft live over Toronto (${onApproach} on approach). OpenSky live positions; add a working AVIATIONSTACK_KEY for scheduled arrivals with airlines/terminals.`,
    data: records.length > 0 ? records : [{ id: "flights-yyz-inflow", category: "aviation", title: "YYZ airspace", detail: "No airborne aircraft in range right now", lon: YYZ.lon, lat: YYZ.lat, meta: { provider: "opensky" } }],
    attribution: "OpenSky Network (live aircraft)",
  };
}

const DEMO: CivicRecord[] = [
  { id: "flight-demo-1", category: "aviation", title: "YYZ arrivals", detail: "Toronto Pearson — visitor inflow", lon: YYZ.lon, lat: YYZ.lat, meta: { provider: "demo" } },
];

export async function loadFlights(): Promise<SourceResult<CivicRecord[]>> {
  let note: string | undefined;
  // Prefer aviationstack (scheduled arrivals) when the key works, else fall
  // back to live OpenSky aircraft, else demo — so there's always flight data.
  if (aviationstackEnabled()) {
    try {
      const r = await viaAviationstack();
      if (r.data.length > 0) return r;
      note = r.note; // e.g. quota reached
    } catch (err) {
      note = `aviationstack unavailable (${err instanceof Error ? err.message : "error"})`;
    }
  }
  try {
    const sky = await viaOpenSky();
    if (note) sky.note = `${note}. ${sky.note}`;
    return sky;
  } catch (err) {
    return {
      source: "flights",
      status: "demo",
      fetchedAt: nowIso(),
      note: `Live flight data unavailable (${err instanceof Error ? err.message : "error"})${note ? `; ${note}` : ""}; showing demo.`,
      data: DEMO,
      attribution: "aviationstack / OpenSky",
    };
  }
}
