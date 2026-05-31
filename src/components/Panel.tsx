import type { ComponentChildren } from "preact";
import type { DataStatus } from "../types";
import { RelativeTime } from "./RelativeTime";

interface Props {
  title: string;
  status: DataStatus;
  /** Short per-tile description shown under the title (WorldMonitor-style). */
  description?: string;
  /** Optional count shown as a pill in the header (e.g. nearby records). */
  count?: number;
  /** ISO timestamp the data was fetched; renders a self-ticking "updated X ago". */
  updatedAt?: string;
  /** Footnote / caveat shown at the bottom. */
  note?: string;
  /** Make the tile span the full grid width (e.g. live TV, agent). */
  wide?: boolean;
  /** When set, the status badge becomes a link opening the raw JSON feed in a new tab. */
  dataHref?: string;
  children: ComponentChildren;
}

const STATUS_LABEL: Record<DataStatus, string> = {
  live: "LIVE",
  demo: "DEMO",
  loading: "…",
  error: "ERR",
};

export function Panel({ title, status, description, count, updatedAt, note, wide, dataHref, children }: Props) {
  return (
    <section class={`panel${wide ? " panel-wide" : ""}`}>
      <header class="panel-header">
        <div class="panel-heading">
          <h2 class="panel-title">{title}</h2>
          {description && <p class="panel-desc">{description}</p>}
        </div>
        <div class="panel-status">
          {count != null && <span class="count-pill">{count}</span>}
          {dataHref ? (
            <a
              class={`badge badge-${status} badge-link`}
              href={dataHref}
              target="_blank"
              rel="noopener noreferrer"
              title="Open raw JSON feed in a new tab"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <i class="badge-dot" />
              {STATUS_LABEL[status]}
              <span class="badge-link-icon" aria-hidden="true">↗</span>
            </a>
          ) : (
            <span class={`badge badge-${status}`}>
              <i class="badge-dot" />
              {STATUS_LABEL[status]}
            </span>
          )}
        </div>
      </header>
      <div class="panel-body">{children}</div>
      <footer class="panel-note">
        {updatedAt && <RelativeTime at={updatedAt} />}
        {note && <span class="panel-note-text">{note}</span>}
      </footer>
    </section>
  );
}
