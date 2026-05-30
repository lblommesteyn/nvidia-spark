import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { GridStack, type GridStackNode, type GridStackWidget } from "gridstack";
import "gridstack/dist/gridstack.min.css";

export interface GridTile {
  id: string;
  /** Default column position (0–11). Omit to auto-place. */
  x?: number;
  /** Default row position. Omit to auto-place. */
  y?: number;
  /** Default width in columns (1–12). */
  w: number;
  /** Default height in rows. */
  h: number;
  content: ComponentChildren;
}

interface Props {
  tiles: GridTile[];
  storageKey?: string;
}

type Geom = { x?: number; y?: number; w?: number; h?: number };

function loadSaved(key: string): Record<string, Geom> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Drag + resize dashboard backed by GridStack, integrated with Preact.
 *
 * Preact owns the DOM nodes (so it can update tile content), while GridStack
 * owns geometry. To avoid the two fighting we never put changing gs-* geometry
 * attributes in JSX — only a stable `gs-id`. Widgets are registered/updated
 * imperatively, and the layout is persisted to localStorage by id.
 */
export function DashboardGrid({ tiles, storageKey = "tomon-grid-layout" }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridStack | null>(null);
  const knownRef = useRef<Set<string>>(new Set());
  const savedRef = useRef<Record<string, Geom>>(loadSaved(storageKey));
  const defaultsRef = useRef<Record<string, Geom>>({});

  // Keep latest default geometry per tile id.
  for (const t of tiles) defaultsRef.current[t.id] = { x: t.x, y: t.y, w: t.w, h: t.h };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const persist = () => {
      const grid = gridRef.current;
      if (!grid) return;
      const nodes = grid.save(false) as GridStackWidget[];
      const map: Record<string, Geom> = {};
      for (const n of nodes) {
        if (n.id != null) map[String(n.id)] = { x: n.x, y: n.y, w: n.w, h: n.h };
      }
      savedRef.current = map;
      localStorage.setItem(storageKey, JSON.stringify(map));
    };

    if (!gridRef.current) {
      const grid = GridStack.init(
        {
          column: 12,
          cellHeight: 96,
          margin: 7,
          float: false,
          handle: ".panel-header",
          resizable: { handles: "e, se, s, sw, w" },
          columnOpts: { breakpointForWindow: true, breakpoints: [{ w: 760, c: 1 }] },
        },
        host,
      );
      gridRef.current = grid;
      // GridStack adopts pre-rendered children on init — seed known + geometry.
      grid.batchUpdate();
      for (const n of grid.engine.nodes as GridStackNode[]) {
        if (!n.id || !n.el) continue;
        const id = String(n.id);
        knownRef.current.add(id);
        const geom = savedRef.current[id] ?? defaultsRef.current[id];
        if (geom) grid.update(n.el, geom);
      }
      grid.batchUpdate(false);
      grid.on("change", persist);
      grid.on("resizestop dragstop", persist);
    }

    // Register any newly-rendered tiles (e.g. civic panels added after fetch).
    const grid = gridRef.current;
    const items = Array.from(
      host.querySelectorAll(":scope > .grid-stack-item"),
    ) as HTMLElement[];
    grid.batchUpdate();
    for (const el of items) {
      const id = el.getAttribute("gs-id");
      if (!id || knownRef.current.has(id)) continue;
      const def = defaultsRef.current[id] ?? {};
      const hasPos = def.x != null && def.y != null;
      const geom = savedRef.current[id] ?? (hasPos ? def : { ...def, autoPosition: true });
      grid.makeWidget(el, { id, ...geom });
      knownRef.current.add(id);
    }
    grid.batchUpdate(false);
  });

  // Reset-to-defaults handled in place (no full-page reload / white flash).
  useEffect(() => {
    const onReset = () => {
      const grid = gridRef.current;
      if (!grid) return;
      localStorage.removeItem(storageKey);
      savedRef.current = {};
      grid.batchUpdate();
      for (const n of grid.engine.nodes as GridStackNode[]) {
        if (!n.id || !n.el) continue;
        const def = defaultsRef.current[String(n.id)];
        if (!def) continue;
        const hasPos = def.x != null && def.y != null;
        grid.update(n.el, hasPos ? def : { ...def, autoPosition: true });
      }
      grid.batchUpdate(false);
    };
    window.addEventListener("tomon:reset-layout", onReset);
    return () => window.removeEventListener("tomon:reset-layout", onReset);
  }, [storageKey]);

  return (
    <div ref={hostRef} class="grid-stack dashboard-grid">
      {tiles.map((t) => (
        <div class="grid-stack-item" gs-id={t.id} key={t.id}>
          <div class="grid-stack-item-content">{t.content}</div>
        </div>
      ))}
    </div>
  );
}

/** Clear the saved layout and snap tiles back to defaults in place (no reload). */
export function resetDashboardLayout(storageKey = "tomon-grid-layout") {
  localStorage.removeItem(storageKey);
  window.dispatchEvent(new CustomEvent("tomon:reset-layout"));
}
