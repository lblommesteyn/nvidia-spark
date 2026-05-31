import { useEffect, useRef, useState } from "preact/hooks";
import maplibregl from "maplibre-gl";
import { api } from "../services/api";
import { TORONTO_BOUNDS, TORONTO_CENTER } from "../types";

interface Props {
  /** Business location — rendered as a distinct home pin + recenters the map. */
  home?: { lon: number; lat: number; label: string } | null;
}

type LayerKey = "flow" | "traffic" | "construction" | "bikeshare" | "transit" | "routes" | "gotrains" | "places";

/** Default 3D camera — a tilted, slightly rotated view so the city reads as 3D. */
const DEFAULT_PITCH = 50;
const DEFAULT_BEARING = -18;

const LAYER_META: { key: LayerKey; label: string }[] = [
  { key: "flow", label: "Flow areas" },
  { key: "traffic", label: "Traffic" },
  { key: "routes", label: "Transit lines (TTC · GO)" },
  { key: "gotrains", label: "GO Trains (simulated)" },
  { key: "construction", label: "Construction" },
  { key: "bikeshare", label: "Bike share" },
  { key: "transit", label: "TTC vehicles" },
  { key: "places", label: "Events · Parking · Flights" },
];

export function TorontoMap({ home }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const homeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [tilted, setTilted] = useState(true);
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({
    flow: true,
    traffic: true,
    routes: true,
    gotrains: true,
    construction: true,
    bikeshare: true,
    transit: false,
    places: true,
  });
  const [stats, setStats] = useState<{ closures: number; bikes: number; ttc: number }>({
    closures: 0,
    bikes: 0,
    ttc: 0,
  });

  // Initialize the map + all data layers once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/dark",
      center: [TORONTO_CENTER.lon, TORONTO_CENTER.lat],
      zoom: 12,
      pitch: DEFAULT_PITCH,
      bearing: DEFAULT_BEARING,
      maxBounds: TORONTO_BOUNDS,
      minZoom: 10.5,
      maxZoom: 18,
      maxPitch: 70,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    // MapLibre measures its container at init. When the dashboard mounts the
    // map can be revealed/laid-out in the same tick, leaving the canvas sized to
    // an intermediate layout (e.g. mid reveal-transition) and never repainting
    // at the final size — a fully black map. A ResizeObserver catches size
    // changes, and we also kick a few deferred resizes to cover the case where
    // the container settles to its final height *after* the .terminal-app
    // opacity-reveal transition (which does not always emit a resize event).
    const kick = () => {
      try {
        map.resize();
        map.triggerRepaint();
      } catch {
        /* map may be torn down */
      }
    };
    const ro = new ResizeObserver(kick);
    if (containerRef.current) ro.observe(containerRef.current);
    const rafId = requestAnimationFrame(() => requestAnimationFrame(kick));
    // Cover the 180ms reveal transition + late layout settle.
    const kickTimers = [120, 300, 600, 1000].map((ms) => window.setTimeout(kick, ms));

    // Basemap watchdog: the basemap style/tiles are fetched from the public
    // OpenFreeMap CDN, so a flaky network at the venue can leave a black canvas
    // with no "load" event ever firing. If we don't reach `load` within 9s,
    // surface a visible, honest fallback instead of an unexplained black box.
    const watchdog = window.setTimeout(() => {
      if (!mapRef.current?.isStyleLoaded()) setMapError(true);
    }, 9000);

    // MapLibre emits "error" for style + tile failures. A failed *style* load is
    // fatal (no basemap); individual tile errors are tolerable. Only trip the
    // fallback when the style itself failed to load.
    map.on("error", (e) => {
      const msg = String((e as { error?: { message?: string } }).error?.message ?? "");
      if (!map.isStyleLoaded() && /style|sprite|glyph/i.test(msg)) setMapError(true);
    });


    map.on("load", async () => {
      // ---- 3D building extrusions (context for the tilted view) ----
      try {
        const style = map.getStyle();
        const vectorSrc = Object.entries(style.sources ?? {}).find(
          ([, s]) => (s as { type?: string }).type === "vector",
        )?.[0];
        const firstSymbol = style.layers?.find((l) => l.type === "symbol")?.id;
        if (vectorSrc) {
          map.addLayer(
            {
              id: "3d-buildings",
              source: vectorSrc,
              "source-layer": "building",
              type: "fill-extrusion",
              minzoom: 13,
              paint: {
                "fill-extrusion-color": [
                  "interpolate", ["linear"], ["coalesce", ["get", "render_height"], 6],
                  0, "#16202c",
                  40, "#1d2c3c",
                  120, "#27425c",
                ],
                "fill-extrusion-height": [
                  "interpolate", ["linear"], ["zoom"],
                  13, 0,
                  14.5, ["coalesce", ["get", "render_height"], 6],
                ],
                "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
                "fill-extrusion-opacity": 0.82,
              },
            },
            firstSymbol,
          );
        }
      } catch {
        /* buildings optional — style may lack a vector building layer */
      }

      // ---- Neighbourhood flow choropleth ----
      try {
        const flow = await api.flow();
        map.addSource("flow", { type: "geojson", data: flow as unknown as GeoJSON.FeatureCollection });
        map.addLayer({
          id: "flow-fill",
          type: "fill",
          source: "flow",
          paint: {
            "fill-color": [
              "interpolate", ["linear"], ["get", "score"],
              0, "#10231a",
              0.18, "#1f5135",
              0.4, "#caa017",
              0.66, "#e6700f",
              1, "#e63946",
            ],
            "fill-opacity": ["interpolate", ["linear"], ["get", "score"], 0, 0.12, 1, 0.5],
          },
        });
        map.addLayer({
          id: "flow-line",
          type: "line",
          source: "flow",
          paint: { "line-color": "#2a2a2a", "line-width": 0.6, "line-opacity": 0.7 },
        });
        map.on("click", "flow-fill", (e) => {
          const p = e.features?.[0]?.properties as
            | { name: string; score: number; level: string; topSignal: string }
            | undefined;
          if (!p) return;
          new maplibregl.Popup({ offset: 4 })
            .setLngLat(e.lngLat)
            .setHTML(
              `<strong>${p.name}</strong><br/>Flow: <b>${p.level}</b> (${Number(p.score).toFixed(2)})<br/>Top signal: ${p.topSignal}`,
            )
            .addTo(map);
        });
      } catch {
        /* flow optional */
      }

      // ---- Live traffic congestion (red/amber/green road traces) ----
      try {
        const traffic = await api.traffic();
        map.addSource("traffic", {
          type: "geojson",
          data: traffic as unknown as GeoJSON.FeatureCollection,
        });
        // Soft glow underlay so heavy roads pop on the dark basemap.
        map.addLayer({
          id: "traffic-glow",
          type: "line",
          source: "traffic",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 11, 6, 16, 14],
            "line-opacity": 0.18,
            "line-blur": 3,
          },
        });
        map.addLayer({
          id: "traffic-line",
          type: "line",
          source: "traffic",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 5],
            "line-opacity": 0.9,
          },
        });
        map.on("click", "traffic-line", (e) => {
          const p = e.features?.[0]?.properties as
            | { road: string; congestion: string; speed: number; freeFlow: number }
            | undefined;
          if (!p) return;
          new maplibregl.Popup({ offset: 6 })
            .setLngLat(e.lngLat)
            .setHTML(
              `<strong>${p.road}</strong><br/>${p.congestion.toUpperCase()} · ${p.speed} km/h (free-flow ${p.freeFlow})`,
            )
            .addTo(map);
        });
        map.on("mouseenter", "traffic-line", () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", "traffic-line", () => (map.getCanvas().style.cursor = ""));
      } catch {
        /* traffic optional */
      }

      // ---- Transit route lines (TTC subway/streetcar + GO corridors) ----
      try {
        const routes = await api.transitRoutes();
        map.addSource("routes", {
          type: "geojson",
          data: routes as unknown as GeoJSON.FeatureCollection,
        });
        // Dark casing under every line so colours pop on the dark basemap.
        map.addLayer({
          id: "route-casing",
          type: "line",
          source: "routes",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#05080c",
            "line-width": ["interpolate", ["linear"], ["zoom"], 11, 4, 16, 9],
            "line-opacity": 0.7,
          },
        });
        // GO corridors — dashed so they read distinctly from the TTC subway.
        map.addLayer({
          id: "route-go",
          type: "line",
          source: "routes",
          filter: ["==", ["get", "mode"], "go"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 4],
            "line-dasharray": [2, 1.6],
            "line-opacity": 0.95,
          },
        });
        // TTC subway + streetcar — solid, slightly thicker.
        map.addLayer({
          id: "route-ttc",
          type: "line",
          source: "routes",
          filter: ["in", ["get", "mode"], ["literal", ["subway", "streetcar"]]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": [
              "interpolate", ["linear"], ["zoom"],
              11, ["match", ["get", "mode"], "subway", 3, 1.6],
              16, ["match", ["get", "mode"], "subway", 6, 3.5],
            ],
            "line-opacity": 0.95,
          },
        });
        // Route name labels following the lines.
        map.addLayer({
          id: "route-labels",
          type: "symbol",
          source: "routes",
          layout: {
            "symbol-placement": "line",
            "text-field": ["get", "line"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9, 15, 13],
            "text-letter-spacing": 0.04,
            "symbol-spacing": 260,
          },
          paint: {
            "text-color": "#e9eef5",
            "text-halo-color": ["get", "color"],
            "text-halo-width": 1.6,
          },
        });
        map.on("click", "route-ttc", (e) => {
          const p = e.features?.[0]?.properties as { name: string } | undefined;
          if (!p) return;
          new maplibregl.Popup({ offset: 6 }).setLngLat(e.lngLat).setHTML(`<strong>${p.name}</strong>`).addTo(map);
        });
        map.on("click", "route-go", (e) => {
          const p = e.features?.[0]?.properties as { name: string } | undefined;
          if (!p) return;
          new maplibregl.Popup({ offset: 6 }).setLngLat(e.lngLat).setHTML(`<strong>${p.name}</strong>`).addTo(map);
        });
      } catch {
        /* routes optional */
      }

      // ---- GO Trains (live-ish moving dots along the corridors) ----
      try {
        const go = await api.goTrains();
        map.addSource("go-trains", {
          type: "geojson",
          data: go as unknown as GeoJSON.FeatureCollection,
        });
        map.addLayer({
          id: "go-train-glow",
          type: "circle",
          source: "go-trains",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 7, 15, 14],
            "circle-color": ["get", "color"],
            "circle-opacity": 0.25,
            "circle-blur": 1,
          },
        });
        map.addLayer({
          id: "go-train-pts",
          type: "circle",
          source: "go-trains",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3.5, 15, 6],
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#eafff1",
            "circle-stroke-width": 1.4,
            "circle-opacity": 0.95,
          },
        });
        map.on("click", "go-train-pts", (e) => {
          const p = e.features?.[0]?.properties as
            | { line: string; direction: string; speedKmh: number; nextStation: string }
            | undefined;
          if (!p) return;
          new maplibregl.Popup({ offset: 8 })
            .setLngLat(e.lngLat)
            .setHTML(
              `<strong>${p.line}</strong><br/>${p.direction} · ${p.speedKmh} km/h<br/>Next: ${p.nextStation}`,
            )
            .addTo(map);
        });
        map.on("mouseenter", "go-train-pts", () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", "go-train-pts", () => (map.getCanvas().style.cursor = ""));
      } catch {
        /* GO trains optional */
      }

      // ---- Dense point feeds ----
      try {
        const geo = await api.mapGeo();
        map.addSource("geo", { type: "geojson", data: geo as unknown as GeoJSON.FeatureCollection });

        // Transit (drawn first / underneath)
        map.addLayer({
          id: "transit-pts",
          type: "circle",
          source: "geo",
          filter: ["==", ["get", "category"], "transit"],
          layout: { visibility: "none" },
          paint: {
            "circle-radius": 2.5,
            "circle-color": "#9b5de5",
            "circle-opacity": 0.7,
          },
        });

        // Bike share — colored by supply/demand pressure
        map.addLayer({
          id: "bike-pts",
          type: "circle",
          source: "geo",
          filter: ["==", ["get", "category"], "bikeshare"],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 15, 5],
            "circle-color": [
              "match", ["get", "pressure"],
              "empty", "#ff4444",
              "full", "#4cc9f0",
              "low", "#ff7b00",
              "balanced", "#2dd4bf",
              "#2dd4bf",
            ],
            "circle-stroke-color": "#0a0a0a",
            "circle-stroke-width": 0.5,
            "circle-opacity": 0.9,
          },
        });

        // Construction / closures — Waze-style by severity
        map.addLayer({
          id: "closure-pts",
          type: "circle",
          source: "geo",
          filter: ["in", ["get", "category"], ["literal", ["construction", "mobility"]]],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 15, 6.5],
            "circle-color": [
              "match", ["get", "severity"],
              "major", "#ff4444",
              "moderate", "#ff7b00",
              "minor", "#ffaa00",
              "#ff7b00",
            ],
            "circle-stroke-color": "#1a0a00",
            "circle-stroke-width": 1,
            "circle-opacity": 0.92,
          },
        });

        // Places of interest — events, parking, flights (aviation), alerts
        map.addLayer({
          id: "place-pts",
          type: "circle",
          source: "geo",
          filter: ["in", ["get", "category"], ["literal", ["event", "parking", "aviation", "alert"]]],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3.5, 15, 7],
            "circle-color": [
              "match", ["get", "category"],
              "event", "#f72585",
              "parking", "#4895ef",
              "aviation", "#ffd166",
              "alert", "#ff5d5d",
              "#cccccc",
            ],
            "circle-stroke-color": "#0a0a0a",
            "circle-stroke-width": 0.8,
            "circle-opacity": 0.9,
          },
        });

        // Popups for the point feeds.
        for (const id of ["bike-pts", "closure-pts", "transit-pts", "place-pts"]) {
          map.on("click", id, (e) => {
            const p = e.features?.[0]?.properties as { title: string; detail: string } | undefined;
            if (!p) return;
            new maplibregl.Popup({ offset: 8 })
              .setLngLat(e.lngLat)
              .setHTML(`<strong>${p.title}</strong>${p.detail ? `<br/>${p.detail}` : ""}`)
              .addTo(map);
          });
          map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
          map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
        }

        const cats = geo.features.map((f) => f.properties.category);
        setStats({
          closures: cats.filter((c) => c === "construction" || c === "mobility").length,
          bikes: cats.filter((c) => c === "bikeshare").length,
          ttc: cats.filter((c) => c === "transit").length,
        });
      } catch {
        /* points optional */
      }

      setReady(true);
      setMapError(false);
      window.clearTimeout(watchdog);
      // Ensure the canvas matches the now-laid-out container.
      map.resize();
    });

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
      for (const t of kickTimers) clearTimeout(t);
      window.clearTimeout(watchdog);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Apply layer visibility toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const set = (layer: string, on: boolean) => {
      if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    };
    set("flow-fill", visible.flow);
    set("flow-line", visible.flow);
    set("traffic-glow", visible.traffic);
    set("traffic-line", visible.traffic);
    set("route-casing", visible.routes);
    set("route-go", visible.routes);
    set("route-ttc", visible.routes);
    set("route-labels", visible.routes);
    set("go-train-glow", visible.gotrains);
    set("go-train-pts", visible.gotrains);
    set("closure-pts", visible.construction);
    set("bike-pts", visible.bikeshare);
    set("transit-pts", visible.transit);
    set("place-pts", visible.places);
  }, [visible, ready]);

  // Live refresh: re-pull moving feeds and update sources in place.
  useEffect(() => {
    if (!ready) return;
    const refresh = async () => {
      const map = mapRef.current;
      if (!map) return;
      const [traffic, geo, flow] = await Promise.allSettled([
        api.traffic(),
        api.mapGeo(),
        api.flow(),
      ]);
      const update = (id: string, data: unknown) => {
        const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(data as GeoJSON.FeatureCollection);
      };
      if (traffic.status === "fulfilled") update("traffic", traffic.value);
      if (flow.status === "fulfilled") update("flow", flow.value);
      // GO trains glide on their own faster cadence (see below); pull fresh here too.
      api.goTrains().then((go) => update("go-trains", go)).catch(() => {});
      if (geo.status === "fulfilled") {
        update("geo", geo.value);
        const cats = geo.value.features.map((f) => f.properties.category);
        setStats({
          closures: cats.filter((c) => c === "construction" || c === "mobility").length,
          bikes: cats.filter((c) => c === "bikeshare").length,
          ttc: cats.filter((c) => c === "transit").length,
        });
      }
    };
    const t = setInterval(refresh, 45_000);
    return () => clearInterval(t);
  }, [ready]);

  // GO trains glide: re-pull their (time-based) positions on a fast cadence.
  useEffect(() => {
    if (!ready) return;
    const tick = async () => {
      const map = mapRef.current;
      if (!map) return;
      const src = map.getSource("go-trains") as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      try {
        src.setData((await api.goTrains()) as unknown as GeoJSON.FeatureCollection);
      } catch {
        /* keep last positions */
      }
    };
    const t = setInterval(tick, 5_000);
    return () => clearInterval(t);
  }, [ready]);

  // Tilt toggle: 3D (pitched) ↔ 2D (straight-down).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({
      pitch: tilted ? DEFAULT_PITCH : 0,
      bearing: tilted ? DEFAULT_BEARING : 0,
      duration: 600,
    });
  }, [tilted]);

  // Home (business) marker + recenter.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    homeMarkerRef.current?.remove();
    homeMarkerRef.current = null;
    if (!home) return;
    const el = document.createElement("div");
    el.className = "map-home";
    el.title = home.label;
    homeMarkerRef.current = new maplibregl.Marker({ element: el })
      .setLngLat([home.lon, home.lat])
      .setPopup(new maplibregl.Popup({ offset: 14 }).setHTML(`<strong>${home.label}</strong>`))
      .addTo(map);
    map.easeTo({ center: [home.lon, home.lat], zoom: 14, duration: 800 });
  }, [home]);

  return (
    <div class="map-wrap">
      <div ref={containerRef} class="map" />
      {mapError && (
        <div class="map-fallback">
          <div class="map-fallback-mark">TO</div>
          <div class="map-fallback-title">Basemap unavailable</div>
          <div class="map-fallback-sub">
            The map tiles couldn't be reached — every data feed and the agent
            below are still live. Check the network and reload to restore the map.
          </div>
        </div>
      )}
      <button
        type="button"
        class="map-view-toggle"
        onClick={() => setTilted((v) => !v)}
        title={tilted ? "Switch to top-down 2D view" : "Switch to tilted 3D view"}
      >
        {tilted ? "2D" : "3D"}
      </button>
      <div class="layer-toggle">
        <div class="layer-toggle-title">Layers</div>
        {LAYER_META.map((l) => (
          <label key={l.key} class="layer-row">
            <input
              type="checkbox"
              checked={visible[l.key]}
              onChange={(e) =>
                setVisible((v) => ({ ...v, [l.key]: (e.target as HTMLInputElement).checked }))
              }
            />
            {l.label}
          </label>
        ))}
        <div class="layer-stats">
          {stats.closures} closures · {stats.bikes} stations · {stats.ttc} vehicles
        </div>
      </div>
    </div>
  );
}
