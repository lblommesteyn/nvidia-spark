import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Business, type TrafficCamera } from "../services/api";

/**
 * Nearest City of Toronto traffic camera to the selected business, shown as a
 * small collapsible tab over the map (same visual language as the layer box).
 * Snapshots refresh ~every 60s upstream; we re-pull every 30s with a cache-bust.
 */

const REFRESH_MS = 30_000;

export function MapCamera({ business }: { business: Business | null }) {
  const [cam, setCam] = useState<TrafficCamera | null>(null);
  const [open, setOpen] = useState(true);
  const [err, setErr] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [useDirect, setUseDirect] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [bust, setBust] = useState(() => Date.now());
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  // Close the enlarged view on Escape.
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  // Find the nearest camera whenever the business changes.
  useEffect(() => {
    let cancelled = false;
    setCam(null);
    setErr(false);
    setImgFailed(false);
    setUseDirect(false);
    setZoom(false);
    if (!business) return;
    api
      .nearestCamera(business.lon, business.lat)
      .then((list) => {
        if (cancelled) return;
        if (list.length) {
          setCam(list[0]);
          setBust(Date.now());
        } else {
          setErr(true);
        }
      })
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, [business?.id]);

  // Periodic snapshot refresh while open + visible.
  useEffect(() => {
    if (!cam || !open) return;
    tick.current = setInterval(() => setBust(Date.now()), REFRESH_MS);
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, [cam?.recId, open]);

  if (!business || (err && !cam)) return null;

  const distLabel = cam
    ? cam.distanceM < 1000
      ? `${cam.distanceM} m away`
      : `${(cam.distanceM / 1000).toFixed(1)} km away`
    : "";

  // Prefer our same-origin proxy (fresh https + cache headers). If it can't load
  // (e.g. the host can't egress to the camera CDN), fall back to the upstream URL
  // directly — the browser usually has internet even when the server doesn't.
  const baseSrc = useDirect && cam?.directUrl ? cam.directUrl : cam?.imageUrl;
  const sep = baseSrc?.includes("?") ? "&" : "?";

  function onImgError() {
    if (!useDirect && cam?.directUrl) {
      // First failure on the proxy → retry once against the upstream snapshot.
      setUseDirect(true);
    } else {
      setImgFailed(true);
    }
  }

  const imgSrc = `${baseSrc}${sep}t=${bust}`;

  return (
    <>
    <div class={`map-camera${open ? "" : " is-collapsed"}`}>
      <button class="map-camera-head" onClick={() => setOpen((v) => !v)} title={open ? "Collapse camera" : "Expand camera"}>
        <span class="map-camera-dot" />
        <span class="map-camera-title">Nearest camera</span>
        <span class="map-camera-chevron">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div class="map-camera-body">
          {!cam ? (
            <div class="map-camera-loading">Finding nearest camera…</div>
          ) : imgFailed ? (
            <div class="map-camera-loading">Snapshot unavailable</div>
          ) : (
            <div class="map-camera-frame">
              <img
                class="map-camera-img"
                src={imgSrc}
                alt={`Traffic camera at ${cam.name}`}
                onError={onImgError}
                onLoad={() => setImgFailed(false)}
                onClick={() => setZoom(true)}
              />
              <button
                class="map-camera-expand"
                onClick={() => setZoom(true)}
                title="Enlarge camera"
                aria-label="Enlarge camera"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            </div>
          )}
          {cam && (
            <div class="map-camera-caption">
              <span class="map-camera-name" title={cam.name}>{cam.name}</span>
              <span class="map-camera-meta muted">{distLabel} · live · City of Toronto</span>
            </div>
          )}
        </div>
      )}
    </div>

    {zoom && cam && !imgFailed && (
      <div class="cam-lightbox" onClick={() => setZoom(false)} role="dialog" aria-modal="true">
        <button class="cam-lightbox-close" onClick={() => setZoom(false)} aria-label="Close">×</button>
        <figure class="cam-lightbox-fig" onClick={(e) => e.stopPropagation()}>
          <img class="cam-lightbox-img" src={imgSrc} alt={`Traffic camera at ${cam.name}`} onError={onImgError} />
          <figcaption class="cam-lightbox-cap">
            <strong>{cam.name}</strong>
            <span class="muted">{distLabel} · live · City of Toronto</span>
          </figcaption>
        </figure>
      </div>
    )}
    </>
  );
}
