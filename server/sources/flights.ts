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
  const res = await fetchJson<{ data?: AviationstackFlight[] }>(url, { timeoutMs: 9000 });
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

/** Keyless fallback: count live aircraft in the YYZ approach box via OpenSky. */
async function viaOpenSky(): Promise<SourceResult<CivicRecord[]>> {
  const url =
    "https://opensky-network.org/api/states/all?lamin=43.4&lomin=-80.1&lamax=43.95&lomax=-79.2";
  const res = await fetchJson<OpenSkyResponse>(url, { timeoutMs: 9000 });
  const states = res.states ?? [];
  // Aircraft below ~3000m on approach are likely arriving.
  const arriving = states.filter((s) => {
    const baroAlt = Number(s[7]);
    const onGround = Boolean(s[8]);
    return !onGround && Number.isFinite(baroAlt) && baroAlt < 3000;
  });
  const record: CivicRecord = {
    id: "flights-yyz-inflow",
    category: "aviation",
    title: "YYZ approach traffic",
    detail: `${arriving.length} aircraft on approach · ${states.length} in Toronto airspace`,
    lon: YYZ.lon,
    lat: YYZ.lat,
    meta: { provider: "opensky", approaching: arriving.length, airspace: states.length },
  };
  return {
    source: "flights",
    status: "live" as const,
    fetchedAt: nowIso(),
    note: "Live aircraft over Toronto (OpenSky). Add AVIATIONSTACK_KEY for scheduled arrivals with airlines/terminals.",
    data: [record],
    attribution: "OpenSky Network (live aircraft)",
  };
}

const DEMO: CivicRecord[] = [
  { id: "flight-demo-1", category: "aviation", title: "YYZ arrivals", detail: "Toronto Pearson — visitor inflow", lon: YYZ.lon, lat: YYZ.lat, meta: { provider: "demo" } },
];

export async function loadFlights(): Promise<SourceResult<CivicRecord[]>> {
  try {
    if (aviationstackEnabled()) return await viaAviationstack();
    return await viaOpenSky();
  } catch (err) {
    return {
      source: "flights",
      status: "demo",
      fetchedAt: nowIso(),
      note: `Live flight data unavailable (${err instanceof Error ? err.message : "error"}); showing demo. Add AVIATIONSTACK_KEY to enable.`,
      data: DEMO,
      attribution: "aviationstack / OpenSky",
    };
  }
}
