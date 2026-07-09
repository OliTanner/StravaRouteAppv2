// RouteArt engine — pure, framework-free.
// Deliberately split into distinct stages so a road-snapping engine
// can be plugged into fitRoute() without touching shape generation or placement.

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// 1. SHAPE GENERATION
// Shapes are stored as normalized closed polylines: arrays of [x, y] in 0..1,
// y pointing UP. Not pre-closed (first point is not repeated at the end).
// ---------------------------------------------------------------------------

function sampleHeart(n = 60) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([x, y]);
  }
  return pts;
}

function sampleStar(points = 5, outer = 0.5, inner = 0.21) {
  const pts = [];
  const steps = points * 2;
  for (let i = 0; i < steps; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = Math.PI / 2 + (i / steps) * TAU; // start pointing up
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// Mirror a right-half point list (top->bottom, x>=0) into a full symmetric loop.
function mirrorHalf(half) {
  const left = half.slice(1, half.length - 1).reverse().map(([x, y]) => [-x, y]);
  return half.concat(left);
}

const TREE_HALF = [
  [0, 1.0], [0.16, 0.68], [0.07, 0.68], [0.27, 0.4], [0.13, 0.4],
  [0.42, 0.08], [0.12, 0.08], [0.12, -0.16], [0.12, -0.42], [0, -0.42],
];

const GUITAR_HALF = [
  [0.05, 1.0], [0.09, 0.93], [0.05, 0.88], [0.045, 0.52], [0.06, 0.36],
  [0.22, 0.29], [0.29, 0.13], [0.2, 0.0], [0.3, -0.15], [0.35, -0.42],
  [0.21, -0.63], [0, -0.68],
];

const BUTTERFLY_HALF = [
  [0, 0.95], [0.34, 0.98], [0.62, 0.78], [0.56, 0.44], [0.16, 0.16],
  [0.46, -0.06], [0.5, -0.46], [0.3, -0.78], [0.1, -0.86], [0, -0.66],
];

const RAW = {
  heart: sampleHeart,
  star: () => sampleStar(5),
  tree: () => mirrorHalf(TREE_HALF),
  guitar: () => mirrorHalf(GUITAR_HALF),
  butterfly: () => mirrorHalf(BUTTERFLY_HALF),
};

export const SHAPES = [
  { id: 'heart', name: 'Heart' },
  { id: 'star', name: 'Star' },
  { id: 'tree', name: 'Tree' },
  { id: 'guitar', name: 'Guitar' },
  { id: 'butterfly', name: 'Butterfly' },
];

// Fit raw points into a centered 0..1 box, preserving aspect ratio.
export function normalize(raw) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of raw) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const w = maxX - minX || 1, h = maxY - minY || 1;
  const s = 1 / Math.max(w, h);
  const ox = (1 - w * s) / 2, oy = (1 - h * s) / 2;
  return raw.map(([x, y]) => [(x - minX) * s + ox, (y - minY) * s + oy]);
}

export function generateShape(id) {
  const gen = RAW[id];
  if (!gen) return normalize(sampleHeart());
  return normalize(gen());
}

// Deterministic procedural fallback when no AI shape is available.
export function proceduralShape(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
  const n = 18 + Math.floor(rnd() * 10);
  const lobes = 3 + Math.floor(rnd() * 4);
  const amp = 0.18 + rnd() * 0.22;
  const phase = rnd() * TAU;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const r = 0.5 + amp * Math.sin(lobes * a + phase) + (rnd() - 0.5) * 0.08;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return normalize(pts);
}

// ---------------------------------------------------------------------------
// 2. MAP PLACEMENT
// Scale a normalized shape to a target real-world distance and drop it on the
// map at `center`, applying rotation. Returns a closed array of [lat, lng].
// ---------------------------------------------------------------------------

const R_EARTH = 6371000;

export function haversine(a, b) {
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLng = (b[1] - a[1]) * Math.PI / 180;
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

function normPerimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

export function placeShape({ points, center, targetKm, rotationDeg = 0, scale = 1 }) {
  const [clat, clng] = center;
  // center on bbox
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

  const targetMeters = targetKm * 1000 * scale;
  const mpu = targetMeters / (normPerimeter(points) || 1); // meters per normalized unit
  const rot = rotationDeg * Math.PI / 180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos(clat * Math.PI / 180);

  const out = points.map(([x, y]) => {
    let mx = (x - cx) * mpu;
    let my = (y - cy) * mpu;
    const rx = mx * cosR - my * sinR;
    const ry = mx * sinR + my * cosR;
    return [clat + ry / mPerLat, clng + rx / mPerLng];
  });
  out.push(out[0]); // close the loop — always returns to start
  return out;
}

export function polylineDistanceKm(latlngs) {
  let m = 0;
  for (let i = 0; i < latlngs.length - 1; i++) m += haversine(latlngs[i], latlngs[i + 1]);
  return m / 1000;
}

// ---------------------------------------------------------------------------
// 3. ROUTE FITTING  (road-snapping seam)
// 'geometric' is a pass-through (straight lines between shape vertices).
// 'ors' snaps to real roads via the OpenRouteService directions API — see README.md.
// ---------------------------------------------------------------------------

const ORS_API_KEY = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_ORS_API_KEY : undefined;
const ORS_URL = 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson';
const ORS_FETCH_TIMEOUT_MS = 15000;

// Waypoints spaced too closely together (relative to target distance) force the
// router to detour around blocks between every pair, and that circuity compounds
// across dozens of legs. Empirically tested against live ORS calls for Bank,
// London across several shapes and 3-35km targets: 50-60 tightly-spaced waypoints
// (the original approach) landed at 3-3.5x the target distance; one waypoint per
// ~200m improved that to ~2.3x; one waypoint per ~500m (clamped 8-20) consistently
// lands in the ~1.15-1.6x range, which is what's used here.
const METERS_PER_WAYPOINT = 500;
const MIN_WAYPOINTS = 8;
const MAX_WAYPOINTS = 20;
const SNAP_RADIUS_M = 250; // per-waypoint search radius, so ORS can't wander far chasing a "better" road

// latlngs is a closed loop (last point === first, per placeShape). Strip the
// duplicate before building ORS waypoints, then resample to a distance-appropriate
// density (never upsampling past the shape's own native point count).
function prepWaypoints(latlngs, geometricKm) {
  const pts = latlngs.slice(0, -1);
  const target = Math.round((geometricKm * 1000) / METERS_PER_WAYPOINT);
  const count = Math.max(MIN_WAYPOINTS, Math.min(MAX_WAYPOINTS, target, pts.length));
  if (count >= pts.length) return pts;
  const stride = pts.length / count;
  return Array.from({ length: count }, (_, i) => pts[Math.floor(i * stride)]);
}

async function fitRouteOrs(latlngs) {
  const geometricKm = polylineDistanceKm(latlngs);
  const fallback = { latlngs, distanceKm: geometricKm, snapped: false, mode: 'ors' };

  if (!ORS_API_KEY) {
    return { ...fallback, error: 'No OpenRouteService API key configured — set VITE_ORS_API_KEY in .env.local.' };
  }

  const wps = prepWaypoints(latlngs, geometricKm);
  const coordinates = wps.map(([lat, lng]) => [lng, lat]);
  const radiuses = wps.map(() => SNAP_RADIUS_M);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORS_FETCH_TIMEOUT_MS);
  let res, data;
  try {
    res = await fetch(ORS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: ORS_API_KEY },
      body: JSON.stringify({ coordinates, preference: 'shortest', radiuses }),
      signal: controller.signal,
    });
    data = await res.json();
  } catch (err) {
    const error = err.name === 'AbortError' ? 'OpenRouteService request timed out.' : 'Could not reach OpenRouteService.';
    return { ...fallback, error };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || !data.features || !data.features[0]) {
    const error = data?.error?.message || `OpenRouteService error (HTTP ${res.status}).`;
    return { ...fallback, error };
  }

  const feature = data.features[0];
  const snapped = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  const closed = snapped.concat([snapped[0]]); // re-close the loop for drawing/GPX
  const distanceKm = feature.properties.summary.distance / 1000;
  const ratio = geometricKm > 0 ? distanceKm / geometricKm : 1;

  return { latlngs: closed, distanceKm, snapped: true, mode: 'ors', error: null, ratio };
}

export async function fitRoute(latlngs, opts = {}) {
  const mode = opts.mode || 'geometric';
  if (mode === 'ors') return fitRouteOrs(latlngs);
  return { latlngs, distanceKm: polylineDistanceKm(latlngs), snapped: false, mode, error: null };
}

// ---------------------------------------------------------------------------
// 4. COMPLEXITY / FIDELITY
// ---------------------------------------------------------------------------

export function computeComplexity({ points, targetKm }) {
  const segments = points.length;
  const targetMeters = targetKm * 1000;
  const avgSegM = targetMeters / segments;
  let level = 'ok';
  if (avgSegM < 35) level = 'too-complex';
  else if (avgSegM < 70) level = 'tight';
  const fidelity = Math.round(Math.max(58, Math.min(99, 58 + (avgSegM / 120) * 41)));
  return { segments, avgSegM: Math.round(avgSegM), level, fidelity };
}

// ---------------------------------------------------------------------------
// 5. EXPORT
// ---------------------------------------------------------------------------

export function buildGPX(latlngs, name = 'RouteArt') {
  const pts = latlngs.map(([lat, lng]) =>
    `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RouteArt" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name></metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// Build an SVG path string from normalized points (y-up) for previews.
export function toSvgPath(points, size = 100, pad = 12) {
  const s = size - pad * 2;
  const d = points.map(([x, y], i) =>
    `${i === 0 ? 'M' : 'L'}${(pad + x * s).toFixed(1)},${(pad + (1 - y) * s).toFixed(1)}`).join(' ');
  return d + ' Z';
}
