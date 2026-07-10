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

// Letter outlines: a single continuous stroke (no holes), so "O" is a ring
// silhouette rather than a true glyph with an interior — fine for a running
// route, which can't trace a hole anyway. O and T are left-right symmetric
// (mirrorHalf); J isn't, so it's given as a full outline.

function sampleLetterO(n = 48) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    pts.push([0.42 * Math.cos(a), 0.5 * Math.sin(a)]);
  }
  return pts;
}

const T_HALF = [
  [0, 0.5], [0.5, 0.5], [0.5, 0.3], [0.1, 0.3], [0.1, -0.5], [0, -0.5],
];

const J_FULL = [
  [0.1, 0.5], [0.3, 0.5], [0.3, -0.4], [-0.3, -0.4], [-0.3, -0.2], [0.1, -0.2],
];

const RAW = {
  heart: sampleHeart,
  star: () => sampleStar(5),
  tree: () => mirrorHalf(TREE_HALF),
  o: sampleLetterO,
  j: () => J_FULL,
  t: () => mirrorHalf(T_HALF),
};

export const SHAPES = [
  { id: 'heart', name: 'Heart' },
  { id: 'star', name: 'Star' },
  { id: 'tree', name: 'Tree' },
  { id: 'o', name: 'O' },
  { id: 'j', name: 'J' },
  { id: 't', name: 'T' },
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

// Shared ORS /route call: wps is an open (non-closed) ordered list of [lat,lng]
// waypoints. Returns { latlngs (closed), distanceKm } on success, or an object
// with just { error } on failure — callers layer their own fallback shape on top.
async function callOrsRoute(wps, { radius = SNAP_RADIUS_M } = {}) {
  if (!ORS_API_KEY) {
    return { error: 'No OpenRouteService API key configured — set VITE_ORS_API_KEY in .env.local.' };
  }

  // ORS routes through waypoints in order but never loops back to the start on
  // its own — re-sending the first point as the final stop makes ORS actually
  // route the closing leg over real roads, instead of us drawing a straight
  // line from the last point back to the first afterward.
  const routeWps = wps.concat([wps[0]]);
  const coordinates = routeWps.map(([lat, lng]) => [lng, lat]);
  const radiuses = routeWps.map(() => radius);

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
    return { error: err.name === 'AbortError' ? 'OpenRouteService request timed out.' : 'Could not reach OpenRouteService.' };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || !data.features || !data.features[0]) {
    return { error: data?.error?.message || `OpenRouteService error (HTTP ${res.status}).` };
  }

  const feature = data.features[0];
  const snapped = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  const distanceKm = feature.properties.summary.distance / 1000;
  return { latlngs: snapped, distanceKm }; // already closed — ORS routed the full loop, including the return leg
}

async function fitRouteOrs(latlngs) {
  const geometricKm = polylineDistanceKm(latlngs);
  const fallback = { latlngs, distanceKm: geometricKm, snapped: false, mode: 'ors' };

  const wps = prepWaypoints(latlngs, geometricKm);
  const r = await callOrsRoute(wps);
  if (r.error) return { ...fallback, error: r.error };

  const ratio = geometricKm > 0 ? r.distanceKm / geometricKm : 1;
  return { latlngs: r.latlngs, distanceKm: r.distanceKm, snapped: true, mode: 'ors', error: null, ratio };
}

export async function fitRoute(latlngs, opts = {}) {
  const mode = opts.mode || 'geometric';
  if (mode === 'ors') return fitRouteOrs(latlngs);
  return { latlngs, distanceKm: polylineDistanceKm(latlngs), snapped: false, mode, error: null };
}

// ---------------------------------------------------------------------------
// 3c. MANUAL ROUTE EDITING — route through an exact, user-placed waypoint
// list (drag-to-reshape), no density resampling: the user has already chosen
// these points deliberately, so route through every one of them in order.
// ---------------------------------------------------------------------------

// A small, evenly-spaced set of drag handles for manual route editing — not
// one per road-snapped vertex (there can be hundreds; dragging one among that
// many is unusably fiddly). latlngs may be closed or open; returns an open list.
export function resampleWaypoints(latlngs, count = 10) {
  const isClosed = latlngs.length > 1
    && latlngs[0][0] === latlngs[latlngs.length - 1][0]
    && latlngs[0][1] === latlngs[latlngs.length - 1][1];
  const pts = isClosed ? latlngs.slice(0, -1) : latlngs;
  const n = Math.max(3, Math.min(count, pts.length));
  if (n >= pts.length) return pts.slice();
  const stride = pts.length / n;
  return Array.from({ length: n }, (_, i) => pts[Math.floor(i * stride)]);
}

export async function fitRouteFromWaypoints(latlngs) {
  const isClosed = latlngs.length > 1
    && latlngs[0][0] === latlngs[latlngs.length - 1][0]
    && latlngs[0][1] === latlngs[latlngs.length - 1][1];
  const wps = isClosed ? latlngs.slice(0, -1) : latlngs;
  const fallback = { latlngs, distanceKm: polylineDistanceKm(latlngs), snapped: false, mode: 'edited' };

  if (wps.length < 2) return { ...fallback, error: 'Need at least two points to route through.' };

  const r = await callOrsRoute(wps, { radius: 80 }); // tight radius — these are deliberate points, don't wander
  if (r.error) return { ...fallback, error: r.error };
  return { latlngs: r.latlngs, distanceKm: r.distanceKm, snapped: true, mode: 'edited', error: null };
}

// ---------------------------------------------------------------------------
// 3b. LOOP ROUTING — "just give me a nice loop of this length", no shape.
// Uses ORS's round-trip routing: a single start point + target distance comes
// back as a real, already-street-snapped loop. Empirically much tighter on
// distance (~0.85-1.2x target) than shape-mode snapping, since it's purpose-
// built for this instead of fighting the road network to trace a silhouette.
// ---------------------------------------------------------------------------

const LOOP_POINTS = 3; // fixed; controls how windy vs. direct the loop is — not user-configurable

function sampleCircle(n = 48) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    pts.push([0.5 * Math.cos(a), 0.5 * Math.sin(a)]);
  }
  return pts;
}

// Plain geometric circle of the target distance — the "free" fallback loop
// mode has no shape of its own to fall back on independent of the network call.
export function buildLoopFallback({ center, targetKm }) {
  const pts = normalize(sampleCircle());
  return placeShape({ points: pts, center, targetKm, rotationDeg: 0, scale: 1 });
}

export async function fetchLoopRoute({ center, targetKm, seed = 1, points = LOOP_POINTS } = {}) {
  const fallbackLatlngs = buildLoopFallback({ center, targetKm });
  const fallback = { latlngs: fallbackLatlngs, distanceKm: polylineDistanceKm(fallbackLatlngs), snapped: false, mode: 'loop' };

  if (!ORS_API_KEY) {
    return { ...fallback, error: 'No OpenRouteService API key configured — set VITE_ORS_API_KEY in .env.local.' };
  }

  const [lat, lng] = center;
  const body = {
    coordinates: [[lng, lat]],
    options: { round_trip: { length: Math.round(targetKm * 1000), points, seed } },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORS_FETCH_TIMEOUT_MS);
  let res, data;
  try {
    res = await fetch(ORS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: ORS_API_KEY },
      body: JSON.stringify(body),
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
  // Round-trip geometry comes back already closed (first === last) — unlike
  // shape mode's snapped response, do not append a closing point again.
  const latlngs = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  const distanceKm = feature.properties.summary.distance / 1000;

  return { latlngs, distanceKm, snapped: true, mode: 'loop', error: null };
}

// ---------------------------------------------------------------------------
// 3d. SUGGESTED SHAPES — scout the real street network instead of forcing a
// shape onto it. No amount of waypoint-density tuning closes the gap between
// "forced shape" and a shape that actually fits: real streets are rectilinear,
// not smooth curves, so the fix isn't a better routing call, it's picking a
// location (and rotation) that already has the shape latent in it, then
// scoring how well each candidate actually traced against the real roads.
// ---------------------------------------------------------------------------

const SCOUT_ROTATIONS = [0, 60, 120];
// Ring-sampled candidate centers around a pin, at increasing radius fractions.
const CENTER_RING_FRACTIONS = [0.8];
const CENTER_RING_COUNT = 4; // points per ring
// Firing dozens of ORS requests via a single Promise.all triggers connection-level
// rejection (surfaces in the browser as a generic CORS error, not a clean 429) —
// live-tested against the real API. Small concurrent batches stay reliable.
const SCOUT_CONCURRENCY = 5;

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Resamples a closed lat/lng loop to n points evenly spaced by real distance
// (not by index) — needed to fairly compare an evenly-curved ideal shape
// against an unevenly-dense real road path point-for-point.
export function resampleByArcLength(latlngs, n) {
  const closed = (latlngs[0][0] === latlngs[latlngs.length - 1][0] && latlngs[0][1] === latlngs[latlngs.length - 1][1])
    ? latlngs : latlngs.concat([latlngs[0]]);
  const segLens = [];
  let total = 0;
  for (let i = 1; i < closed.length; i++) { const d = haversine(closed[i - 1], closed[i]); segLens.push(d); total += d; }
  if (total === 0) return Array.from({ length: n }, () => closed[0]);
  const step = total / n;
  const out = [];
  let segIdx = 0, segStart = 0;
  for (let i = 0; i < n; i++) {
    const target = i * step;
    while (segIdx < segLens.length - 1 && segStart + segLens[segIdx] < target) { segStart += segLens[segIdx]; segIdx++; }
    const segLen = segLens[segIdx] || 1e-9;
    const t = Math.min(1, Math.max(0, (target - segStart) / segLen));
    const a = closed[segIdx], b = closed[segIdx + 1];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Empirically calibrated against live ORS results across all 6 library shapes
// at 4 rotations each (Bank, London, 5km target): average deviation ranged
// ~1.4% of target distance (a rotation that lines up with the street grid) to
// ~16% (one that fights it) — this maps that range onto a 0-100 score.
const FIT_DEV_PCT_FLOOR = 12; // deviation % at/above which score bottoms out at 0

export function scoreShapeFit(idealLatlngs, snappedLatlngs) {
  const n = 48;
  const a = resampleByArcLength(idealLatlngs, n);
  const b = resampleByArcLength(snappedLatlngs, n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += haversine(a[i], b[i]);
  const avgDevM = sum / n;
  const targetM = polylineDistanceKm(idealLatlngs) * 1000;
  const devPct = targetM > 0 ? (avgDevM / targetM) * 100 : 100;
  const score = Math.round(Math.max(0, Math.min(100, 100 * (1 - devPct / FIT_DEV_PCT_FLOOR))));
  const tier = score >= 80 ? 'great' : score >= 50 ? 'good' : 'loose';
  return { score, tier, avgDevM };
}

// Scores one shape at one rotation against a real center — the unit both
// scoutCenters (one proxy shape) and scoutShapes (the full library) build on.
async function scoutOne(shapeId, center, targetKm, rotationDeg) {
  const shapePts = generateShape(shapeId);
  const placed = placeShape({ points: shapePts, center, targetKm, rotationDeg });
  const r = await fitRouteOrs(placed);
  if (!r.snapped) return null;
  const fit = scoreShapeFit(placed, r.latlngs);
  return { shapeId, rotationDeg, center, latlngs: r.latlngs, distanceKm: r.distanceKm, ...fit };
}

function offsetLatLng([lat, lng], bearingDeg, distanceM) {
  const R = 6371000;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180, lng1 = lng * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distanceM / R) + Math.cos(lat1) * Math.sin(distanceM / R) * Math.cos(brng));
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(distanceM / R) * Math.cos(lat1),
    Math.cos(distanceM / R) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [lat2 * 180 / Math.PI, lng2 * 180 / Math.PI];
}

// Phase A — is the pin itself a good canvas, or is there a better one nearby?
// Ring-samples candidate centers out to radiusKm and scores each with a single
// proxy shape (cheap relative to the full per-shape scan in scoutShapes).
export async function scoutCenters({ pin, targetKm, radiusKm = 1.5, proxyShapeId = 'star' }) {
  const candidates = [{ center: pin, offsetM: 0 }];
  for (const frac of CENTER_RING_FRACTIONS) {
    const ringRadiusM = radiusKm * 1000 * frac;
    for (let i = 0; i < CENTER_RING_COUNT; i++) {
      const bearing = (360 / CENTER_RING_COUNT) * i;
      candidates.push({ center: offsetLatLng(pin, bearing, ringRadiusM), offsetM: ringRadiusM });
    }
  }

  const results = await mapWithConcurrency(candidates, SCOUT_CONCURRENCY, ({ center, offsetM }) =>
    scoutOne(proxyShapeId, center, targetKm, 0).then((r) => (r ? { ...r, offsetM } : null)));
  const valid = results.filter(Boolean);
  if (valid.length === 0) return { center: pin, offsetM: 0, score: 0 };
  valid.sort((x, y) => y.score - x.score);
  return valid[0];
}

// Phase B — at a chosen center, try every library shape at a spread of
// rotations and return the best-fitting ones, ranked.
export async function scoutShapes({ center, targetKm }) {
  const combos = [];
  for (const sh of SHAPES) {
    for (const rot of SCOUT_ROTATIONS) combos.push([sh.id, rot]);
  }
  const results = await mapWithConcurrency(combos, SCOUT_CONCURRENCY, ([shapeId, rot]) => scoutOne(shapeId, center, targetKm, rot));
  const valid = results.filter(Boolean);
  // keep only each shape's best-scoring rotation, then rank shapes against each other
  const bestPerShape = new Map();
  for (const r of valid) {
    const prev = bestPerShape.get(r.shapeId);
    if (!prev || r.score > prev.score) bestPerShape.set(r.shapeId, r);
  }
  return Array.from(bestPerShape.values()).sort((a, b) => b.score - a.score);
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

// Preview path for an arbitrary lat/lng route (a loop, or a saved route of
// either mode) rather than a normalized 0..1 shape — projects to local meters
// (equirectangular, fine at preview scale) then reuses the same normalize+path pipeline.
export function toSvgPathFromLatLngs(latlngs, size = 100, pad = 12) {
  const avgLat = latlngs.reduce((sum, [lat]) => sum + lat, 0) / latlngs.length;
  const mPerLat = 111320, mPerLng = 111320 * Math.cos(avgLat * Math.PI / 180);
  const xy = latlngs.map(([lat, lng]) => [lng * mPerLng, lat * mPerLat]);
  return toSvgPath(normalize(xy), size, pad);
}
