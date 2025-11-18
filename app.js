const TILE_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const INITIAL_ZOOM = 3;
// Higher rotate speed keeps drag interactions feeling snappy on both mouse and touchpad
const ROTATE_SPEED = 0.02;
const LAYER = 'sat';
const API_KEY = '91771089-0404-4273-a1b2-ee3aac827ea3';
const AUTO_ROTATE_SPEED = 0.25; // radians per second when idle
const PRELOAD_ZOOMS = [1, 2, 3];

const canvas = document.getElementById('glCanvas');
const loading = document.getElementById('loading');
const globe = document.getElementById('globe');
const preloadStatus = document.getElementById('preloadStatus');

const state = {
  yaw: 0,
  pitch: 0,
  zoom: INITIAL_ZOOM,
};

const atlasCache = new Map();
const atlasPromises = new Map();
const preloadedZooms = new Set();

const pointerState = {
  active: false,
  id: null,
  startX: 0,
  startY: 0,
  startYaw: 0,
  startPitch: 0,
};

let gl;
let program;
let buffers;
let texture;
let uniformLocations = {};
let attribLocations = {};
let textureReady = false;
let atlasVersion = 0;

function createShader(glContext, type, source) {
  const shader = glContext.createShader(type);
  glContext.shaderSource(shader, source);
  glContext.compileShader(shader);
  if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
    console.error(glContext.getShaderInfoLog(shader));
    glContext.deleteShader(shader);
    throw new Error('Shader compilation failed');
  }
  return shader;
}

function createProgram(glContext, vertexSource, fragmentSource) {
  const vertexShader = createShader(glContext, glContext.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(
    glContext,
    glContext.FRAGMENT_SHADER,
    fragmentSource
  );
  const prog = glContext.createProgram();
  glContext.attachShader(prog, vertexShader);
  glContext.attachShader(prog, fragmentShader);
  glContext.linkProgram(prog);
  if (!glContext.getProgramParameter(prog, glContext.LINK_STATUS)) {
    console.error(glContext.getProgramInfoLog(prog));
    throw new Error('Program link failed');
  }
  return prog;
}

function createSphere(glContext, latSegments = 64, lonSegments = 128) {
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let lat = 0; lat <= latSegments; lat += 1) {
    const v = lat / latSegments;
    const latAngle = v * Math.PI - Math.PI / 2;
    const sinLat = Math.sin(latAngle);
    const cosLat = Math.cos(latAngle);

    for (let lon = 0; lon <= lonSegments; lon += 1) {
      const u = lon / lonSegments;
      const lonAngle = u * Math.PI * 2;
      const sinLon = Math.sin(lonAngle);
      const cosLon = Math.cos(lonAngle);

      const x = cosLat * cosLon;
      const y = sinLat;
      const z = cosLat * sinLon;

      positions.push(x, y, z);
      uvs.push(u, v);
    }
  }

  for (let lat = 0; lat < latSegments; lat += 1) {
    for (let lon = 0; lon < lonSegments; lon += 1) {
      const first = lat * (lonSegments + 1) + lon;
      const second = first + lonSegments + 1;
      indices.push(first, second, first + 1);
      indices.push(second, second + 1, first + 1);
    }
  }

  const positionBuffer = glContext.createBuffer();
  glContext.bindBuffer(glContext.ARRAY_BUFFER, positionBuffer);
  glContext.bufferData(
    glContext.ARRAY_BUFFER,
    new Float32Array(positions),
    glContext.STATIC_DRAW
  );

  const uvBuffer = glContext.createBuffer();
  glContext.bindBuffer(glContext.ARRAY_BUFFER, uvBuffer);
  glContext.bufferData(glContext.ARRAY_BUFFER, new Float32Array(uvs), glContext.STATIC_DRAW);

  const indexBuffer = glContext.createBuffer();
  glContext.bindBuffer(glContext.ELEMENT_ARRAY_BUFFER, indexBuffer);
  glContext.bufferData(
    glContext.ELEMENT_ARRAY_BUFFER,
    new Uint16Array(indices),
    glContext.STATIC_DRAW
  );

  return {
    position: positionBuffer,
    uv: uvBuffer,
    indices: indexBuffer,
    count: indices.length,
  };
}

function createPerspectiveMatrix(fov, aspect, near, far) {
  const f = 1.0 / Math.tan(fov / 2);
  const rangeInv = 1 / (near - far);

  const matrix = new Float32Array(16);
  matrix[0] = f / aspect;
  matrix[5] = f;
  matrix[10] = (far + near) * rangeInv;
  matrix[11] = -1;
  matrix[14] = 2 * far * near * rangeInv;
  return matrix;
}

function createTranslationMatrix(x, y, z) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

function createRotationX(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new Float32Array([
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1,
  ]);
}

function createRotationY(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ]);
}

function multiplyMatrices(a, b) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let i = 0; i < 4; i += 1) {
        sum += a[row + i * 4] * b[i + col * 4];
      }
      out[row + col * 4] = sum;
    }
  }
  return out;
}

function resizeCanvas() {
  if (!gl) return;
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.floor(canvas.clientWidth * pixelRatio);
  const height = Math.floor(canvas.clientHeight * pixelRatio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

function setLoading(isLoading, message) {
  loading.hidden = !isLoading;
  if (typeof message === 'string') {
    loading.textContent = message;
  }
}

function updatePreloadStatus(currentZoom) {
  if (!preloadStatus) return;
  const remaining = PRELOAD_ZOOMS.filter((zoom) => !preloadedZooms.has(zoom));
  const completedCount = PRELOAD_ZOOMS.length - remaining.length;
  if (remaining.length === 0) {
    preloadStatus.textContent = 'Zoom 1–3 atlases cached for instant access.';
    preloadStatus.dataset.complete = 'true';
    return;
  }
  const activeZoom = currentZoom ?? remaining[0];
  preloadStatus.textContent = `Preloading zoom ${activeZoom} tiles (${completedCount}/${PRELOAD_ZOOMS.length})…`;
  preloadStatus.dataset.complete = 'false';
}

function buildTileUrl(x, y, z) {
  const base = 'https://core-renderer-tiles.maps.yandex.net/tiles';
  const params = new URLSearchParams({
    l: LAYER,
    v: '3.931.0',
    x: x.toString(),
    y: y.toString(),
    z: z.toString(),
    scale: '1',
    lang: 'en_US',
    apikey: API_KEY,
  });
  return `${base}?${params.toString()}`;
}

async function fetchTile(x, y, z) {
  const url = buildTileUrl(x, y, z);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Tile request failed');
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch (error) {
    console.error('Failed to fetch tile', x, y, z, error);
    return null;
  }
}

async function buildAtlas(zoom) {
  const tilesPerSide = 2 ** zoom;
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = TILE_SIZE * tilesPerSide;
  atlasCanvas.height = TILE_SIZE * tilesPerSide;
  const ctx = atlasCanvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, atlasCanvas.width, atlasCanvas.height);

  const tilePromises = [];
  for (let y = 0; y < tilesPerSide; y += 1) {
    for (let x = 0; x < tilesPerSide; x += 1) {
      tilePromises.push(
        fetchTile(x, y, zoom).then((bitmap) => {
          if (bitmap) {
            ctx.drawImage(bitmap, x * TILE_SIZE, y * TILE_SIZE);
            bitmap.close?.();
          }
        })
      );
    }
  }

  await Promise.all(tilePromises);
  return atlasCanvas;
}

function createTexture(glContext) {
  const tex = glContext.createTexture();
  glContext.bindTexture(glContext.TEXTURE_2D, tex);
  glContext.texImage2D(
    glContext.TEXTURE_2D,
    0,
    glContext.RGBA,
    1,
    1,
    0,
    glContext.RGBA,
    glContext.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255])
  );
  glContext.texParameteri(
    glContext.TEXTURE_2D,
    glContext.TEXTURE_MIN_FILTER,
    glContext.LINEAR_MIPMAP_LINEAR
  );
  glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MAG_FILTER, glContext.LINEAR);
  glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.REPEAT);
  glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE);
  return tex;
}

function uploadAtlasTexture(atlasCanvas) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  textureReady = true;
}

let lastFrameTime = 0;

function renderScene(timestamp = 0) {
  if (!gl || !program) {
    requestAnimationFrame(renderScene);
    return;
  }

  if (lastFrameTime === 0) {
    lastFrameTime = timestamp;
  }

  const deltaSeconds = (timestamp - lastFrameTime) / 1000;
  lastFrameTime = timestamp;

  if (!pointerState.active) {
    state.yaw += deltaSeconds * AUTO_ROTATE_SPEED;
  }
  resizeCanvas();

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
  gl.enableVertexAttribArray(attribLocations.position);
  gl.vertexAttribPointer(attribLocations.position, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
  gl.enableVertexAttribArray(attribLocations.uv);
  gl.vertexAttribPointer(attribLocations.uv, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.indices);

  const aspect = canvas.width / canvas.height;
  const projection = createPerspectiveMatrix((50 * Math.PI) / 180, aspect, 0.1, 100);
  const translation = createTranslationMatrix(0, 0, -2.6);
  const rotationX = createRotationX(state.pitch);
  const rotationY = createRotationY(state.yaw);
  const rotation = multiplyMatrices(rotationY, rotationX);
  const modelView = multiplyMatrices(translation, rotation);
  const matrix = multiplyMatrices(projection, modelView);

  gl.uniformMatrix4fv(uniformLocations.matrix, false, matrix);
  gl.uniform1i(uniformLocations.texture, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);

  if (textureReady) {
    gl.drawElements(gl.TRIANGLES, buffers.count, gl.UNSIGNED_SHORT, 0);
  }
  requestAnimationFrame(renderScene);
}

function getAtlas(zoom) {
  if (atlasCache.has(zoom)) {
    return Promise.resolve(atlasCache.get(zoom));
  }
  if (atlasPromises.has(zoom)) {
    return atlasPromises.get(zoom);
  }
  const buildPromise = buildAtlas(zoom)
    .then((atlasCanvas) => {
      atlasCache.set(zoom, atlasCanvas);
      atlasPromises.delete(zoom);
      return atlasCanvas;
    })
    .catch((error) => {
      atlasPromises.delete(zoom);
      throw error;
    });
  atlasPromises.set(zoom, buildPromise);
  return buildPromise;
}

async function refreshAtlas() {
  atlasVersion += 1;
  const currentVersion = atlasVersion;
  const shouldShowLoading = !atlasCache.has(state.zoom);
  if (shouldShowLoading) {
    setLoading(true, `Loading zoom ${state.zoom} tiles…`);
  }
  try {
    const atlasCanvas = await getAtlas(state.zoom);
    if (currentVersion === atlasVersion) {
      uploadAtlasTexture(atlasCanvas);
    }
  } catch (error) {
    console.error('Failed to build atlas', error);
  } finally {
    if (currentVersion === atlasVersion && shouldShowLoading) {
      setLoading(false);
    }
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setZoom(nextZoom) {
  const clamped = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  if (clamped === state.zoom) return;
  state.zoom = clamped;
  refreshAtlas();
}

function handleWheel(event) {
  event.preventDefault();
  const direction = event.deltaY > 0 ? -1 : 1;
  setZoom(state.zoom + direction);
}

function handlePointerDown(event) {
  pointerState.active = true;
  pointerState.id = event.pointerId;
  pointerState.startX = event.clientX;
  pointerState.startY = event.clientY;
  pointerState.startYaw = state.yaw;
  pointerState.startPitch = state.pitch;
  globe.setPointerCapture(event.pointerId);
}

function handlePointerMove(event) {
  if (!pointerState.active || event.pointerId !== pointerState.id) return;
  event.preventDefault();
  const deltaX = event.clientX - pointerState.startX;
  const deltaY = event.clientY - pointerState.startY;
  state.yaw = pointerState.startYaw + deltaX * ROTATE_SPEED;
  const maxPitch = Math.PI / 2 - 0.05;
  state.pitch = clamp(pointerState.startPitch + deltaY * ROTATE_SPEED, -maxPitch, maxPitch);
}

function handlePointerUp(event) {
  if (!pointerState.active || event.pointerId !== pointerState.id) return;
  pointerState.active = false;
  try {
    globe.releasePointerCapture(pointerState.id);
  } catch (err) {
    // ignore
  }
  pointerState.id = null;
}

function init() {
  gl = canvas.getContext('webgl', { antialias: true });
  if (!gl) {
    loading.textContent = 'WebGL is not supported in this browser';
    return;
  }

  const vertexSource = `
    attribute vec3 aPosition;
    attribute vec2 aUV;
    uniform mat4 uMatrix;
    varying vec2 vUV;
    void main() {
      vUV = aUV;
      gl_Position = uMatrix * vec4(aPosition, 1.0);
    }
  `;

  const fragmentSource = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTexture;
    const float PI = 3.141592653589793;
    vec2 mercatorProject(vec2 uv) {
      float lon = uv.x * 2.0 * PI - PI;
      float lat = uv.y * PI - PI * 0.5;
      float x = fract(uv.x);
      float s = clamp(sin(lat), -0.9999, 0.9999);
      float y = 0.5 - log((1.0 + s) / (1.0 - s)) / (4.0 * PI);
      y = clamp(y, 0.0, 1.0);
      return vec2(x, y);
    }
    void main() {
      vec2 merc = mercatorProject(vUV);
      gl_FragColor = texture2D(uTexture, merc);
    }
  `;

  program = createProgram(gl, vertexSource, fragmentSource);
  buffers = createSphere(gl);
  texture = createTexture(gl);

  attribLocations = {
    position: gl.getAttribLocation(program, 'aPosition'),
    uv: gl.getAttribLocation(program, 'aUV'),
  };

  uniformLocations = {
    matrix: gl.getUniformLocation(program, 'uMatrix'),
    texture: gl.getUniformLocation(program, 'uTexture'),
  };

  window.addEventListener('resize', () => {
    resizeCanvas();
  });

  requestAnimationFrame(renderScene);
  preloadAtlases();
  refreshAtlas();
}

async function preloadAtlases() {
  updatePreloadStatus(PRELOAD_ZOOMS[0]);
  for (const zoom of PRELOAD_ZOOMS) {
    if (preloadedZooms.has(zoom)) {
      continue;
    }
    if (atlasCache.has(zoom)) {
      preloadedZooms.add(zoom);
      updatePreloadStatus();
      continue;
    }
    updatePreloadStatus(zoom);
    try {
      await getAtlas(zoom);
      preloadedZooms.add(zoom);
    } catch (error) {
      console.error(`Failed to preload atlas for zoom ${zoom}`, error);
    }
    updatePreloadStatus();
  }
}

globe.addEventListener('wheel', handleWheel, { passive: false });
globe.addEventListener('pointerdown', handlePointerDown);
globe.addEventListener('pointermove', handlePointerMove);
globe.addEventListener('pointerup', handlePointerUp);
globe.addEventListener('pointerleave', handlePointerUp);
globe.addEventListener('pointercancel', handlePointerUp);

init();
