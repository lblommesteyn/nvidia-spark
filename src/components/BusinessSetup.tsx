import { useState } from "preact/hooks";
import { api, type Business, type TransitNearby } from "../services/api";

const BUSINESS_TYPES = [
  "cafe",
  "restaurant",
  "bar / pub",
  "retail store",
  "grocery",
  "salon / spa",
  "gym / fitness",
  "professional services",
  "medical / clinic",
  "other",
];

const SHIFT_OPTIONS = [4, 6, 8];

const RELEVANCE_LABEL: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  minimal: "Minimal",
};

interface Props {
  onCreated: (b: Business) => void;
  onCancel: () => void;
}

export function BusinessSetup({ onCreated, onCancel }: Props) {
  const [name, setName] = useState("");
  const [businessType, setType] = useState(BUSINESS_TYPES[0]);
  const [address, setAddress] = useState("");
  const [headcount, setHeadcount] = useState(1);
  const [notes, setNotes] = useState("");

  // Hours + demand context
  const [opensAt, setOpensAt] = useState(8);
  const [closesAt, setClosesAt] = useState(22);
  const [eventRadiusKm, setEventRadiusKm] = useState(2);

  // Staffing policy
  const [customersPerWorkerHour, setCustomersPerWorkerHour] = useState(15);
  const [hourlyWage, setHourlyWage] = useState(18);
  const [minStaff, setMinStaff] = useState(1);
  const [maxStaffPerHour, setMaxStaffPerHour] = useState<number | "">("");
  const [shiftLengths, setShiftLengths] = useState<number[]>([4, 8]);

  // Transit (derived from address)
  const [transit, setTransit] = useState<TransitNearby | null>(null);
  const [transitBusy, setTransitBusy] = useState(false);
  const [transitErr, setTransitErr] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleShift(h: number) {
    setShiftLengths((cur) => (cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h].sort((a, b) => a - b)));
  }

  async function lookupTransit() {
    const addr = address.trim();
    if (!addr) return;
    setTransitBusy(true);
    setTransitErr(null);
    try {
      setTransit(await api.transitNearby(addr));
    } catch {
      setTransit(null);
      setTransitErr("Couldn't find that address in Toronto.");
    } finally {
      setTransitBusy(false);
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const biz = await api.createBusiness({
        name,
        businessType,
        address,
        headcount,
        notes,
        opensAt,
        closesAt,
        eventRadiusKm,
        customersPerWorkerHour,
        hourlyWage,
        minStaff,
        maxStaffPerHour: maxStaffPerHour === "" ? undefined : Number(maxStaffPerHour),
        allowedShiftLengths: shiftLengths,
      });
      // Street research runs in the background; agent still works with live data if this is slow.
      void api.refreshBusinessResearch(biz.id).catch(() => {});
      onCreated(biz);
    } catch (err) {
      setError(
        err instanceof Error && err.message.includes("geocode")
          ? "Couldn't find that address in Toronto. Try a more specific street address."
          : err instanceof Error
            ? err.message
            : "Failed to create business.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={onCancel}>
      <form class="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Set up your business</h2>
        <p class="muted">
          These details feed the CityFlow demand model so it can forecast traffic and recommend
          staffing for your location.
        </p>

        <label>
          Business name
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required placeholder="Queen St Cafe" />
        </label>

        <div class="form-row">
          <label>
            Type
            <select value={businessType} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
              {BUSINESS_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Staff (current)
            <input
              type="number"
              min={1}
              value={headcount}
              onInput={(e) => setHeadcount(Number((e.target as HTMLInputElement).value) || 1)}
            />
          </label>
        </div>

        <div class="form-row form-row-3">
          <label>
            Opens at (hour)
            <input
              type="number"
              min={0}
              max={23}
              value={opensAt}
              onInput={(e) => setOpensAt(clampHour((e.target as HTMLInputElement).value, 8))}
            />
          </label>
          <label>
            Closes at (hour)
            <input
              type="number"
              min={0}
              max={23}
              value={closesAt}
              onInput={(e) => setClosesAt(clampHour((e.target as HTMLInputElement).value, 22))}
            />
          </label>
          <label>
            Event radius (km)
            <input
              type="number"
              min={0}
              step={0.5}
              value={eventRadiusKm}
              onInput={(e) => setEventRadiusKm(Number((e.target as HTMLInputElement).value) || 0)}
            />
          </label>
        </div>

        <label>
          Address (Toronto)
          <input
            value={address}
            onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
            onBlur={lookupTransit}
            required
            placeholder="250 Queen St W"
          />
        </label>

        {/* Transit relevance + nearby routes — derived from the address. */}
        <div class="transit-box">
          <div class="transit-head">
            <span class="transit-title">Transit relevance</span>
            <button type="button" class="btn-mini" onClick={lookupTransit} disabled={transitBusy || !address.trim()}>
              {transitBusy ? "Checking…" : "Check transit"}
            </button>
          </div>
          {transitErr ? (
            <div class="transit-empty">{transitErr}</div>
          ) : transit ? (
            <div class="transit-body">
              <span class={`transit-badge rel-${transit.relevance}`}>
                {RELEVANCE_LABEL[transit.relevance] ?? transit.relevance}
                {transit.nearestM !== null && ` · nearest ${transit.nearestM} m`}
              </span>
              <div class="transit-routes">
                {transit.routes.length ? (
                  transit.routes.slice(0, 6).map((r) => (
                    <span key={r.id} class="route-chip" style={{ borderColor: r.color }}>
                      <span class="route-dot" style={{ background: r.color }} />
                      {r.name} · {r.distanceM} m
                    </span>
                  ))
                ) : (
                  <span class="muted">No TTC/GO lines within walking distance.</span>
                )}
              </div>
            </div>
          ) : (
            <div class="transit-empty muted">
              Enter an address and we'll find nearby TTC/GO routes automatically.
            </div>
          )}
        </div>

        {/* Staffing policy */}
        <div class="form-section-title">Staffing policy</div>
        <div class="form-row">
          <label>
            Customers / worker / hour
            <input
              type="number"
              min={1}
              value={customersPerWorkerHour}
              onInput={(e) => setCustomersPerWorkerHour(Number((e.target as HTMLInputElement).value) || 1)}
            />
          </label>
          <label>
            Hourly wage ($)
            <input
              type="number"
              min={0}
              step={0.25}
              value={hourlyWage}
              onInput={(e) => setHourlyWage(Number((e.target as HTMLInputElement).value) || 0)}
            />
          </label>
        </div>
        <div class="form-row">
          <label>
            Min staff when open
            <input
              type="number"
              min={0}
              value={minStaff}
              onInput={(e) => setMinStaff(Number((e.target as HTMLInputElement).value) || 0)}
            />
          </label>
          <label>
            Max staff / hour (optional)
            <input
              type="number"
              min={0}
              value={maxStaffPerHour}
              placeholder="no cap"
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setMaxStaffPerHour(v === "" ? "" : Number(v) || 0);
              }}
            />
          </label>
        </div>

        <div class="field-block">
          <span class="field-label">Allowed shift lengths (h)</span>
          <div class="checkbox-row">
            {SHIFT_OPTIONS.map((h) => (
              <label key={h} class="checkbox-pill">
                <input type="checkbox" checked={shiftLengths.includes(h)} onChange={() => toggleShift(h)} />
                {h}h
              </label>
            ))}
          </div>
        </div>

        <label>
          Notes for your agent (optional)
          <textarea
            rows={2}
            value={notes}
            onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
            placeholder="Busy lunch crowd, patio in summer, rely on foot traffic…"
          />
        </label>

        {error && <div class="form-error">{error}</div>}

        <div class="form-actions">
          <button type="button" class="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" class="btn-primary" disabled={busy}>
            {busy ? "Setting up…" : "Create agent"}
          </button>
        </div>
      </form>
    </div>
  );
}

function clampHour(raw: string, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(23, n));
}
