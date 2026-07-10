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

export default class App extends Component {
  state = {
    ready: false,
    location: { name: 'Bank, London', lat: 51.5133, lng: -0.0886 },
    query: '',
    searching: false,
    results: [],
    distanceKm: 5,
    routeMode: 'loop', // 'loop' | 'shape'
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
    savedRoutesOpen: false,
    sheetExpanded: false,
    savedRoutes: savedRoutesStore.loadSavedRoutes(),
  };

  _snapGen = 0;
  _snapDebounce = null;
  _loopGen = 0;
  _loopDebounce = null;
  _editGen = 0;
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
      if (s.routeMode === 'shape' && s.snapToRoads) this.requestSnap();
      if (s.routeMode === 'loop') this.requestLoop();
      return;
    }

    const loadedRouteChanged = ps.loadedRoute !== s.loadedRoute;
    if (loadedRouteChanged) this.updateRoute(true);

    const editedRouteChanged = ps.editedRoute !== s.editedRoute;
    if (editedRouteChanged) this.updateRoute(false);

    const modeSwitched = ps.routeMode !== s.routeMode;

    if (s.routeMode === 'shape' && !s.loadedRoute && !s.editedRoute) {
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
      shapeName: s.routeMode === 'shape' ? this.currentName() : null,
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

    const comp = (s.routeMode === 'shape' && cur && cur.comp) ? cur.comp : null;
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
          <div className="ra-hud-chip">{statDistance} <span>km</span></div>
          <div className="ra-hud-chip ra-hud-chip--muted">Drag the pin to reposition</div>
        </div>

        <div className={`ra-sheet${s.sheetExpanded ? ' ra-sheet--expanded' : ''}`}>
          <div className="ra-sheet-collapsed" onClick={() => this.setState((s2) => ({ sheetExpanded: !s2.sheetExpanded }))}>
            <div className="ra-mode-toggle" onClick={(e) => e.stopPropagation()}>
              <button type="button" className={`ra-mode-btn${s.routeMode === 'loop' ? ' ra-mode-btn--selected' : ''}`} onClick={() => this.setState({ routeMode: 'loop', loadedRoute: null, editedRoute: null })}>Loop</button>
              <button type="button" className={`ra-mode-btn${s.routeMode === 'shape' ? ' ra-mode-btn--selected' : ''}`} onClick={() => this.setState({ routeMode: 'shape', loadedRoute: null, editedRoute: null })}>Shape</button>
            </div>
            <div className="ra-mono ra-sheet-stat">{statDistance} km · {statTime}</div>
            <div className="ra-sheet-grip"></div>
          </div>

          {s.sheetExpanded && (
            <div className="ra-sheet-body">

              {modeStatusText && (
                <div className={`ra-status ra-status--${modeStatusTone}`}>
                  {modeStatusTone === 'loading' && <span className="ra-spin ra-spin-lt"></span>}
                  <span>{modeStatusText}</span>
                </div>
              )}

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

              {/* Distance & Pace */}
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

              {/* Mode body */}
              {s.routeMode === 'loop' ? (
                <div className="ra-sheet-section">
                  <button type="button" className="ra-btn ra-btn-ghost" style={{ width: '100%', height: 44 }} onClick={() => this.shuffleLoop()}>
                    {s.loopStatus === 'loading' && <span className="ra-spin ra-spin-lt"></span>}
                    <span>Shuffle loop</span>
                  </button>
                </div>
              ) : (
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

              {/* Share + export */}
              <div className="ra-actions">
                <div className="ra-share-card">
                  <div className="ra-share-head">
                    <div className="ra-mono ra-share-avatar">YR</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="ra-share-name">Your Run</div>
                      <div className="ra-share-meta">{now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {locationShort}</div>
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

            </div>
          )}
        </div>

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
