import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Business } from "../services/api";

interface Msg {
  role: "user" | "agent";
  text: string;
  provider?: string;
}

interface HistoryRow {
  date: string;
  hour: number;
  revenue: number | null;
  customer_count: number | null;
  notes: string | null;
}

interface Summary {
  totalDays: number;
  avgDailyRevenue: number | null;
  avgDailyCustomers: number | null;
  peakHour: number | null;
  peakDow: number | null;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR = (h: number) => h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;

const SUGGESTIONS = [
  "What should I know to run my business today?",
  "Am I properly staffed for the week ahead?",
  "Are there events nearby I could capitalise on?",
  "When are my historically busiest windows this week?",
];

function HeatmapMini({ rows }: { rows: HistoryRow[] }) {
  const matrix: Record<string, number[]> = {};
  for (const r of rows) {
    const dow = new Date(r.date).getDay();
    const val = r.customer_count ?? r.revenue ?? 0;
    if (!val) continue;
    const key = `${dow}-${r.hour}`;
    (matrix[key] = matrix[key] ?? []).push(val);
  }
  const avg = (k: string) => {
    const vs = matrix[k];
    return vs ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
  };
  const max = Math.max(...Object.values(matrix).map((vs) => vs.reduce((a, b) => a + b, 0) / vs.length), 1);

  return (
    <div class="heatmap-mini">
      <div class="heatmap-mini-cols">
        {DOW.map((d, dow) => (
          <div key={dow} class="heatmap-mini-col">
            <div class="heatmap-mini-dow">{d}</div>
            {Array.from({ length: 24 }, (_, hour) => {
              const val = avg(`${dow}-${hour}`);
              const intensity = val / max;
              return (
                <div
                  key={hour}
                  class="heatmap-mini-cell"
                  style={{ opacity: intensity > 0 ? 0.12 + intensity * 0.88 : 0.04 }}
                  title={`${d} ${HOUR(hour)}: ${Math.round(val)}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div class="heatmap-mini-hours">
        {[0, 6, 12, 18, 23].map((h) => (
          <div key={h} class="heatmap-mini-hlabel" style={{ top: `${(h / 23) * 100}%` }}>{HOUR(h)}</div>
        ))}
      </div>
    </div>
  );
}

function parseCSV(text: string, businessId: string, type: "history" | "schedule"): object[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).flatMap((line): object[] => {
    const vals = line.split(",").map((v) => v.trim());
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    if (type === "history") {
      return [{ business_id: businessId, date: String(row.date ?? ""), hour: Number(row.hour ?? 0), revenue: row.revenue !== "" ? Number(row.revenue) : null, customer_count: row.customer_count !== "" ? Number(row.customer_count) : null, notes: row.notes ? String(row.notes) : null }];
    }
    return [{ business_id: businessId, date: String(row.date ?? ""), hour: Number(row.hour ?? 0), staff_count: Number(row.staff_count ?? 1), role: row.role ? String(row.role) : null }];
  });
}

export function AgentChat({ business }: { business: Business }) {
  const [messages, setMessages]     = useState<Msg[]>([]);
  const [input, setInput]           = useState("");
  const [busy, setBusy]             = useState(false);
  const [summary, setSummary]       = useState<Summary | null>(null);
  const [histRows, setHistRows]     = useState<HistoryRow[]>([]);
  const [upcomingStaff, setUpcomingStaff] = useState<Record<string, number>>({});
  const [dataExpanded, setDataExpanded]   = useState(false);
  const [manageOpen, setManageOpen]       = useState(false);
  const [genBusy, setGenBusy]       = useState(false);
  const [genMsg, setGenMsg]         = useState<string | null>(null);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const histRef    = useRef<HTMLInputElement>(null);
  const schedRef   = useRef<HTMLInputElement>(null);

  const hasData = summary && summary.totalDays > 0;

  function loadData() {
    api.bizHistory(business.id)
      .then((d) => { setSummary(d.summary); setHistRows(d.rows ?? []); })
      .catch(() => {});
    api.bizSchedule(business.id)
      .then((d) => {
        const byDate: Record<string, number> = {};
        for (const r of d.upcoming) byDate[r.date] = (byDate[r.date] ?? 0) + r.staff_count;
        setUpcomingStaff(byDate);
      })
      .catch(() => {});
  }

  useEffect(() => { loadData(); }, [business.id]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: question }]);
    setBusy(true);
    try {
      const res = await api.agent({ businessId: business.id, question });
      setMessages((m) => [...m, { role: "agent", text: res.text, provider: res.provider }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "agent", text: `Error: ${err instanceof Error ? err.message : "failed"}` }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
    }
  }

  async function generate() {
    setGenBusy(true);
    setGenMsg(null);
    try {
      const d = await api.bizGenerate(business.id);
      setGenMsg(`Generated ${d.historyRows} history + ${d.scheduleRows} schedule rows.`);
      loadData();
    } catch { setGenMsg("Generation failed."); }
    finally { setGenBusy(false); }
  }

  async function uploadFile(file: File, type: "history" | "schedule") {
    setGenBusy(true);
    setGenMsg(null);
    try {
      const rows = parseCSV(await file.text(), business.id, type);
      if (!rows.length) { setGenMsg("No rows parsed — check CSV format."); return; }
      const d = type === "history"
        ? await api.bizUploadHistory(business.id, rows)
        : await api.bizUploadSchedule(business.id, rows);
      setGenMsg(`Imported ${d.inserted} rows.`);
      loadData();
    } catch { setGenMsg("Upload failed."); }
    finally { setGenBusy(false); }
  }

  return (
    <section class="panel agent panel-wide">
      <header class="panel-header">
        <div class="panel-heading">
          <h2 class="panel-title">Your Toronto Agent</h2>
          <p class="panel-desc">
            Grounded in live city data + your own revenue history and staff schedule.
          </p>
        </div>
        <span class="count-pill">{business.businessType}</span>
      </header>

      {/* ---- Data context bar ---- */}
      <div class="agent-data-bar">
        {hasData ? (
          <>
            <button
              class="agent-data-summary"
              onClick={() => setDataExpanded((v) => !v)}
              title={dataExpanded ? "Collapse" : "Expand demand heatmap"}
            >
              <span class="agent-data-item">
                <span class="agent-data-label muted">history</span>
                <span class="agent-data-value">{summary!.totalDays}d</span>
              </span>
              {summary!.avgDailyRevenue != null && (
                <span class="agent-data-item">
                  <span class="agent-data-label muted">avg/day</span>
                  <span class="agent-data-value">${summary!.avgDailyRevenue.toLocaleString()}</span>
                </span>
              )}
              {summary!.avgDailyCustomers != null && (
                <span class="agent-data-item">
                  <span class="agent-data-label muted">customers</span>
                  <span class="agent-data-value">{summary!.avgDailyCustomers}/day</span>
                </span>
              )}
              {summary!.peakHour != null && (
                <span class="agent-data-item">
                  <span class="agent-data-label muted">peak</span>
                  <span class="agent-data-value">{HOUR(summary!.peakHour)}</span>
                </span>
              )}
              {summary!.peakDow != null && (
                <span class="agent-data-item">
                  <span class="agent-data-label muted">busiest</span>
                  <span class="agent-data-value">{DOW[summary!.peakDow]}</span>
                </span>
              )}
              <span class="agent-data-chevron muted">{dataExpanded ? "▲" : "▼"}</span>
            </button>
            <button class="agent-data-manage muted" onClick={() => setManageOpen((v) => !v)} title="Manage data">⚙</button>
          </>
        ) : (
          <div class="agent-data-empty">
            <span class="muted" style={{ fontSize: "12px" }}>No business data yet — agent is using city signals only.</span>
            <button class="btn-ghost" style={{ fontSize: "11px", padding: "3px 10px" }} onClick={generate} disabled={genBusy}>
              {genBusy ? "Generating…" : "Generate sample data"}
            </button>
          </div>
        )}
      </div>

      {/* ---- Expanded heatmap ---- */}
      {dataExpanded && hasData && (
        <div class="agent-data-expanded">
          <div class="agent-data-expanded-head">
            <span class="forecast-sub">90-day demand pattern</span>
            {Object.keys(upcomingStaff).length > 0 && (
              <div class="agent-schedule-strip">
                {Object.entries(upcomingStaff).slice(0, 7).map(([date, total]) => (
                  <div key={date} class="agent-schedule-day">
                    <div class="agent-schedule-dow">{DOW[new Date(date).getDay()]}</div>
                    <div class="agent-schedule-hrs">{total}<span class="muted">h</span></div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <HeatmapMini rows={histRows} />
        </div>
      )}

      {/* ---- Manage data drawer ---- */}
      {manageOpen && (
        <div class="agent-manage-drawer">
          <div class="agent-manage-row">
            <span class="muted" style={{ fontSize: "12px" }}>Regenerate 90-day sample ({business.businessType})</span>
            <button class="btn-ghost" style={{ fontSize: "11px" }} onClick={generate} disabled={genBusy}>
              {genBusy ? "…" : "Regenerate"}
            </button>
          </div>
          <div class="agent-manage-row">
            <span class="muted" style={{ fontSize: "12px" }}>Upload revenue CSV <code style={{ fontSize: "10px" }}>date,hour,revenue,customer_count</code></span>
            <input ref={histRef} type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) uploadFile(f, "history"); }} />
            <button class="btn-ghost" style={{ fontSize: "11px" }} onClick={() => histRef.current?.click()} disabled={genBusy}>Upload</button>
          </div>
          <div class="agent-manage-row">
            <span class="muted" style={{ fontSize: "12px" }}>Upload schedule CSV <code style={{ fontSize: "10px" }}>date,hour,staff_count,role</code></span>
            <input ref={schedRef} type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) uploadFile(f, "schedule"); }} />
            <button class="btn-ghost" style={{ fontSize: "11px" }} onClick={() => schedRef.current?.click()} disabled={genBusy}>Upload</button>
          </div>
          {genMsg && <div class="agent-manage-msg">{genMsg}</div>}
        </div>
      )}

      {/* ---- Chat ---- */}
      <div class="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div class="chat-empty">
            <p class="muted">
              Ask anything about how Toronto conditions affect <strong>{business.name}</strong>.
              {hasData && " Your revenue history and staff schedule are included as context."}
            </p>
            <div class="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} class="chip-btn" onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} class={`bubble bubble-${m.role}`}>
            {m.role === "agent" && m.provider && <span class="bubble-tag">{m.provider}</span>}
            <div class="bubble-text">{m.text}</div>
          </div>
        ))}
        {busy && <div class="bubble bubble-agent"><div class="bubble-text muted">Thinking…</div></div>}
      </div>

      <form class="chat-input" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder={hasData ? "Ask about staffing, revenue patterns, city conditions…" : "Ask about city conditions around your business…"}
          disabled={busy}
        />
        <button type="submit" class="btn-primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </section>
  );
}
