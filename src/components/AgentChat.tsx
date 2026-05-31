import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Business } from "../services/api";
import { Markdown } from "./Markdown";

interface Msg {
  role: "user" | "agent";
  text: string;
  provider?: string;
  streaming?: boolean;
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
  const [useGradient, setUseGradient] = useState(true);
  const scrollRef    = useRef<HTMLDivElement>(null);
  const histRef      = useRef<HTMLInputElement>(null);
  const schedRef     = useRef<HTMLInputElement>(null);
  const streamBuf    = useRef("");
  const [asrReady, setAsrReady]     = useState(false);
  const [asrStatus, setAsrStatus]   = useState("");
  const [recording, setRecording]   = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceErr, setVoiceErr]     = useState<string | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks   = useRef<Blob[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      api.asrHealth()
        .then((d) => {
          if (cancelled) return;
          setAsrReady(d.available);
          if (d.available) {
            setAsrStatus(d.loaded ? "ASR ready" : "ASR up (model loads on first mic use)");
          } else {
            setAsrStatus(d.hint ?? `ASR offline — API cannot reach ${d.url ?? "Parakeet"}`);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAsrReady(false);
            setAsrStatus("ASR offline — is npm run dev:server on the same machine as Parakeet?");
          }
        });
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  async function transcribeAndAsk(blob: Blob) {
    if (!blob.size) {
      setVoiceErr("No audio captured — hold Mic longer, then Stop.");
      return;
    }
    setTranscribing(true);
    setVoiceErr(null);
    try {
      const { text } = await api.asrTranscribe(blob, blob.type.includes("wav") ? "recording.wav" : "recording.webm");
      if (!text.trim()) {
        setVoiceErr("No speech detected.");
        return;
      }
      setInput(text);
      await ask(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let detail = msg;
      try {
        const j = JSON.parse(msg) as { error?: string };
        if (j.error) detail = j.error;
      } catch { /* plain text */ }
      setVoiceErr(detail.length > 120 ? `${detail.slice(0, 120)}…` : detail || "Transcription failed");
    } finally {
      setTranscribing(false);
    }
  }

  async function toggleRecording() {
    if (recording) {
      const rec = mediaRecorder.current;
      if (rec?.state === "recording") rec.requestData();
      rec?.stop();
      return;
    }
    setVoiceErr(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceErr("Mic needs https:// or http://localhost (not plain LAN IP).");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks.current = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      mediaRecorder.current = rec;
      rec.ondataavailable = (e) => { if (e.data.size) audioChunks.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(audioChunks.current, { type: mime });
        void transcribeAndAsk(blob);
      };
      rec.onerror = () => setVoiceErr("Recording failed.");
      rec.start(250);
      setRecording(true);
    } catch {
      setVoiceErr("Microphone access denied — allow mic in browser settings.");
    }
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (recording) {
      // Mic is live — stop & transcribe instead of submitting empty input.
      mediaRecorder.current?.stop();
      return;
    }
    ask(input);
  }

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setInput("");
    streamBuf.current = "";
    setMessages((m) => [...m, { role: "user", text: question }, { role: "agent", text: "", streaming: true }]);
    setBusy(true);

    const scrollDown = () =>
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));

    const setStreamingMsg = (partial: Partial<Msg>) =>
      setMessages((m) => m.map((msg) =>
        msg.streaming ? { ...msg, ...partial } : msg,
      ));

    try {
      await api.agentStream({ businessId: business.id, question, useGradient }, (e) => {
        if (e.error) {
          setStreamingMsg({ text: `Error: ${e.error}`, streaming: false });
          return;
        }
        if (e.provider) {
          const label = e.model || e.provider;
          const mode = e.gradientUsed ? "gradient-assisted" : "nemotron-only";
          setStreamingMsg({ provider: `${label} · ${mode}` });
        }
        if (e.delta) {
          streamBuf.current += e.delta;
          setStreamingMsg({ text: streamBuf.current });
          scrollDown();
        }
      });
    } catch (err) {
      setStreamingMsg({ text: `Error: ${err instanceof Error ? err.message : "failed"}`, streaming: false });
    } finally {
      // Capture ref value BEFORE clearing — the functional updater runs async,
      // so reading streamBuf.current inside the closure would see the cleared value.
      const finalText = streamBuf.current;
      streamBuf.current = "";
      setMessages((m) => m.map((msg) =>
        msg.streaming ? { ...msg, text: finalText || msg.text, streaming: false } : msg,
      ));
      setBusy(false);
      scrollDown();
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
            {useGradient
              ? "Nemotron, grounded in the CityFlow demand model, plus Toronto live data, street research, and your revenue/schedule."
              : "Nemotron answering from Toronto live data, street research, and your revenue/schedule (no demand model)."}
          </p>
        </div>
        <div class="agent-header-side">
          <span class="agent-model-badge">{business.businessType}</span>
          <div class="model-toggle" role="group" aria-label="Response model">
            <button
              type="button"
              class={`model-toggle-opt${useGradient ? "" : " is-active"}`}
              aria-pressed={!useGradient}
              onClick={() => setUseGradient(false)}
              title="Pure Nemotron LLM — no ML demand model in the prompt"
            >
              Nemotron
            </button>
            <button
              type="button"
              class={`model-toggle-opt${useGradient ? " is-active" : ""}`}
              aria-pressed={useGradient}
              onClick={() => setUseGradient(true)}
              title="Feed the gradient demand model's predictions into Nemotron"
            >
              + Demand model
            </button>
          </div>
        </div>
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
              {genBusy ? "Loading…" : "Load baseline data"}
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
            <span class="muted" style={{ fontSize: "12px" }}>Reload 90-day demand baseline ({business.businessType})</span>
            <button class="btn-ghost" style={{ fontSize: "11px" }} onClick={generate} disabled={genBusy}>
              {genBusy ? "…" : "Reload"}
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
            {m.role !== "agent" ? (
              <div class="bubble-text">{m.text}</div>
            ) : m.streaming && !m.text ? (
              <div class="bubble-text muted">Thinking<span class="stream-dots" /></div>
            ) : m.streaming ? (
              // While streaming, show raw tokens as plain text (preserve newlines)
              // so partial/malformed markdown can never blank the bubble. We
              // upgrade to formatted markdown once the response completes.
              <div class="bubble-text" style="white-space:pre-wrap">
                {m.text}
                <span class="stream-caret" />
              </div>
            ) : (
              <div class="bubble-text">
                <Markdown text={m.text} />
              </div>
            )}
          </div>
        ))}
      </div>

      <form class="chat-input" onSubmit={handleSubmit}>
        <button
          type="button"
          class={`chat-mic${recording ? " is-recording" : ""}${transcribing ? " is-transcribing" : ""}`}
          onClick={toggleRecording}
          disabled={busy || transcribing || !asrReady}
          title={
            !asrReady
              ? (asrStatus || "Voice input offline")
              : transcribing
                ? "Transcribing…"
                : recording
                  ? "Stop & transcribe"
                  : "Record a question (Parakeet on NVIDIA)"
          }
          aria-label={recording ? "Stop recording" : "Start voice input"}
        >
          {transcribing ? (
            <span class="mic-spinner" aria-hidden="true" />
          ) : recording ? (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          )}
        </button>
        <input
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder={
            recording
              ? "Listening… click the mic to stop"
              : transcribing
                ? "Transcribing your question…"
                : (hasData ? "Ask about staffing, revenue patterns, city conditions…" : "Ask about city conditions around your business…")
          }
          disabled={busy || transcribing || recording}
        />
        <button
          type="submit"
          class="btn-primary"
          disabled={busy || transcribing || recording || !input.trim()}
        >
          {transcribing ? "…" : "Send"}
        </button>
      </form>
      {(voiceErr || (!asrReady && asrStatus)) && (
        <div class="chat-voice-note">
          {voiceErr
            ? <span class="chat-voice-err">{voiceErr}</span>
            : <span class="muted">{asrStatus}</span>}
        </div>
      )}
    </section>
  );
}
