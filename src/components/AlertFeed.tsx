import { useEffect, useRef, useState } from "preact/hooks";
import { apiUrl } from "../services/api";

export interface ProactiveAlert {
  id: string;
  timestamp: string;
  location: string;
  businessType: string;
  severity: "info" | "warning" | "urgent";
  signal: string;
  title: string;
  body: string;
  actions: string[];
  delta: { metric: string; from: string; to: string };
}

const SEVERITY_COLOR: Record<ProactiveAlert["severity"], string> = {
  info:    "#44a8ff",
  warning: "#ffb940",
  urgent:  "#ff3b44",
};

const SIGNAL_ICON: Record<string, string> = {
  demand:  "▲",
  transit: "⚡",
  weather: "◆",
  event:   "★",
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function AlertFeed() {
  const [alerts, setAlerts] = useState<ProactiveAlert[]>([]);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Load recent alerts from REST endpoint first.
    fetch(apiUrl("/api/alerts"))
      .then((r) => r.json())
      .then((data: ProactiveAlert[]) => setAlerts(data))
      .catch(() => {});

    // Then subscribe to the SSE stream for live updates.
    const es = new EventSource(apiUrl("/api/alerts/stream"));
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const alert = JSON.parse(e.data) as ProactiveAlert;
        setAlerts((prev) => {
          // Deduplicate by id — SSE sends recent history on connect.
          if (prev.some((a) => a.id === alert.id)) return prev;
          return [alert, ...prev].slice(0, 30);
        });
      } catch { /* ignore malformed */ }
    };

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, []);

  const unread = alerts.length;

  return (
    <section class="panel alert-feed">
      <header class="panel-header">
        <div class="panel-heading">
          <h2 class="panel-title">
            Proactive Alerts
            {unread > 0 && <span class="alert-badge">{unread}</span>}
          </h2>
          <p class="panel-desc">
            Live signal changes that cross demand thresholds — fires before you think to ask.
          </p>
        </div>
        <span class={`badge badge-${connected ? "live" : "error"}`}>
          <i class="badge-dot" />
          {connected ? "LIVE" : "CONNECTING"}
        </span>
      </header>

      {alerts.length === 0 ? (
        <div class="alert-empty">
          <span class="alert-empty-icon">◎</span>
          <p class="muted">Monitoring {connected ? "active" : "starting"}. Alerts fire when signals cross thresholds.</p>
        </div>
      ) : (
        <ul class="alert-list">
          {alerts.map((alert) => (
            <li
              key={alert.id}
              class={`alert-card alert-${alert.severity}${expanded === alert.id ? " is-expanded" : ""}`}
              onClick={() => setExpanded(expanded === alert.id ? null : alert.id)}
            >
              <div class="alert-card-header">
                <span
                  class="alert-icon"
                  style={{ color: SEVERITY_COLOR[alert.severity] }}
                >
                  {SIGNAL_ICON[alert.signal] ?? "●"}
                </span>
                <div class="alert-meta">
                  <strong class="alert-title">{alert.title}</strong>
                  <span class="alert-loc muted">{alert.location}</span>
                </div>
                <div class="alert-right">
                  <span
                    class="alert-pill"
                    style={{ background: SEVERITY_COLOR[alert.severity] }}
                  >
                    {alert.severity}
                  </span>
                  <span class="muted alert-time">{timeAgo(alert.timestamp)}</span>
                </div>
              </div>

              {expanded === alert.id && (
                <div class="alert-detail">
                  <p class="alert-body">{alert.body}</p>
                  <div class="alert-delta muted">
                    {alert.delta.metric}: {alert.delta.from} → {alert.delta.to}
                  </div>
                  {alert.actions.length > 0 && (
                    <ul class="alert-actions">
                      {alert.actions.map((a, i) => (
                        <li key={i}>
                          <span style={{ color: SEVERITY_COLOR[alert.severity] }}>→</span> {a}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
