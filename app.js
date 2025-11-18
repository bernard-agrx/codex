import {
  lonLatToWorld,
  worldToLonLat,
  clampLat,
  normalizeLon,
  TILE_SIZE,
} from './globeMath.js';

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
const SCREENSHOT_DELAYS = [
  { delay: 5000, label: '5 seconds' },
  { delay: 10000, label: '10 seconds' },
  { delay: 30000, label: '30 seconds' },
];

const globeCanvas = document.getElementById('globeCanvas');
const globeCtx = globeCanvas.getContext('2d');
const loading = document.getElementById('loading');
const globe = document.getElementById('globe');
const zoomButtons = document.querySelectorAll('[data-zoom]');
const screenshotGrid = document.getElementById('screenshotGallery');
const screenshotStatus = document.getElementById('screenshotStatus');

const sourceCanvas = document.createElement('canvas');
sourceCanvas.width = MAP_WIDTH;
sourceCanvas.height = MAP_HEIGHT;
const sourceCtx = sourceCanvas.getContext('2d');

let mapImageData = null;
let renderQueued = false;
const screenshotEntries = [];
let screenshotTimersStarted = false;

let pointerActive = false;
let pointerId = null;
let dragStart = { x: 0, y: 0 };
let startWorldPosition = null;
let refreshTimer = null;

function buildUrl(overrides = {}) {
  const { lat, lon, zoom, layer } = { ...state, ...overrides };
  return `https://static-maps.yandex.ru/1.x/?l=${layer}&ll=${lon.toFixed(
    6
  )},${lat.toFixed(6)}&z=${zoom}&size=${MAP_WIDTH},${MAP_HEIGHT}`;
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

function createScreenshotEntry(config) {
  const card = document.createElement('figure');
  card.className = 'capture-card pending';
  const preview = document.createElement('div');
  preview.className = 'capture-preview';
  const placeholder = document.createElement('span');
  placeholder.textContent = `Waiting ${config.label}…`;
  const img = document.createElement('img');
  img.alt = `Globe capture after ${config.label}`;
  img.hidden = true;
  preview.append(placeholder, img);
  const caption = document.createElement('figcaption');
  caption.textContent = `Waiting for ${config.label} capture…`;
  const downloadLink = document.createElement('a');
  downloadLink.className = 'capture-download';
  downloadLink.textContent = 'Download PNG';
  downloadLink.download = `globe-${config.label.replace(/[^0-9]+/g, '') || 'capture'}.png`;
  downloadLink.hidden = true;
  downloadLink.setAttribute(
    'aria-label',
    `Download the ${config.label} screenshot once it is ready`
  );
  card.append(preview, caption, downloadLink);
  screenshotGrid?.appendChild(card);
  return {
    ...config,
    card,
    caption,
    img,
    placeholder,
    captured: false,
    downloadLink,
  };
}

function initScreenshotEntries() {
  if (!screenshotGrid) return;
  SCREENSHOT_DELAYS.forEach((config) => {
    screenshotEntries.push(createScreenshotEntry(config));
  });
}

function setScreenshotStatus(message) {
  if (screenshotStatus) {
    screenshotStatus.textContent = message;
  }
}

function startScreenshotTimers() {
  if (screenshotTimersStarted || screenshotEntries.length === 0) return;
  screenshotTimersStarted = true;
  setScreenshotStatus('Capturing globe snapshots…');
  screenshotEntries.forEach((entry) => {
    entry.timeoutId = setTimeout(() => captureScreenshot(entry), entry.delay);
  });
}

function captureScreenshot(entry) {
  requestAnimationFrame(() => {
    try {
      const dataUrl = globeCanvas.toDataURL('image/png');
      entry.img.src = dataUrl;
      entry.img.hidden = false;
      entry.placeholder.hidden = true;
      entry.card.classList.remove('pending');
      entry.card.classList.add('captured');
      entry.caption.textContent = `Captured after ${entry.label}.`;
      if (entry.downloadLink) {
        entry.downloadLink.href = dataUrl;
        entry.downloadLink.hidden = false;
        entry.downloadLink.setAttribute(
          'aria-label',
          `Download the ${entry.label} screenshot`
        );
      }
      entry.captured = true;
      if (screenshotEntries.every((item) => item.captured)) {
        setScreenshotStatus('All timed screenshots captured.');
      }
    } catch (error) {
      entry.caption.textContent = `Capture failed after ${entry.label}.`;
      if (entry.downloadLink) {
        entry.downloadLink.hidden = true;
      }
    }
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
  startScreenshotTimers();
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
    startScreenshotTimers();
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

initScreenshotEntries();

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
