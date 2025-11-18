import {
  lonLatToWorld,
  worldToLonLat,
  clampLat,
  normalizeLon,
  TILE_SIZE,
} from './globeMath.js';

const API_KEY = 'b40ca0e3-470d-4bf8-a41d-1247ab4711c8';
const MAP_WIDTH = 650;
const MAP_HEIGHT = 450;
const MIN_ZOOM = 1;
const MAX_ZOOM = 17;

const state = {
  lat: 0,
  lon: 0,
  zoom: 2,
  layer: 'sat',
};

const INITIAL_PRELOAD_ZOOMS = [2, 3];

const globeCanvas = document.getElementById('globeCanvas');
const globeCtx = globeCanvas.getContext('2d');
const loading = document.getElementById('loading');
const globe = document.getElementById('globe');
const zoomButtons = document.querySelectorAll('[data-zoom]');

const sourceCanvas = document.createElement('canvas');
sourceCanvas.width = MAP_WIDTH;
sourceCanvas.height = MAP_HEIGHT;
const sourceCtx = sourceCanvas.getContext('2d');

let mapImageData = null;
let renderQueued = false;

let pointerActive = false;
let pointerId = null;
let dragStart = { x: 0, y: 0 };
let startWorldPosition = null;
let refreshTimer = null;

function buildUrl(overrides = {}) {
  const { lat, lon, zoom, layer } = { ...state, ...overrides };
  return `https://static-maps.yandex.ru/1.x/?l=${layer}&ll=${lon.toFixed(
    6
  )},${lat.toFixed(6)}&z=${zoom}&size=${MAP_WIDTH},${MAP_HEIGHT}&apikey=${API_KEY}`;
}

function setLoading(isLoading) {
  loading.hidden = !isLoading;
  globeCanvas.style.opacity = isLoading ? 0.4 : 1;
}

function ensureCanvasSize() {
  const rect = globeCanvas.getBoundingClientRect();
  const displaySize = Math.min(rect.width, rect.height);
  const dpr = window.devicePixelRatio || 1;
  const targetSize = Math.max(1, Math.round(displaySize * dpr));
  if (globeCanvas.width !== targetSize || globeCanvas.height !== targetSize) {
    globeCanvas.width = targetSize;
    globeCanvas.height = targetSize;
    globeCanvas.style.width = `${displaySize}px`;
    globeCanvas.style.height = `${displaySize}px`;
  }
  return targetSize;
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSphere();
  });
}

function renderSphere() {
  if (!mapImageData) return;
  const size = ensureCanvasSize();
  const radius = size / 2;
  const radiusSquared = radius * radius;
  const lat0 = (state.lat * Math.PI) / 180;
  const lon0 = (state.lon * Math.PI) / 180;
  const sinLat0 = Math.sin(lat0);
  const cosLat0 = Math.cos(lat0);
  const dest = globeCtx.createImageData(size, size);
  const destData = dest.data;
  const srcData = mapImageData.data;
  const centerWorld = lonLatToWorld(state.lon, state.lat, state.zoom);
  const worldScale = Math.pow(2, state.zoom) * TILE_SIZE;
  const halfWidth = MAP_WIDTH / 2;
  const halfHeight = MAP_HEIGHT / 2;

  for (let y = 0; y < size; y++) {
    const yNorth = radius - (y + 0.5);
    const rowOffset = y * size * 4;
    for (let x = 0; x < size; x++) {
      const xEast = x + 0.5 - radius;
      const dist2 = xEast * xEast + yNorth * yNorth;
      if (dist2 > radiusSquared) {
        continue;
      }
      const dist = Math.sqrt(dist2);
      let latRad;
      let lonRad;
      if (dist === 0) {
        latRad = lat0;
        lonRad = lon0;
      } else {
        const c = Math.asin(dist / radius);
        const sinC = Math.sin(c);
        const cosC = Math.cos(c);
        latRad = Math.asin(
          cosC * sinLat0 + (yNorth * sinC * cosLat0) / dist
        );
        lonRad =
          lon0 +
          Math.atan2(
            xEast * sinC,
            dist * cosLat0 * cosC - yNorth * sinLat0 * sinC
          );
      }

      const latDeg = clampLat((latRad * 180) / Math.PI);
      const lonDeg = normalizeLon((lonRad * 180) / Math.PI);
      const world = lonLatToWorld(lonDeg, latDeg, state.zoom);
      let dxWorld = world.x - centerWorld.x;
      if (dxWorld > worldScale / 2) dxWorld -= worldScale;
      if (dxWorld < -worldScale / 2) dxWorld += worldScale;
      const dyWorld = world.y - centerWorld.y;
      const sampleX = Math.max(
        0,
        Math.min(MAP_WIDTH - 1, Math.floor(halfWidth + dxWorld))
      );
      const sampleY = Math.max(
        0,
        Math.min(MAP_HEIGHT - 1, Math.floor(halfHeight + dyWorld))
      );
      const srcIndex = (sampleY * MAP_WIDTH + sampleX) * 4;
      const destIndex = rowOffset + x * 4;
      destData[destIndex] = srcData[srcIndex];
      destData[destIndex + 1] = srcData[srcIndex + 1];
      destData[destIndex + 2] = srcData[srcIndex + 2];
      destData[destIndex + 3] = 255;
    }
  }

  globeCtx.putImageData(dest, 0, 0);
}

function updateMap() {
  clearTimeout(refreshTimer);
  setLoading(true);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    sourceCtx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    sourceCtx.drawImage(img, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    try {
      mapImageData = sourceCtx.getImageData(0, 0, MAP_WIDTH, MAP_HEIGHT);
      requestRender();
    } catch (error) {
      console.error('Unable to read map pixels', error);
      const fallbackSize = ensureCanvasSize();
      globeCtx.clearRect(0, 0, fallbackSize, fallbackSize);
      globeCtx.drawImage(img, 0, 0, fallbackSize, fallbackSize);
    }
    setLoading(false);
  };
  img.onerror = () => {
    setLoading(false);
  };
  img.src = buildUrl();
}

function scheduleUpdate() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(updateMap, 120);
  requestRender();
}

function preloadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

async function preloadInitialTiles() {
  const preloadPromises = INITIAL_PRELOAD_ZOOMS.map((zoom) =>
    preloadImage(buildUrl({ zoom }))
  );
  await Promise.all(preloadPromises);
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
  requestRender();
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
window.addEventListener('resize', requestRender);

(async function init() {
  setLoading(true);
  await preloadInitialTiles();
  updateMap();
})();
