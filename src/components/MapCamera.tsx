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
  const [bust, setBust] = useState(() => Date.now());
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  // Find the nearest camera whenever the business changes.
  useEffect(() => {
    let cancelled = false;
    setCam(null);
    setErr(false);
    setImgFailed(false);
    setUseDirect(false);
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

  return (
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
            <img
              class="map-camera-img"
              src={`${baseSrc}${sep}t=${bust}`}
              alt={`Traffic camera at ${cam.name}`}
              onError={onImgError}
              onLoad={() => setImgFailed(false)}
            />
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
  );
}
