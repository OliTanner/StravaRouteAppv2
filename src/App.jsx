import { Component } from 'react';
import L from 'leaflet';
import * as engine from './routeart-engine.js';
import * as savedRoutesStore from './savedRoutes.js';

const TURF = '#2fd897';
const ROUTE_DRAW_MS = 700;

const COMPLEXITY_COPY = {
  ok: { color: '#2fd897', title: 'Great fit', msg: (c) => `Roomy — about ${c.avgSegM} m between turns. Plenty of space for crisp detail.` },
  tight: { color: '#e8a94a', title: 'Getting tight', msg: (c) => `~${c.avgSegM} m between turns. Some fine detail may soften on real roads. Consider a longer run.` },
  'too-complex': { color: '#e8623d', title: 'Too intricate', msg: (c, km) => `Only ~${c.avgSegM} m between turns for ${km.toFixed(1)} km. Increase distance or pick a simpler shape.` },
};

const FIT_TIER_COPY = {
  great: { color: '#2fd897', label: 'Great fit' },
  good: { color: '#e8a94a', label: 'Good fit' },
  loose: { color: '#e8623d', label: 'Loose fit' },
};

export default class App extends Component {
  state = {
    ready: false,
    location: { name: 'Bank, London', lat: 51.5133, lng: -0.0886 },
    query: '',
    searching: false,
    results: [],
    distanceKm: 5,
    routeMode: 'suggested', // 'suggested' | 'loop' | 'custom'
    shapeId: 'heart',
    customPoints: null,
    customName: '',
    prompt: '',
    generating: false,
    genError: '',
    rotationDeg: 0,
    scale: 1,
    paceMinPerKm: 6,
    toast: '',
    snapToRoads: true,
    snapStatus: 'idle', // 'idle' | 'loading' | 'ok' | 'error'
    snapError: '',
    snappedRoute: null, // { latlngs, distanceKm, ratio } from the last successful OpenRouteService fetch
    loopSeed: 1,
    loopStatus: 'idle', // 'idle' | 'loading' | 'ok' | 'error'
    loopError: '',
    loopRoute: null, // { latlngs, distanceKm } — always drawable once set (fallback baked in)
    loadedRoute: null, // a saved-route snapshot currently being viewed
    editedRoute: null, // { latlngs, distanceKm } — set after dragging a point on the line
    editStatus: 'idle', // 'idle' | 'loading' | 'ok' | 'error'
    editError: '',
    suggestedResults: [], // [{ shapeId, rotationDeg, center, latlngs, distanceKm, score, tier, avgDevM }]
    suggestedStatus: 'idle', // 'idle' | 'scouting' | 'ok' | 'error'
    suggestedCenter: null, // { center, offsetM } — the scouted center results are drawn from
    suggestedActiveIndex: 0, // which card is currently previewed on the map
    searchRadiusKm: 1.5,
    savedRoutesOpen: false,
    sheetExpanded: false,
    savedRoutes: savedRoutesStore.loadSavedRoutes(),
  };

  _snapGen = 0;
  _snapDebounce = null;
  _loopGen = 0;
  _loopDebounce = null;
  _editGen = 0;
  _suggestGen = 0;
  _suggestDebounce = null;
  _locationTouchedByUser = false;

  componentDidMount() {
    // First-paint map/route setup happens in componentDidUpdate's `!this.map`
    // branch below, which always fires after this setState commits.
    this.setState({ ready: true });
    this.tryGeolocate();
  }

  componentWillUnmount() {
    clearTimeout(this._toastT);
    clearTimeout(this._snapDebounce);
    clearTimeout(this._loopDebounce);
    clearTimeout(this._suggestDebounce);
    if (this.map) { this.map.remove(); this.map = null; }
  }

  tryGeolocate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // The permission prompt can sit open for a while — if the user searched
        // or dragged the pin in the meantime, don't silently override their choice.
        if (this._locationTouchedByUser) return;
        this._recenterNext = true;
        this.setState({
          location: { name: 'Your location', lat: pos.coords.latitude, lng: pos.coords.longitude },
          loadedRoute: null, editedRoute: null,
        });
      },
      () => { /* denied/unavailable — silent, not an error; keep the default */ },
      { timeout: 6000, maximumAge: 300000 },
    );
  }

  // Which route (geometric baseRoute vs a successful snap) should currently be
  // drawn/exported — compared by reference across renders to know when the
  // map's polyline actually needs to be redrawn (see componentDidUpdate).
  activeRouteKey(s) {
    return s.snapToRoads && s.snapStatus === 'ok' && s.snappedRoute ? s.snappedRoute : null;
  }

  componentDidUpdate(pp, ps) {
    if (!this.state.ready) return;
    const s = this.state;

    if (!this.map) {
      this.ensureMap();
      this.updateRoute(true);
      if (s.routeMode === 'custom' && s.snapToRoads) this.requestSnap();
      if (s.routeMode === 'loop') this.requestLoop();
      if (s.routeMode === 'suggested') this.requestSuggestions();
      return;
    }

    const loadedRouteChanged = ps.loadedRoute !== s.loadedRoute;
    if (loadedRouteChanged) this.updateRoute(true);

    const editedRouteChanged = ps.editedRoute !== s.editedRoute;
    if (editedRouteChanged) this.updateRoute(false);

    const modeSwitched = ps.routeMode !== s.routeMode;

    if (s.routeMode === 'suggested' && !s.loadedRoute && !s.editedRoute) {
      const resultsRefChanged = ps.suggestedResults !== s.suggestedResults;
      const activeChanged = ps.suggestedActiveIndex !== s.suggestedActiveIndex;
      const recenter = modeSwitched || resultsRefChanged;
      if (modeSwitched || resultsRefChanged || activeChanged) this.updateRoute(recenter);

      const suggestKeys = ['location', 'distanceKm'];
      const suggestInputsChanged = suggestKeys.some((k) => ps[k] !== s[k]);
      if (suggestInputsChanged || (modeSwitched && s.suggestedStatus === 'idle')) {
        clearTimeout(this._suggestDebounce);
        if (modeSwitched && s.suggestedStatus === 'idle') this.requestSuggestions();
        else this._suggestDebounce = setTimeout(() => this.requestSuggestions(), 500);
      }
    }

    if (s.routeMode === 'custom' && !s.loadedRoute && !s.editedRoute) {
      const recenterKeys = ['shapeId', 'customPoints', 'distanceKm'];
      let recenter = recenterKeys.some((k) => ps[k] !== s[k]) || modeSwitched;
      if (this._recenterNext) { recenter = true; this._recenterNext = false; }
      const drawKeys = ['shapeId', 'customPoints', 'distanceKm', 'rotationDeg', 'scale', 'location'];
      const routeChanged = drawKeys.some((k) => ps[k] !== s[k]) || modeSwitched;
      const activeRouteChanged = this.activeRouteKey(ps) !== this.activeRouteKey(s);
      if (routeChanged || activeRouteChanged) this.updateRoute(recenter);

      const snapKeys = [...drawKeys, 'snapToRoads'];
      const snapInputsChanged = snapKeys.some((k) => ps[k] !== s[k]);
      if (snapInputsChanged || (modeSwitched && s.snapToRoads && s.snapStatus === 'idle')) {
        clearTimeout(this._snapDebounce);
        if (s.snapToRoads) {
          if (modeSwitched && s.snapStatus === 'idle') this.requestSnap();
          else this._snapDebounce = setTimeout(() => this.requestSnap(), 500);
        } else if (ps.snapToRoads) {
          this.setState({ snapStatus: 'idle', snapError: '', snappedRoute: null });
        }
      }
    }

    if (s.routeMode === 'loop' && !s.loadedRoute && !s.editedRoute) {
      const loopDrawKeys = ['location', 'distanceKm'];
      const loopRouteRefChanged = ps.loopRoute !== s.loopRoute;
      const recenter = modeSwitched || loopDrawKeys.some((k) => ps[k] !== s[k]) || loopRouteRefChanged;
      if (modeSwitched || loopRouteRefChanged) this.updateRoute(recenter);

      const loopInputsChanged = loopDrawKeys.some((k) => ps[k] !== s[k]);
      if (loopInputsChanged || (modeSwitched && s.loopStatus === 'idle')) {
        clearTimeout(this._loopDebounce);
        if (modeSwitched && s.loopStatus === 'idle') this.requestLoop();
        else this._loopDebounce = setTimeout(() => this.requestLoop(), 500);
      }
    }
  }

  async requestSnap() {
    this.setState({ snapStatus: 'loading', snapError: '' });
    const myGen = ++this._snapGen;
    const base = this.computeShapeRoute();
    const r = await engine.fitRoute(base.latlngs, { mode: 'ors' });
    if (myGen !== this._snapGen) return; // superseded by a newer request
    if (r.snapped) {
      this.setState({ snapStatus: 'ok', snapError: '', snappedRoute: { latlngs: r.latlngs, distanceKm: r.distanceKm, ratio: r.ratio } });
    } else {
      this.setState({ snapStatus: 'error', snapError: r.error || 'Snapping failed.', snappedRoute: null });
    }
  }

  async requestLoop() {
    this.setState({ loopStatus: 'loading', loopError: '' });
    const myGen = ++this._loopGen;
    const r = await engine.fetchLoopRoute({
      center: [this.state.location.lat, this.state.location.lng],
      targetKm: this.state.distanceKm,
      seed: this.state.loopSeed,
    });
    if (myGen !== this._loopGen) return;
    this.setState({
      loopStatus: r.snapped ? 'ok' : 'error',
      loopError: r.snapped ? '' : (r.error || 'Could not find a loop.'),
      loopRoute: { latlngs: r.latlngs, distanceKm: r.distanceKm },
    });
  }

  shuffleLoop() {
    clearTimeout(this._loopDebounce);
    this.setState({ loopSeed: Math.floor(Math.random() * 1e6) }, () => this.requestLoop());
  }

  async requestSuggestions() {
    this.setState({ suggestedStatus: 'scouting' });
    const myGen = ++this._suggestGen;
    const s = this.state;
    const pin = [s.location.lat, s.location.lng];
    const centerResult = await engine.scoutCenters({ pin, targetKm: s.distanceKm, radiusKm: s.searchRadiusKm });
    if (myGen !== this._suggestGen) return;
    const shapeResults = await engine.scoutShapes({ center: centerResult.center, targetKm: s.distanceKm });
    if (myGen !== this._suggestGen) return;
    this.setState({
      suggestedStatus: shapeResults.length ? 'ok' : 'error',
      suggestedResults: shapeResults.slice(0, 3),
      suggestedCenter: centerResult,
      suggestedActiveIndex: 0,
    });
  }

  searchWider() {
    clearTimeout(this._suggestDebounce);
    this.setState({ searchRadiusKm: 5 }, () => this.requestSuggestions());
  }

  previewSuggestion(index) {
    this.setState({ suggestedActiveIndex: index });
  }

  bumpDistance(delta) {
    this.setState((s) => ({
      distanceKm: Math.max(2, Math.min(50, +(s.distanceKm + delta).toFixed(1))),
      loadedRoute: null, editedRoute: null,
    }));
  }

  selectSuggestion(result) {
    this._recenterNext = true;
    this.setState({
      routeMode: 'custom',
      shapeId: result.shapeId,
      rotationDeg: result.rotationDeg,
      scale: 1,
      location: { ...this.state.location, lat: result.center[0], lng: result.center[1] },
      loadedRoute: null,
      editedRoute: null,
    });
  }

  buildActiveRoute(baseRoute) {
    const s = this.state;
    const useSnap = s.snapToRoads && s.snapStatus === 'ok' && s.snappedRoute;
    return useSnap
      ? { ...baseRoute, latlngs: s.snappedRoute.latlngs, distKm: s.snappedRoute.distanceKm }
      : baseRoute;
  }

  computeShapeRoute() {
    const s = this.state;
    let pts;
    if (s.shapeId === 'custom' && s.customPoints) pts = s.customPoints;
    else pts = engine.generateShape(s.shapeId);
    const latlngs = engine.placeShape({
      points: pts, center: [s.location.lat, s.location.lng],
      targetKm: s.distanceKm, rotationDeg: s.rotationDeg, scale: s.scale,
    });
    const comp = engine.computeComplexity({ points: pts, targetKm: s.distanceKm * s.scale });
    return { points: pts, latlngs, distKm: engine.polylineDistanceKm(latlngs), comp };
  }

  computeLoopRoute() {
    const s = this.state;
    if (!s.loopRoute) return null; // first fetch still in flight
    return { latlngs: s.loopRoute.latlngs, distKm: s.loopRoute.distanceKm, points: null, comp: null };
  }

  computeSuggestedRoute() {
    const s = this.state;
    const r = s.suggestedResults[s.suggestedActiveIndex];
    if (!r) return null; // scan still in flight, or nothing found
    return { latlngs: r.latlngs, distKm: r.distanceKm, points: null, comp: null };
  }

  getCurrentRoute() {
    const s = this.state;
    if (s.editedRoute) {
      const r = s.editedRoute;
      return { latlngs: r.latlngs, distKm: r.distanceKm, points: null, comp: null };
    }
    if (s.loadedRoute) {
      const r = s.loadedRoute;
      return { latlngs: r.latlngs, distKm: r.distanceKm, points: null, comp: null };
    }
    if (s.routeMode === 'loop') return this.computeLoopRoute();
    if (s.routeMode === 'suggested') return this.computeSuggestedRoute();
    return this.buildActiveRoute(this.computeShapeRoute());
  }

  ensureMap() {
    if (this.map || !this.mapEl) return;
    const { lat, lng } = this.state.location;
    this.map = L.map(this.mapEl, { zoomControl: true, attributionControl: true }).setView([lat, lng], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(this.map);
    this.waypointMarkers = [];
    setTimeout(() => this.map && this.map.invalidateSize(), 200);
  }

  startIcon() {
    return L.divIcon({ className: '', html: '<div class="ra-pin-wrap"><div class="ra-pin-ring"></div><div class="ra-pin-dot"></div></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  }

  placeMarker(latlng) {
    if (!this.startMarker) {
      this.startMarker = L.marker(latlng, { draggable: true, icon: this.startIcon() }).addTo(this.map);
      this.startMarker.on('dragend', (e) => this.onMarkerDrag(e));
    } else {
      this.startMarker.setLatLng(latlng);
    }
  }

  updateRoute(recenter) {
    if (!this.map) return;
    const r = this.getCurrentRoute();
    if (this.glow) { this.glow.remove(); this.glow = null; }
    if (this.line) { this.line.remove(); this.line = null; }

    if (!r) {
      // Nothing drawable yet (first loop fetch in flight) — still place the pin.
      this.placeMarker([this.state.location.lat, this.state.location.lng]);
      this.clearWaypointMarkers();
      return;
    }

    this.route = r;
    this.glow = L.polyline(r.latlngs, { color: TURF, weight: 13, opacity: 0.22, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(this.map);
    this.line = L.polyline(r.latlngs, { color: TURF, weight: 4.5, opacity: 1, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(this.map);
    this.animateRouteDraw();
    this.placeMarker(r.latlngs[0]);

    // A handful of draggable handles, not one per road-snapped vertex — dragging
    // a single point among hundreds was unusably fiddly. While a drag is in
    // flight (editedRoute set), leave the existing handles exactly where the
    // user put them rather than re-deriving them from the newly-fit path.
    if (!this.state.editedRoute || this.waypointMarkers.length === 0) {
      this.setWaypointMarkers(engine.resampleWaypoints(r.latlngs, 10));
    }

    if (recenter) {
      try { this.map.fitBounds(this.line.getBounds().pad(0.28)); } catch (e) { /* empty bounds on first paint */ }
    }
  }

  waypointIcon() {
    return L.divIcon({ className: '', html: '<div class="ra-wp-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  }

  setWaypointMarkers(points) {
    this.clearWaypointMarkers();
    this.waypointMarkers = points.map((p) => {
      const m = L.marker(p, { draggable: true, icon: this.waypointIcon(), zIndexOffset: 100 }).addTo(this.map);
      m.on('dragend', () => this.onWaypointDragged());
      return m;
    });
  }

  clearWaypointMarkers() {
    (this.waypointMarkers || []).forEach((m) => m.remove());
    this.waypointMarkers = [];
  }

  onWaypointDragged() {
    const pts = this.waypointMarkers.map((m) => { const p = m.getLatLng(); return [p.lat, p.lng]; });
    if (pts.length < 2) return;
    const closed = [...pts, pts[0]];
    const myGen = ++this._editGen;
    this.setState({
      editedRoute: { latlngs: closed, distanceKm: engine.polylineDistanceKm(closed) },
      loadedRoute: null,
      editStatus: 'loading',
      editError: '',
    });
    engine.fitRouteFromWaypoints(closed).then((r) => {
      if (myGen !== this._editGen) return; // superseded by a newer drag
      this.setState({
        editedRoute: { latlngs: r.latlngs, distanceKm: r.distanceKm },
        editStatus: r.snapped ? 'ok' : 'error',
        editError: r.snapped ? '' : (r.error || ''),
      });
    });
  }

  // The route line draws itself on rather than popping in fully formed —
  // a small signature moment tied to the product (a route being traced).
  animateRouteDraw() {
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;
    const linePath = this.line && this.line.getElement && this.line.getElement();
    if (!linePath || typeof linePath.getTotalLength !== 'function') return;
    const glowPath = this.glow && this.glow.getElement && this.glow.getElement();
    const len = linePath.getTotalLength();
    linePath.style.transition = 'none';
    linePath.style.strokeDasharray = `${len}`;
    linePath.style.strokeDashoffset = `${len}`;
    if (glowPath) { glowPath.style.transition = 'none'; glowPath.style.opacity = '0'; }
    linePath.getBoundingClientRect(); // force reflow before enabling the transition
    linePath.style.transition = `stroke-dashoffset ${ROUTE_DRAW_MS}ms cubic-bezier(.4,0,.2,1)`;
    linePath.style.strokeDashoffset = '0';
    if (glowPath) { glowPath.style.transition = `opacity ${ROUTE_DRAW_MS}ms ease`; glowPath.style.opacity = '0.22'; }
  }

  onMarkerDrag(e) {
    this._locationTouchedByUser = true;
    const p = e.target.getLatLng();
    const cur = this.route ? this.route.latlngs[0] : [this.state.location.lat, this.state.location.lng];
    const dLat = p.lat - cur[0], dLng = p.lng - cur[1];
    this.setState((s) => ({
      location: { name: 'Dropped pin', lat: s.location.lat + dLat, lng: s.location.lng + dLng },
      loadedRoute: null, editedRoute: null,
    }));
  }

  async doSearch(e) {
    if (e && e.preventDefault) e.preventDefault();
    const q = this.state.query.trim();
    if (!q) return;
    this.setState({ searching: true, results: [] });
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q));
      const data = await res.json();
      this.setState({
        searching: false,
        results: data.map((d) => ({ label: d.display_name, lat: +d.lat, lng: +d.lon })),
      });
    } catch (err) {
      this.setState({ searching: false, results: [] });
      this.flash('Search unavailable — drag the pin to reposition');
    }
  }

  pickResult(r) {
    this._recenterNext = true;
    this._locationTouchedByUser = true;
    const short = r.label.split(',').slice(0, 2).join(',');
    this.setState({ location: { name: short, lat: r.lat, lng: r.lng }, results: [], query: short, loadedRoute: null, editedRoute: null });
    if (this.map) this.map.setView([r.lat, r.lng], 14);
  }

  async doGenerate(e) {
    if (e && e.preventDefault) e.preventDefault();
    const p = this.state.prompt.trim();
    if (!p) return;
    this.setState({ generating: true, genError: '' });
    let pts = null;
    let aiFailed = false;
    try {
      const res = await fetch('/api/generate-shape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: p }),
      });
      if (res.ok) {
        const data = await res.json();
        pts = this.validatePoints(data.points);
        if (!pts) aiFailed = true;
      } else {
        aiFailed = true;
      }
    } catch (err) {
      aiFailed = true;
    }
    if (!pts) pts = engine.proceduralShape(p);
    this.setState({
      generating: false, shapeId: 'custom', customPoints: engine.normalize(pts), customName: p,
      genError: aiFailed ? 'Could not reach the shape generator — made an abstract shape instead.' : '',
      loadedRoute: null, editedRoute: null,
    });
  }

  validatePoints(points) {
    if (!Array.isArray(points)) return null;
    const pts = points
      .filter((a) => Array.isArray(a) && a.length >= 2 && isFinite(a[0]) && isFinite(a[1]))
      .map((a) => [+a[0], +a[1]]);
    return pts.length >= 6 ? pts : null;
  }

  flash(msg) {
    this.setState({ toast: msg });
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.setState({ toast: '' }), 2600);
  }

  downloadGpx() {
    if (!this.route) return;
    const name = this.currentName() + ' — RouteArt';
    const gpx = engine.buildGPX(this.route.latlngs, name);
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.currentName().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-route.gpx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.flash('GPX downloaded — ready for your watch');
  }

  escapeXml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  // Renders the on-screen share card to a real PNG and hands it to the OS share
  // sheet (or downloads it) — the card previously just sat there looking
  // shareable with no way to actually get it off the device.
  async shareImage() {
    if (!this._shareData) return;
    const { path, title, meta } = this._shareData;
    const w = 400, h = 210;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <rect width="${w}" height="${h}" fill="#0d0f0b"/>
      <path d="${path}" fill="none" stroke="#2fd897" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity="0.28"/>
      <path d="${path}" fill="none" stroke="#2fd897" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="18" y="${h - 34}" fill="#f4f2ea" font-family="Georgia, serif" font-size="20" font-weight="700">${this.escapeXml(title)}</text>
      <text x="18" y="${h - 14}" fill="#9a9c8f" font-family="Barlow, sans-serif" font-size="12">${this.escapeXml(meta)}</text>
    </svg>`;

    try {
      const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const img = new Image();
      const loaded = new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      img.src = svgUrl;
      await loaded;

      const canvas = document.createElement('canvas');
      canvas.width = w * 2; canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(svgUrl);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'routeart-share.png', { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title, text: 'Made with RouteArt' });
        this.flash('Shared');
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'routeart-share.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        this.flash('Image downloaded — ready to share');
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.flash('Could not create the share image');
    }
  }

  saveCurrentRoute() {
    if (!this.route) return;
    const s = this.state;
    const record = {
      id: savedRoutesStore.newRouteId(),
      name: this.currentName(),
      mode: s.routeMode,
      latlngs: this.route.latlngs,
      distanceKm: this.route.distKm,
      paceMinPerKm: s.paceMinPerKm,
      locationName: s.location.name,
      createdAt: Date.now(),
      shapeName: s.routeMode === 'custom' ? this.currentName() : null,
    };
    const next = savedRoutesStore.saveRoute(s.savedRoutes, record);
    this.setState({ savedRoutes: next, loadedRoute: record, editedRoute: null });
    this.flash('Route saved');
  }

  deleteSavedRoute(id) {
    this.setState((s) => ({ savedRoutes: savedRoutesStore.deleteRoute(s.savedRoutes, id) }));
  }

  loadSavedRoute(record) {
    this._recenterNext = true;
    this.setState({
      loadedRoute: record,
      editedRoute: null,
      routeMode: record.mode,
      paceMinPerKm: record.paceMinPerKm,
      location: { name: record.locationName, lat: record.latlngs[0][0], lng: record.latlngs[0][1] },
      savedRoutesOpen: false,
    });
  }

  currentName() {
    const s = this.state;
    if (s.loadedRoute) return this.titleCase(s.loadedRoute.shapeName || s.loadedRoute.name);
    if (s.routeMode === 'loop') return 'Loop';
    if (s.routeMode === 'suggested') {
      const r = s.suggestedResults[s.suggestedActiveIndex];
      const sh = r && engine.SHAPES.find((x) => x.id === r.shapeId);
      return sh ? sh.name : 'Route';
    }
    if (s.shapeId === 'custom') return this.titleCase(s.customName || 'Custom shape');
    const sh = engine.SHAPES.find((x) => x.id === s.shapeId);
    return sh ? sh.name : 'Route';
  }
  titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

  fmtPace(p) { const m = Math.floor(p); const s = Math.round((p - m) * 60); return `${m}:${String(s).padStart(2, '0')}`; }
  fmtTime(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  render() {
    const s = this.state;
    const cur = s.ready ? this.getCurrentRoute() : null;
    this.route = cur || this.route;

    const shapes = engine.SHAPES.map((sh) => {
      const sel = s.shapeId === sh.id;
      return {
        id: sh.id,
        name: sh.name,
        path: engine.toSvgPath(engine.generateShape(sh.id)),
        selected: sel,
        custom: false,
        onPick: () => this.setState({ shapeId: sh.id, rotationDeg: 0, scale: 1, loadedRoute: null, editedRoute: null }),
      };
    });
    if (s.customPoints) {
      const sel = s.shapeId === 'custom';
      shapes.push({
        id: 'custom',
        name: (s.customName || 'Custom').slice(0, 10),
        path: engine.toSvgPath(s.customPoints),
        selected: sel,
        custom: true,
        onPick: () => this.setState({ shapeId: 'custom', loadedRoute: null, editedRoute: null }),
      });
    }

    const comp = (s.routeMode === 'custom' && cur && cur.comp) ? cur.comp : null;
    const cc = comp ? COMPLEXITY_COPY[comp.level] : null;
    const complexColor = cc ? cc.color : null;
    const complexMsg = cc ? cc.msg(comp, s.distanceKm * s.scale) : '';

    const now = new Date();
    const distKm = cur ? cur.distKm : s.distanceKm;
    const rawPreviewPath = cur
      ? (cur.points ? engine.toSvgPath(cur.points, 210, 34) : engine.toSvgPathFromLatLngs(cur.latlngs, 210, 34))
      : '';
    const sharePath = rawPreviewPath.replace(/(\d+\.?\d*),(\d+\.?\d*)/g, (m2, x, y) => `${(+x + 95).toFixed(1)},${y}`);

    const statDistance = distKm.toFixed(1);
    const statTime = this.fmtTime(distKm * s.paceMinPerKm * 60);
    const statPace = this.fmtPace(s.paceMinPerKm);
    const locationShort = (s.location.name || '').split(',')[0];
    const shareTitle = `${this.currentName()} — GPS Art`;
    const shareMeta = `${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${locationShort}`;
    this._shareData = cur ? { path: sharePath, title: shareTitle, meta: shareMeta } : null;

    let modeStatusText = '';
    let modeStatusTone = 'ok';
    if (s.editedRoute) {
      if (s.editStatus === 'loading') { modeStatusText = 'Re-routing through your edit…'; modeStatusTone = 'loading'; }
      else if (s.editStatus === 'error') { modeStatusText = `${s.editError || 'Could not re-route.'} Showing your edit directly instead.`; modeStatusTone = 'warn'; }
      else { modeStatusText = `Route edited — ${s.editedRoute.distanceKm.toFixed(1)} km.`; modeStatusTone = 'ok'; }
    } else if (s.loadedRoute) {
      modeStatusText = `Viewing a saved route — ${s.loadedRoute.name}`;
    } else if (s.routeMode === 'loop') {
      if (s.loopStatus === 'loading') { modeStatusText = 'Finding a loop…'; modeStatusTone = 'loading'; }
      else if (s.loopStatus === 'ok' && s.loopRoute) { modeStatusText = `Loop found — ${s.loopRoute.distanceKm.toFixed(1)} km on real streets.`; modeStatusTone = 'ok'; }
      else if (s.loopStatus === 'error') { modeStatusText = `${s.loopError} Showing an approximate circular loop instead.`; modeStatusTone = 'warn'; }
    } else if (s.routeMode === 'suggested') {
      if (s.suggestedStatus === 'scouting') { modeStatusText = 'Scouting nearby streets…'; modeStatusTone = 'loading'; }
      else if (s.suggestedStatus === 'ok' && s.suggestedResults.length) {
        modeStatusText = `Found ${s.suggestedResults.length} good fit${s.suggestedResults.length === 1 ? '' : 's'} nearby.`;
        modeStatusTone = 'ok';
      } else if (s.suggestedStatus === 'error') { modeStatusText = 'Nothing fit well nearby — try Search wider.'; modeStatusTone = 'warn'; }
    } else if (s.snapToRoads) {
      if (s.snapStatus === 'loading') { modeStatusText = 'Following real streets…'; modeStatusTone = 'loading'; }
      else if (s.snapStatus === 'ok' && s.snappedRoute) {
        const pct = Math.round((s.snappedRoute.ratio - 1) * 100);
        modeStatusText = `Following real streets — ${s.snappedRoute.distanceKm.toFixed(1)} km`
          + (pct > 15 ? ` (streets add about ${pct}% to the drawn shape)` : '') + '.';
        modeStatusTone = 'ok';
      } else if (s.snapStatus === 'error') { modeStatusText = `${s.snapError} Showing the drawn shape instead.`; modeStatusTone = 'warn'; }
    } else {
      modeStatusText = 'Showing the drawn shape as straight lines, without following streets.';
      modeStatusTone = 'warn';
    }

    return (
      <div className="ra-app">

        <div ref={(el) => { this.mapEl = el; }} className="ra-map"></div>

        {!s.ready && (
          <div className="ra-loading-veil">
            <div className="ra-loading-veil-spin"></div>
            <div className="ra-loading-veil-text">LOADING MAP</div>
          </div>
        )}

        <header className="ra-topbar">
          <div className="ra-topbar-brand">
            <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--turf)', boxShadow: '0 0 12px rgba(47,216,151,.8)' }}></div>
            <div className="ra-display ra-wordmark">Route<span className="ra-wordmark-accent">Art</span></div>
            <span className="ra-topbar-tagline">Plan it. Run it.</span>
          </div>
          <button type="button" className="ra-topbar-saved" onClick={() => this.setState({ savedRoutesOpen: true })}>
            Saved Routes{s.savedRoutes.length > 0 ? ` (${s.savedRoutes.length})` : ''}
          </button>
        </header>

        <div className="ra-hud-row">
          <div className="ra-hud-chip ra-hud-chip--muted">Drag the pin to reposition</div>
        </div>

        {/* Always-visible chrome: mode + distance. No tap required to see or use these. */}
        <div className="ra-control-strip">
          <div className="ra-mode-toggle">
            <button type="button" className={`ra-mode-btn${s.routeMode === 'suggested' ? ' ra-mode-btn--selected' : ''}`} onClick={() => this.setState({ routeMode: 'suggested', loadedRoute: null, editedRoute: null })}>Suggested</button>
            <button type="button" className={`ra-mode-btn${s.routeMode === 'loop' ? ' ra-mode-btn--selected' : ''}`} onClick={() => this.setState({ routeMode: 'loop', loadedRoute: null, editedRoute: null })}>Loop</button>
            <button type="button" className={`ra-mode-btn${s.routeMode === 'custom' ? ' ra-mode-btn--selected' : ''}`} onClick={() => this.setState({ routeMode: 'custom', loadedRoute: null, editedRoute: null })}>Custom</button>
          </div>
          <div className="ra-distance-stepper">
            <button type="button" onClick={() => this.bumpDistance(-0.5)} aria-label="Decrease distance">–</button>
            <span className="ra-mono">{statDistance} km</span>
            <button type="button" onClick={() => this.bumpDistance(0.5)} aria-label="Increase distance">+</button>
          </div>
          <button
            type="button"
            className="ra-quick-export"
            disabled={!this.route}
            onClick={() => this.downloadGpx()}
            aria-label="Download GPX"
            title="Download GPX"
          >↓</button>
        </div>

        {/* Always-visible primary content: this is the whole point of the app,
            so it's on screen by default, not behind a tap. */}
        <div className="ra-result-strip">
          {modeStatusText && (
            <div className={`ra-status ra-status--${modeStatusTone} ra-status--floating`}>
              {modeStatusTone === 'loading' && <span className="ra-spin ra-spin-lt"></span>}
              <span>{modeStatusText}</span>
            </div>
          )}

          {s.routeMode === 'suggested' && (
            <div className="ra-result-cards">
              {s.suggestedStatus === 'scouting' && s.suggestedResults.length === 0 && (
                <div className="ra-result-card ra-result-card--status">
                  <span className="ra-spin"></span>
                  <span>Scouting nearby streets…</span>
                </div>
              )}
              {s.suggestedStatus === 'error' && (
                <div className="ra-result-card ra-result-card--status">
                  <span>Nothing fit well nearby.</span>
                  <button type="button" className="ra-btn ra-btn-ghost" onClick={() => this.searchWider()}>Search wider</button>
                </div>
              )}
              {s.suggestedResults.map((r, i) => {
                const tier = FIT_TIER_COPY[r.tier];
                const active = i === s.suggestedActiveIndex;
                const sh = engine.SHAPES.find((x) => x.id === r.shapeId);
                return (
                  <div key={r.shapeId} className={`ra-result-card${active ? ' ra-result-card--active' : ''}`} onClick={() => this.previewSuggestion(i)}>
                    <svg viewBox="0 0 100 100" className="ra-result-preview">
                      <path d={engine.toSvgPathFromLatLngs(r.latlngs, 100, 12)} fill="none" stroke={tier.color} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round"></path>
                    </svg>
                    <div className="ra-result-info">
                      <div className="ra-result-name">{sh ? sh.name : r.shapeId}</div>
                      <div className="ra-result-meta">
                        <span style={{ color: tier.color }}>{tier.label}</span>
                        <span> · {r.distanceKm.toFixed(1)} km</span>
                      </div>
                      {s.suggestedCenter && s.suggestedCenter.offsetM > 50 && (
                        <div className="ra-result-offset">{Math.round(s.suggestedCenter.offsetM)}m from your pin</div>
                      )}
                    </div>
                    <button type="button" className="ra-btn ra-btn-fill ra-result-use" onClick={(e) => { e.stopPropagation(); this.selectSuggestion(r); }}>Use this route</button>
                  </div>
                );
              })}
              {s.suggestedStatus === 'ok' && (
                <button type="button" className="ra-result-wider" onClick={() => this.searchWider()}>Search wider</button>
              )}
            </div>
          )}

          {s.routeMode === 'loop' && (
            <div className="ra-result-cards">
              <div className="ra-result-card ra-result-card--single ra-result-card--active">
                <svg viewBox="0 0 100 100" className="ra-result-preview">
                  <path d={cur ? engine.toSvgPathFromLatLngs(cur.latlngs, 100, 12) : ''} fill="none" stroke={TURF} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round"></path>
                </svg>
                <div className="ra-result-info">
                  <div className="ra-result-name">Loop</div>
                  <div className="ra-result-meta">{statDistance} km</div>
                </div>
                <button type="button" className="ra-btn ra-btn-ghost ra-result-use" onClick={() => this.shuffleLoop()}>
                  {s.loopStatus === 'loading' && <span className="ra-spin ra-spin-lt"></span>}
                  <span>Shuffle</span>
                </button>
              </div>
            </div>
          )}

          {s.routeMode === 'custom' && (
            <div className="ra-result-cards">
              <div className="ra-result-card ra-result-card--single ra-result-card--active">
                <svg viewBox="0 0 100 100" className="ra-result-preview">
                  <path d={cur ? engine.toSvgPathFromLatLngs(cur.latlngs, 100, 12) : ''} fill="none" stroke={TURF} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round"></path>
                </svg>
                <div className="ra-result-info">
                  <div className="ra-result-name">{this.currentName()}</div>
                  <div className="ra-result-meta">{statDistance} km</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {!s.sheetExpanded && (
          <button type="button" className="ra-finetune-toggle" onClick={() => this.setState({ sheetExpanded: true })}>
            <span>Fine-tune</span>
            <span className="ra-finetune-chevron">⌄</span>
          </button>
        )}

        {s.sheetExpanded && (
          <div className="ra-sheet ra-sheet--expanded">
            <div className="ra-sheet-grip-bar" onClick={() => this.setState({ sheetExpanded: false })}>
              <div className="ra-sheet-grip"></div>
            </div>
            <div className="ra-sheet-body">

              {/* Share + export — kept at the top of the panel: even inside
                  Fine-tune, this shouldn't be the last thing you find. */}
              <div className="ra-actions">
                <div className="ra-share-card">
                  <button type="button" className="ra-share-action" onClick={() => this.shareImage()} title="Share as image">⤴</button>
                  <div className="ra-share-head">
                    <div className="ra-mono ra-share-avatar">YR</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="ra-share-name">Your Run</div>
                      <div className="ra-share-meta">{shareMeta}</div>
                    </div>
                  </div>
                  <div className="ra-mono ra-share-title">{shareTitle}</div>
                  <div className="ra-share-map">
                    <svg viewBox="0 0 400 210" style={{ width: '100%', display: 'block' }}>
                      <rect x="0" y="0" width="400" height="210" fill="var(--ink-950)"></rect>
                      <path d={sharePath} fill="none" stroke="var(--turf)" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" opacity="0.28" style={{ filter: 'blur(3px)' }}></path>
                      <path d={sharePath} fill="none" stroke="var(--turf)" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round"></path>
                    </svg>
                  </div>
                </div>

                <div className="ra-export">
                  <button type="button" className="ra-btn ra-btn-fill ra-export-primary" onClick={() => this.downloadGpx()}>
                    <span style={{ fontSize: 17 }}>↓</span> Download GPX
                  </button>
                  <button type="button" className="ra-btn ra-btn-ghost ra-export-secondary" onClick={() => this.saveCurrentRoute()}>Save Route</button>
                  <div className="ra-export-note">Load the GPX into Strava, Garmin or Komoot to run it for real.</div>
                </div>
              </div>

              {/* Start */}
              <div className="ra-sheet-section">
                <div className="ra-field-label">Start &amp; finish</div>
                <form className="ra-row" onSubmit={(e) => this.doSearch(e)}>
                  <input className="ra-input" value={s.query} onChange={(e) => this.setState({ query: e.target.value })} placeholder="Search a city or address" />
                  <button type="submit" className="ra-icon-btn">
                    {s.searching ? <span className="ra-spin ra-spin-lt"></span> : <span>→</span>}
                  </button>
                </form>
                {s.results.length > 0 && (
                  <div className="ra-results">
                    {s.results.map((r, i) => (
                      <div key={i} className="ra-result-row" onClick={() => this.pickResult(r)}>
                        {r.label.split(',').slice(0, 3).join(', ')}
                      </div>
                    ))}
                  </div>
                )}
                <div className="ra-current-location">
                  <div className="ra-current-location-dot"></div>
                  <span className="ra-current-location-name">{s.location.name}</span>
                </div>
              </div>

              {/* Distance & Pace — quick nudges live in the control strip above;
                  this is for dialing in an exact number. */}
              <div className="ra-sheet-section">
                <div className="ra-value-row">
                  <div className="ra-field-label">Target distance</div>
                  <div className="ra-mono ra-value">{s.distanceKm.toFixed(1)}<span className="ra-value-unit"> km</span></div>
                </div>
                <input type="range" className="ra-range" min="2" max="50" step="0.5" value={s.distanceKm} onChange={(e) => this.setState({ distanceKm: +e.target.value, loadedRoute: null, editedRoute: null })} style={{ width: '100%' }} />
                <div className="ra-range-minmax"><span>2 km</span><span>50 km</span></div>

                <div className="ra-subfield">
                  <div className="ra-value-row">
                    <div className="ra-field-label">Your pace</div>
                    <div className="ra-mono ra-value">{statPace}<span className="ra-value-unit"> /km</span></div>
                  </div>
                  <input type="range" className="ra-range ra-range--chalk" min="3" max="9" step="0.25" value={s.paceMinPerKm} onChange={(e) => this.setState({ paceMinPerKm: +e.target.value })} style={{ width: '100%' }} />
                  <div className="ra-range-minmax"><span>{this.fmtPace(3)} /km</span><span>{this.fmtPace(9)} /km</span></div>
                </div>
              </div>

              {/* Suggested: search radius */}
              {s.routeMode === 'suggested' && (
                <div className="ra-sheet-section">
                  <div className="ra-value-row">
                    <div className="ra-field-label">Search radius</div>
                    <div className="ra-mono ra-value" style={{ fontSize: 20 }}>{s.searchRadiusKm.toFixed(1)} km</div>
                  </div>
                  <button type="button" className="ra-btn ra-btn-ghost" style={{ width: '100%', height: 44 }} onClick={() => this.searchWider()}>Search wider</button>
                </div>
              )}

              {/* Custom: shape grid + AI prompt + fine controls */}
              {s.routeMode === 'custom' && (
                <div className="ra-sheet-section">
                  <div className="ra-field-label">Shape</div>
                  <div className="ra-shape-grid">
                    {shapes.map((sh) => (
                      <div key={sh.id} onClick={sh.onPick} className={`ra-shape-card${sh.selected ? ' ra-shape-card--selected' : ''}${sh.custom ? ' ra-shape-card--custom' : ''}`}>
                        <svg viewBox="0 0 100 100" style={{ width: 42, height: 42, display: 'block' }}>
                          <path d={sh.path} fill="none" style={{ stroke: sh.selected ? 'var(--turf)' : 'var(--paper-dim)' }} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round"></path>
                        </svg>
                        <div className="ra-shape-name" style={{ color: sh.selected ? 'var(--turf)' : 'var(--paper-dim)' }}>{sh.name}</div>
                      </div>
                    ))}
                  </div>

                  <div className="ra-subfield">
                    <div className="ra-field-label">…or describe anything</div>
                    <form className="ra-row" onSubmit={(e) => this.doGenerate(e)}>
                      <input className="ra-input" value={s.prompt} onChange={(e) => this.setState({ prompt: e.target.value })} placeholder='"a fox", "a rocket"' />
                      <button type="submit" className="ra-btn ra-btn-fill" style={{ flex: 'none', height: 44, padding: '0 17px', fontSize: 13 }}>
                        {s.generating && <span className="ra-spin"></span>}
                        <span>{s.generating ? 'Drawing' : 'Generate'}</span>
                      </button>
                    </form>
                    {!!s.genError && <div className="ra-hint-text">{s.genError}</div>}
                  </div>

                  {comp && (
                    <div className="ra-complexity" style={{ '--cx': complexColor }}>
                      <div className="ra-complexity-head">
                        <div className="ra-complexity-dot"></div>
                        <div className="ra-complexity-title">{cc.title}</div>
                      </div>
                      <div className="ra-complexity-msg">{complexMsg}</div>
                    </div>
                  )}

                  <div className="ra-subfield">
                    <div className="ra-toggle-row">
                      <div className="ra-toggle-label">Follow real streets</div>
                      <button type="button" aria-pressed={s.snapToRoads} className={`ra-toggle${s.snapToRoads ? ' ra-toggle--on' : ''}`} onClick={() => this.setState({ snapToRoads: !s.snapToRoads, loadedRoute: null, editedRoute: null })}>
                        <span className="ra-toggle-thumb"></span>
                      </button>
                    </div>
                  </div>

                  <div className="ra-subfield">
                    <div className="ra-value-row">
                      <div className="ra-field-label">Rotate</div>
                      <div className="ra-mono ra-value" style={{ fontSize: 20 }}>{Math.round(s.rotationDeg)}°</div>
                    </div>
                    <input type="range" className="ra-range" min="0" max="360" step="1" value={s.rotationDeg} onChange={(e) => this.setState({ rotationDeg: +e.target.value, loadedRoute: null, editedRoute: null })} style={{ width: '100%' }} />
                  </div>

                  <div className="ra-subfield">
                    <div className="ra-value-row">
                      <div className="ra-field-label">Scale</div>
                      <div className="ra-mono ra-value" style={{ fontSize: 20 }}>{Math.round(s.scale * 100)}%</div>
                    </div>
                    <input type="range" className="ra-range" min="0.55" max="1.7" step="0.01" value={s.scale} onChange={(e) => this.setState({ scale: +e.target.value, loadedRoute: null, editedRoute: null })} style={{ width: '100%' }} />
                  </div>

                  <button type="button" className="ra-btn ra-btn-ghost" style={{ width: '100%', height: 40, marginTop: 4 }} onClick={() => this.setState({ rotationDeg: 0, scale: 1, loadedRoute: null, editedRoute: null })}>Reset position</button>
                </div>
              )}

              {/* Stats */}
              <div className="ra-splitboard">
                <div className="ra-split">
                  <div className="ra-split-label">Distance</div>
                  <div className="ra-mono ra-split-value">{statDistance}<span className="ra-split-unit"> km</span></div>
                </div>
                <div className="ra-split">
                  <div className="ra-split-label">Est. time</div>
                  <div className="ra-mono ra-split-value">{statTime}</div>
                </div>
                <div className="ra-split">
                  <div className="ra-split-label">Pace</div>
                  <div className="ra-mono ra-split-value">{statPace}<span className="ra-split-unit"> /km</span></div>
                </div>
              </div>

            </div>
          </div>
        )}

        {s.savedRoutesOpen && (
          <div className="ra-modal-overlay" onClick={() => this.setState({ savedRoutesOpen: false })}>
            <div className="ra-modal" onClick={(e) => e.stopPropagation()}>
              <div className="ra-modal-head">
                <div className="ra-modal-title">Saved Routes</div>
                <button type="button" className="ra-modal-close" onClick={() => this.setState({ savedRoutesOpen: false })}>×</button>
              </div>
              {s.savedRoutes.length === 0 ? (
                <div className="ra-modal-empty">No saved routes yet — generate a route and tap Save.</div>
              ) : (
                <div className="ra-modal-list">
                  {s.savedRoutes.map((r) => (
                    <div key={r.id} className="ra-saved-row" onClick={() => this.loadSavedRoute(r)}>
                      <svg viewBox="0 0 64 64" className="ra-saved-thumb">
                        <path d={engine.toSvgPathFromLatLngs(r.latlngs, 64, 8)} fill="none" stroke="var(--turf)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"></path>
                      </svg>
                      <div className="ra-saved-info">
                        <div className="ra-saved-name">{r.name}</div>
                        <div className="ra-saved-meta">{r.distanceKm.toFixed(1)} km · {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                      </div>
                      <button type="button" className="ra-saved-delete" onClick={(e) => { e.stopPropagation(); this.deleteSavedRoute(r.id); }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {!!s.toast && <div className="ra-toast">{s.toast}</div>}

      </div>
    );
  }
}
