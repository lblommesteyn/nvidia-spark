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
export function mountTorontoMap(_c: HTMLElement, _z=13){return()=>{};}
