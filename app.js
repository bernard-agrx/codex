const MAP_WIDTH = 650;
const MAP_HEIGHT = 450;
const TILE_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 17;

const state = {
  lat: 0,
  lon: 0,
  zoom: 2,
  layer: 'sat',
};

const mapImage = document.getElementById('mapImage');
const loading = document.getElementById('loading');
const globe = document.getElementById('globe');
const zoomButtons = document.querySelectorAll('[data-zoom]');

let pointerActive = false;
let pointerId = null;
let dragStart = { x: 0, y: 0 };
let startWorldPosition = null;
let refreshTimer = null;

function lonLatToWorld(lon, lat, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y =
    (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function worldToLonLat(x, y, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

function clampLat(lat) {
  return Math.max(-85, Math.min(85, lat));
}

function normalizeLon(lon) {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  return wrapped;
}

function buildUrl() {
  const { lat, lon, zoom, layer } = state;
  return `https://static-maps.yandex.ru/1.x/?l=${layer}&ll=${lon.toFixed(
    6
  )},${lat.toFixed(6)}&z=${zoom}&size=${MAP_WIDTH},${MAP_HEIGHT}`;
}

function setLoading(isLoading) {
  loading.hidden = !isLoading;
  if (isLoading) {
    mapImage.style.opacity = 0.4;
  } else {
    mapImage.style.opacity = 1;
  }
}

function updateMap() {
  clearTimeout(refreshTimer);
  setLoading(true);
  mapImage.src = buildUrl();
}

mapImage.addEventListener('load', () => {
  setLoading(false);
});

function scheduleUpdate() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(updateMap, 120);
}

function getScaleFactors() {
  const rect = globe.getBoundingClientRect();
  return {
    x: MAP_WIDTH / rect.width,
    y: MAP_HEIGHT / rect.height,
  };
}

function handlePointerDown(event) {
  pointerActive = true;
  pointerId = event.pointerId;
  globe.setPointerCapture(pointerId);
  dragStart = { x: event.clientX, y: event.clientY };
  startWorldPosition = lonLatToWorld(state.lon, state.lat, state.zoom);
}

function handlePointerMove(event) {
  if (!pointerActive || event.pointerId !== pointerId) return;
  event.preventDefault();
  const scale = getScaleFactors();
  const deltaX = (event.clientX - dragStart.x) * scale.x;
  const deltaY = (event.clientY - dragStart.y) * scale.y;
  const worldX = startWorldPosition.x - deltaX;
  const worldY = startWorldPosition.y - deltaY;
  const { lon, lat } = worldToLonLat(worldX, worldY, state.zoom);
  state.lon = normalizeLon(lon);
  state.lat = clampLat(lat);
  scheduleUpdate();
}

function handlePointerUp(event) {
  if (!pointerActive || (event.pointerId && event.pointerId !== pointerId)) {
    return;
  }
  pointerActive = false;
  if (pointerId !== null) {
    try {
      globe.releasePointerCapture(pointerId);
    } catch (err) {
      // ignored
    }
  }
  pointerId = null;
  startWorldPosition = null;
  updateMap();
}

function setZoom(nextZoom) {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  if (clamped === state.zoom) return;
  state.zoom = clamped;
  updateMap();
}

function handleWheel(event) {
  event.preventDefault();
  const direction = event.deltaY > 0 ? -1 : 1;
  setZoom(state.zoom + direction);
}

zoomButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const direction = button.dataset.zoom === 'in' ? 1 : -1;
    setZoom(state.zoom + direction);
  });
});

globe.addEventListener('pointerdown', handlePointerDown);
globe.addEventListener('pointermove', handlePointerMove);
globe.addEventListener('pointerup', handlePointerUp);
globe.addEventListener('pointerleave', handlePointerUp);
globe.addEventListener('pointercancel', handlePointerUp);
globe.addEventListener('wheel', handleWheel, { passive: false });

updateMap();
