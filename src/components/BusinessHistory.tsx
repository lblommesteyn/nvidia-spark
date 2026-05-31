import { useEffect, useRef, useState } from "preact/hooks";
import { type Business } from "../services/api";

interface HistoryRow {
  date: string;
  hour: number;
  revenue: number | null;
  customer_count: number | null;
  notes: string | null;
}

interface ScheduleRow {
  date: string;
  hour: number;
  staff_count: number;
  role: string | null;
}

interface Summary {
  totalDays: number;
  avgDailyRevenue: number | null;
  avgDailyCustomers: number | null;
  peakHour: number | null;
  peakDow: number | null;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_LABEL = (h: number) => h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;

function parseCSV(text: string, businessId: string, type: "history" | "schedule"): object[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).flatMap((line): object[] => {
    const vals = line.split(",").map((v) => v.trim());
    const row: Record<string, unknown> = { business_id: businessId };
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    if (type === "history") {
      return [{
        business_id: businessId,
        date: String(row.date ?? ""),
        hour: Number(row.hour ?? 0),
        revenue: row.revenue !== "" ? Number(row.revenue) : null,
        customer_count: row.customer_count !== "" ? Number(row.customer_count) : null,
        notes: row.notes ? String(row.notes) : null,
      }];
    } else {
      return [{
        business_id: businessId,
        date: String(row.date ?? ""),
        hour: Number(row.hour ?? 0),
        staff_count: Number(row.staff_count ?? 1),
        role: row.role ? String(row.role) : null,
      }];
    }
  });
}

function HeatmapGrid({ rows, field }: { rows: HistoryRow[]; field: "revenue" | "customer_count" }) {
  // Build dow×hour matrix averaged over the dataset
  const matrix: Record<string, number[]> = {};
  for (const r of rows) {
    const dow = new Date(r.date).getDay();
    const key = `${dow}-${r.hour}`;
    const val = field === "revenue" ? r.revenue : r.customer_count;
    if (val == null) continue;
    (matrix[key] = matrix[key] ?? []).push(val);
  }
  const avg = (k: string) => {
    const vs = matrix[k];
    return vs ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
  };
  const max = Math.max(...Object.values(matrix).map((vs) => vs.reduce((a, b) => a + b, 0) / vs.length), 1);

  return (
    <div class="heatmap">
      <div class="heatmap-labels-dow">
        {DOW.map((d) => <div key={d} class="heatmap-dow">{d}</div>)}
      </div>
      <div class="heatmap-grid">
        {Array.from({ length: 24 }, (_, hour) => (
          <div key={hour} class="heatmap-row">
            <div class="heatmap-hour-label">{HOUR_LABEL(hour)}</div>
            {DOW.map((_, dow) => {
              const val = avg(`${dow}-${hour}`);
              const intensity = max > 0 ? val / max : 0;
              return (
                <div
                  key={dow}
                  class="heatmap-cell"
                  style={{ opacity: intensity > 0 ? 0.15 + intensity * 0.85 : 0.05 }}
                  title={`${DOW[dow]} ${HOUR_LABEL(hour)}: ${field === "revenue" ? `$${val.toFixed(0)}` : `${Math.round(val)} customers`}`}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function BusinessHistory({ business }: { business: Business }) {
  const [summary, setSummary]       = useState<Summary | null>(null);
  const [history, setHistory]       = useState<HistoryRow[]>([]);
  const [upcoming, setUpcoming]     = useState<ScheduleRow[]>([]);
  const [tab, setTab]               = useState<"overview" | "upload">("overview");
  const [uploading, setUploading]   = useState(false);
  const [uploadMsg, setUploadMsg]   = useState<string | null>(null);
  const [heatField, setHeatField]   = useState<"revenue" | "customer_count">("customer_count");
  const histFileRef  = useRef<HTMLInputElement>(null);
  const schedFileRef = useRef<HTMLInputElement>(null);

  function load() {
    fetch(`/api/businesses/${business.id}/history`)
      .then((r) => r.json())
      .then((d) => { setSummary(d.summary); setHistory(d.rows ?? []); })
      .catch(() => {});
    fetch(`/api/businesses/${business.id}/schedule`)
      .then((r) => r.json())
      .then((d) => setUpcoming(d.upcoming ?? []))
      .catch(() => {});
  }

  useEffect(() => { load(); }, [business.id]);

  async function uploadFile(file: File, type: "history" | "schedule") {
    setUploading(true);
    setUploadMsg(null);
    try {
      const text = await file.text();
      const rows = parseCSV(text, business.id, type);
      if (!rows.length) { setUploadMsg("No rows parsed — check your CSV format."); return; }
      const endpoint = type === "history"
        ? `/api/businesses/${business.id}/history`
        : `/api/businesses/${business.id}/schedule`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      setUploadMsg(`Imported ${data.inserted} rows.`);
      load();
    } catch (e) {
      setUploadMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

  async function generateBaseline() {
    setUploading(true);
    setUploadMsg(null);
    try {
      const res = await fetch(`/api/businesses/${business.id}/generate`, { method: "POST" });
      const data = await res.json();
      setUploadMsg(`Generated ${data.historyRows} history rows + ${data.scheduleRows} schedule rows.`);
      load();
    } catch (e) {
      setUploadMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

  // Summarise upcoming schedule for display
  const scheduleByDate = upcoming.reduce<Record<string, number>>((acc, r) => {
    acc[r.date] = (acc[r.date] ?? 0) + r.staff_count;
    return acc;
  }, {});

  const noData = !summary || summary.totalDays === 0;

  return (
    <section class="panel business-history">
      <header class="panel-header">
        <div class="panel-heading">
          <h2 class="panel-title">Your Business Data</h2>
          <p class="panel-desc">
            Revenue, customers &amp; staff schedule — your agent uses this to give personalised recommendations.
          </p>
        </div>
        <div class="bh-tabs">
          <button class={`bh-tab${tab === "overview" ? " is-active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
          <button class={`bh-tab${tab === "upload" ? " is-active" : ""}`} onClick={() => setTab("upload")}>Import / Generate</button>
        </div>
      </header>

      {tab === "overview" && (
        <div class="bh-body">
          {noData ? (
            <div class="alert-empty">
              <span class="alert-empty-icon">◎</span>
              <p class="muted">No business data yet. Use the Import / Generate tab to add history.</p>
              <button class="btn-primary" style={{ marginTop: "0.75rem" }} onClick={() => setTab("upload")}>+ Add data</button>
            </div>
          ) : (
            <>
              <div class="bh-stats">
                <div class="bh-stat">
                  <div class="bh-stat-value">{summary!.totalDays}</div>
                  <div class="bh-stat-label muted">days of history</div>
                </div>
                {summary!.avgDailyRevenue != null && (
                  <div class="bh-stat">
                    <div class="bh-stat-value">${summary!.avgDailyRevenue.toLocaleString()}</div>
                    <div class="bh-stat-label muted">avg daily revenue</div>
                  </div>
                )}
                {summary!.avgDailyCustomers != null && (
                  <div class="bh-stat">
                    <div class="bh-stat-value">{summary!.avgDailyCustomers}</div>
                    <div class="bh-stat-label muted">avg daily customers</div>
                  </div>
                )}
                {summary!.peakHour != null && (
                  <div class="bh-stat">
                    <div class="bh-stat-value">{HOUR_LABEL(summary!.peakHour)}</div>
                    <div class="bh-stat-label muted">peak hour</div>
                  </div>
                )}
                {summary!.peakDow != null && (
                  <div class="bh-stat">
                    <div class="bh-stat-value">{DOW[summary!.peakDow]}</div>
                    <div class="bh-stat-label muted">busiest day</div>
                  </div>
                )}
              </div>

              <div class="bh-heatmap-section">
                <div class="bh-heatmap-controls">
                  <span class="forecast-sub">Demand heatmap (90d)</span>
                  <div class="bh-toggle">
                    <button class={`bh-tab${heatField === "customer_count" ? " is-active" : ""}`} onClick={() => setHeatField("customer_count")}>Customers</button>
                    <button class={`bh-tab${heatField === "revenue" ? " is-active" : ""}`} onClick={() => setHeatField("revenue")}>Revenue</button>
                  </div>
                </div>
                <HeatmapGrid rows={history} field={heatField} />
              </div>

              {Object.keys(scheduleByDate).length > 0 && (
                <div class="bh-schedule">
                  <div class="forecast-sub" style={{ marginBottom: "0.5rem" }}>Upcoming staff schedule (7d)</div>
                  <div class="bh-schedule-strip">
                    {Object.entries(scheduleByDate).slice(0, 7).map(([date, total]) => {
                      const d = new Date(date);
                      return (
                        <div key={date} class="bh-schedule-day">
                          <div class="bh-schedule-dow">{DOW[d.getDay()]}</div>
                          <div class="bh-schedule-date muted">{date.slice(5)}</div>
                          <div class="bh-schedule-staff">{total} <span class="muted">hrs</span></div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "upload" && (
        <div class="bh-body">
          <div class="bh-upload-section">
            <div class="bh-upload-card">
              <div class="bh-upload-title">Load demand baseline</div>
              <p class="muted" style={{ fontSize: "0.8rem", margin: "0.25rem 0 0.75rem" }}>
                Loads 90 days of calibrated revenue, customer counts &amp; staff schedule for your business type (<strong>{business.businessType}</strong>), derived from the CityFlow Toronto demand model.
                Use this to get the agent running immediately.
              </p>
              <button class="btn-primary" onClick={generateBaseline} disabled={uploading}>
                {uploading ? "Loading…" : "Load 90-day baseline"}
              </button>
            </div>

            <div class="bh-upload-divider"><span>or upload your own</span></div>

            <div class="bh-upload-card">
              <div class="bh-upload-title">Revenue &amp; customers CSV</div>
              <p class="muted" style={{ fontSize: "0.8rem", margin: "0.25rem 0 0.5rem" }}>
                Columns: <code>date,hour,revenue,customer_count,notes</code><br />
                Example: <code>2026-01-15,14,320.50,22,lunch rush</code>
              </p>
              <input
                ref={histFileRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) uploadFile(f, "history");
                }}
              />
              <button class="btn-ghost" onClick={() => histFileRef.current?.click()} disabled={uploading}>
                Choose CSV…
              </button>
            </div>

            <div class="bh-upload-card">
              <div class="bh-upload-title">Staff schedule CSV</div>
              <p class="muted" style={{ fontSize: "0.8rem", margin: "0.25rem 0 0.5rem" }}>
                Columns: <code>date,hour,staff_count,role</code><br />
                Example: <code>2026-01-15,18,3,floor</code>
              </p>
              <input
                ref={schedFileRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) uploadFile(f, "schedule");
                }}
              />
              <button class="btn-ghost" onClick={() => schedFileRef.current?.click()} disabled={uploading}>
                Choose CSV…
              </button>
            </div>

            {uploadMsg && (
              <div class={`bh-upload-msg${uploadMsg.startsWith("Error") ? " is-error" : ""}`}>{uploadMsg}</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
