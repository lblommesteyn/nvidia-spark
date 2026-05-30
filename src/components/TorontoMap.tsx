import { useEffect, useRef, useState } from "preact/hooks";
import maplibregl from "maplibre-gl";
import { api } from "../services/api";
import { TORONTO_BOUNDS, TORONTO_CENTER } from "../types";

interface Props {
  /** Business location — rendered as a distinct home pin + recenters the map. */
  home?: { lon: number; lat: number; label: string } | null;
}

type LayerKey = "flow" | "traffic" | "construction" | "bikeshare" | "transit";

const LAYER_META: { key: LayerKey; label: string }[] = [
  { key: "flow", label: "Flow areas" },
  { key: "traffic", label: "Traffic" },
  { key: "construction", label: "Construction" },
  { key: "bikeshare", label: "Bike share" },
  { key: "transit", label: "Transit" },
];

export function TorontoMap({ home }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const homeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({
    flow: true,
    traffic: true,
    construction: true,
    bikeshare: true,
    transit: false,
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
      maxBounds: TORONTO_BOUNDS,
      minZoom: 10.5,
      maxZoom: 18,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", async () => {
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

        // Popups for the point feeds.
        for (const id of ["bike-pts", "closure-pts", "transit-pts"]) {
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
    });

    return () => {
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
    set("closure-pts", visible.construction);
    set("bike-pts", visible.bikeshare);
    set("transit-pts", visible.transit);
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
