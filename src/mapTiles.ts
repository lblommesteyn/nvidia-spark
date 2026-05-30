const tileSize = 256;
const toronto = { lat: 43.6532, lng: -79.3832 };
const cartoSubdomains = ["a", "b", "c", "d"];

type SignalType = "transit" | "event" | "road" | "weather";

interface SignalMarker {
  label: string;
  detail: string;
  lat: number;
  lng: number;
  type: SignalType;
  impact: number;
}

const business = {
  label: "Harbour Grind",
  detail: "Financial District cafe",
  lat: 43.6469,
  lng: -79.3817,
  radiusMeters: 1800,
};

const signals: SignalMarker[] = [
  {
    label: "Union delay",
    detail: "-18% AM walk-in pressure",
    lat: 43.6453,
    lng: -79.3806,
    type: "transit",
    impact: 0.74,
  },
  {
    label: "Arena event",
    detail: "+21% evening prep demand",
    lat: 43.6435,
    lng: -79.3791,
    type: "event",
    impact: 0.88,
  },
  {
    label: "Lane restriction",
    detail: "+10 min delivery risk",
    lat: 43.6485,
    lng: -79.3842,
    type: "road",
    impact: 0.58,
  },
  {
    label: "Clear weather",
    detail: "+9% patio-adjacent demand",
    lat: 43.651,
    lng: -79.386,
    type: "weather",
    impact: 0.42,
  },
];

const lonToTile = (lng: number, zoom: number) => ((lng + 180) / 360) * 2 ** zoom;

const latToTile = (lat: number, zoom: number) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
};

const markerPosition = (lat: number, lng: number, zoom: number, centerX: number, centerY: number, width: number, height: number) => ({
  x: (lonToTile(lng, zoom) - centerX) * tileSize + width / 2,
  y: (latToTile(lat, zoom) - centerY) * tileSize + height / 2,
});

const radiusToPixels = (lat: number, lng: number, meters: number, zoom: number) => {
  const metersPerLngDegree = 111_320 * Math.cos((lat * Math.PI) / 180);
  const lngDelta = meters / metersPerLngDegree;
  return Math.abs(lonToTile(lng + lngDelta, zoom) - lonToTile(lng, zoom)) * tileSize;
};

export function mountTorontoMap(container: HTMLElement, zoom = 13) {
  const render = () => {
    const width = container.clientWidth || 640;
    const height = container.clientHeight || 360;
    const centerX = lonToTile(toronto.lng, zoom);
    const centerY = latToTile(toronto.lat, zoom);
    const tileX = Math.floor(centerX);
    const tileY = Math.floor(centerY);
    const offsetX = (centerX - tileX) * tileSize;
    const offsetY = (centerY - tileY) * tileSize;

    container.innerHTML = "";
    const layer = document.createElement("div");
    layer.className = "map-tile-layer";
    container.appendChild(layer);

    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const img = document.createElement("img");
        const subdomain = cartoSubdomains[Math.abs(tileX + dx + tileY + dy) % cartoSubdomains.length];
        img.alt = "";
        img.decoding = "async";
        img.loading = "lazy";
        img.src = `https://${subdomain}.basemaps.cartocdn.com/dark_all/${zoom}/${tileX + dx}/${tileY + dy}.png`;
        img.style.left = `${width / 2 + dx * tileSize - offsetX}px`;
        img.style.top = `${height / 2 + dy * tileSize - offsetY}px`;
        layer.appendChild(img);
      }
    }

    const businessPosition = markerPosition(business.lat, business.lng, zoom, centerX, centerY, width, height);
    const radius = Math.max(86, radiusToPixels(business.lat, business.lng, business.radiusMeters, zoom));
    const radiusElement = document.createElement("span");
    radiusElement.className = "map-radius";
    radiusElement.style.left = `${businessPosition.x}px`;
    radiusElement.style.top = `${businessPosition.y}px`;
    radiusElement.style.width = `${radius * 2}px`;
    radiusElement.style.height = `${radius * 2}px`;
    container.appendChild(radiusElement);

    const businessMarker = document.createElement("span");
    businessMarker.className = "map-business";
    businessMarker.style.left = `${businessPosition.x}px`;
    businessMarker.style.top = `${businessPosition.y}px`;
    businessMarker.innerHTML = `<span class="map-tooltip"><strong>${business.label}</strong>${business.detail}</span>`;
    container.appendChild(businessMarker);

    signals.forEach((marker) => {
      const { x, y } = markerPosition(marker.lat, marker.lng, zoom, centerX, centerY, width, height);
      const element = document.createElement("span");
      element.className = `map-signal map-signal--${marker.type}`;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.setProperty("--impact", marker.impact.toString());
      element.innerHTML = `<span class="map-tooltip"><strong>${marker.label}</strong>${marker.detail}</span>`;
      container.appendChild(element);
    });

    const attribution = document.createElement("span");
    attribution.className = "osm-attribution";
    attribution.textContent = "© OpenStreetMap © CARTO";
    container.appendChild(attribution);
  };

  render();

  const observer = new ResizeObserver(render);
  observer.observe(container);
  return () => observer.disconnect();
}
