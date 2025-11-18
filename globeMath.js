export const TILE_SIZE = 256;

export function lonLatToWorld(lon, lat, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y =
    (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

export function worldToLonLat(x, y, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

export function clampLat(lat) {
  return Math.max(-85, Math.min(85, lat));
}

export function normalizeLon(lon) {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  return wrapped;
}
