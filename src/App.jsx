import { Component } from 'react';
import L from 'leaflet';
import * as engine from './routeart-engine.js';

const TURF = '#2fd897';
const CIRC = 2 * Math.PI * 30;
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
  };

  _snapGen = 0;
  _snapDebounce = null;

  componentDidMount() {
    // First-paint map/route/snap setup happens in componentDidUpdate's `!this.map`
    // branch below, which always fires after this setState commits.
    this.setState({ ready: true });
  }

  componentWillUnmount() {
    clearTimeout(this._toastT);
    clearTimeout(this._snapDebounce);
    if (this.map) { this.map.remove(); this.map = null; }
  }

  // Which route (geometric baseRoute vs a successful snap) should currently be
  // drawn/exported — compared by reference across renders to know when the
  // map's polyline actually needs to be redrawn (see componentDidUpdate).
  activeRouteKey(s) {
    return s.snapToRoads && s.snapStatus === 'ok' && s.snappedRoute ? s.snappedRoute : null;
  }

  componentDidUpdate(pp, ps) {
    if (!this.state.ready) return;
    if (!this.map) { this.ensureMap(); this.updateRoute(true); if (this.state.snapToRoads) this.requestSnap(); return; }
    const recenterKeys = ['shapeId', 'customPoints', 'distanceKm'];
    let recenter = recenterKeys.some((k) => ps[k] !== this.state[k]);
    if (this._recenterNext) { recenter = true; this._recenterNext = false; }
    const drawKeys = ['shapeId', 'customPoints', 'distanceKm', 'rotationDeg', 'scale', 'location'];
    const routeChanged = drawKeys.some((k) => ps[k] !== this.state[k]);
    // Toggling "Follow real streets" or a snap request resolving both change which
    // route is active without touching any drawKey — redraw the map for those too,
    // otherwise the polyline goes stale (stays on the old geometric/snapped shape).
    const activeRouteChanged = this.activeRouteKey(ps) !== this.activeRouteKey(this.state);
    if (routeChanged || activeRouteChanged) this.updateRoute(recenter);

    const snapKeys = [...drawKeys, 'snapToRoads'];
    if (snapKeys.some((k) => ps[k] !== this.state[k])) {
      clearTimeout(this._snapDebounce);
      if (this.state.snapToRoads) {
        this._snapDebounce = setTimeout(() => this.requestSnap(), 500);
      } else if (ps.snapToRoads) {
        this.setState({ snapStatus: 'idle', snapError: '', snappedRoute: null });
      }
    }
  }

  async requestSnap() {
    this.setState({ snapStatus: 'loading', snapError: '' });
    const myGen = ++this._snapGen;
    const r = await engine.fitRoute(this.baseRoute.latlngs, { mode: 'ors' });
    if (myGen !== this._snapGen) return; // superseded by a newer request
    if (r.snapped) {
      this.setState({ snapStatus: 'ok', snapError: '', snappedRoute: { latlngs: r.latlngs, distanceKm: r.distanceKm, ratio: r.ratio } });
    } else {
      this.setState({ snapStatus: 'error', snapError: r.error || 'Snapping failed.', snappedRoute: null });
    }
  }

  buildActiveRoute(baseRoute) {
    const s = this.state;
    const useSnap = s.snapToRoads && s.snapStatus === 'ok' && s.snappedRoute;
    return useSnap
      ? { ...baseRoute, latlngs: s.snappedRoute.latlngs, distKm: s.snappedRoute.distanceKm }
      : baseRoute;
  }

  ensureMap() {
    if (this.map || !this.mapEl) return;
    const { lat, lng } = this.state.location;
    this.map = L.map(this.mapEl, { zoomControl: true, attributionControl: true }).setView([lat, lng], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(this.map);
    setTimeout(() => this.map && this.map.invalidateSize(), 200);
  }

  computeRoute() {
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

  startIcon() {
    return L.divIcon({ className: '', html: '<div class="ra-pin-wrap"><div class="ra-pin-ring"></div><div class="ra-pin-dot"></div></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  }

  updateRoute(recenter) {
    if (!this.map) return;
    const r = this.computeRoute();
    this.baseRoute = r;
    this.route = this.buildActiveRoute(r);
    if (this.glow) this.glow.remove();
    if (this.line) this.line.remove();
    this.glow = L.polyline(this.route.latlngs, { color: TURF, weight: 13, opacity: 0.22, lineJoin: 'round', lineCap: 'round' }).addTo(this.map);
    this.line = L.polyline(this.route.latlngs, { color: TURF, weight: 4.5, opacity: 1, lineJoin: 'round', lineCap: 'round' }).addTo(this.map);
    this.animateRouteDraw();
    const start = this.route.latlngs[0];
    if (!this.startMarker) {
      this.startMarker = L.marker(start, { draggable: true, icon: this.startIcon() }).addTo(this.map);
      this.startMarker.on('dragend', (e) => this.onMarkerDrag(e));
    } else {
      this.startMarker.setLatLng(start);
    }
    if (recenter) {
      try { this.map.fitBounds(this.line.getBounds().pad(0.28)); } catch (e) { /* empty bounds on first paint */ }
    }
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
    const p = e.target.getLatLng();
    const cur = this.route.latlngs[0];
    const dLat = p.lat - cur[0], dLng = p.lng - cur[1];
    this.setState((s) => ({ location: { name: 'Dropped pin', lat: s.location.lat + dLat, lng: s.location.lng + dLng } }));
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
    const short = r.label.split(',').slice(0, 2).join(',');
    this.setState({ location: { name: short, lat: r.lat, lng: r.lng }, results: [], query: short });
    if (this.map) this.map.setView([r.lat, r.lng], 14);
  }

  async doGenerate(e) {
    if (e && e.preventDefault) e.preventDefault();
    const p = this.state.prompt.trim();
    if (!p) return;
    this.setState({ generating: true, genError: '' });
    let pts = null;
    if (window.claude && window.claude.complete) {
      try {
        const out = await window.claude.complete({
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: `You are a GPS-art route generator. Output ONLY a JSON array of [x,y] points (numbers between 0 and 1) tracing the recognizable outline silhouette of: "${p}". Rules: a single continuous closed loop (do NOT repeat the first point at the end), 22 to 42 points, y pointing up, clearly recognizable. No prose, no code fences — just the JSON array.`,
          }],
        });
        pts = this.parsePoints(out);
      } catch (err) { console.warn('AI gen failed', err); }
    }
    if (!pts) {
      pts = engine.proceduralShape(p);
      this.setState({
        generating: false, shapeId: 'custom', customPoints: engine.normalize(pts), customName: p,
        genError: window.claude ? '' : 'Made an abstract shape — AI generation isn’t available here.',
      });
      return;
    }
    this.setState({ generating: false, shapeId: 'custom', customPoints: engine.normalize(pts), customName: p, genError: '' });
  }

  parsePoints(text) {
    try {
      const m = text.match(/\[\s*\[[\s\S]*\]\s*\]/);
      if (!m) return null;
      const arr = JSON.parse(m[0]);
      const pts = arr.filter((a) => Array.isArray(a) && a.length >= 2 && isFinite(a[0]) && isFinite(a[1])).map((a) => [+a[0], +a[1]]);
      return pts.length >= 6 ? pts : null;
    } catch (e) { return null; }
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

  copyShare() {
    if (!this.route) return;
    const d = this.route.distKm.toFixed(1);
    const txt = `${this.currentName()} — GPS Art\n${d} km · ${this.fmtPace(this.state.paceMinPerKm)}/km · ${this.fmtTime(this.route.distKm * this.state.paceMinPerKm * 60)}\nStart/finish: ${this.state.location.name}\nDrawn with RouteArt`;
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => this.flash('Route summary copied')).catch(() => this.flash('Copy failed'));
    else this.flash('Copy not supported');
  }

  currentName() {
    if (this.state.shapeId === 'custom') return this.titleCase(this.state.customName || 'Custom shape');
    const s = engine.SHAPES.find((x) => x.id === this.state.shapeId);
    return s ? s.name : 'Route';
  }
  titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

  fmtPace(p) { const m = Math.floor(p); const s = Math.round((p - m) * 60); return `${m}:${String(s).padStart(2, '0')}`; }
  fmtTime(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  render() {
    const s = this.state;
    const cur = s.ready ? this.computeRoute() : null;
    this.baseRoute = cur || this.baseRoute;
    this.route = cur ? this.buildActiveRoute(cur) : this.route;

    const shapes = engine.SHAPES.map((sh) => {
      const sel = s.shapeId === sh.id;
      return {
        id: sh.id,
        name: sh.name,
        path: engine.toSvgPath(engine.generateShape(sh.id)),
        selected: sel,
        custom: false,
        onPick: () => this.setState({ shapeId: sh.id, rotationDeg: 0, scale: 1 }),
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
        onPick: () => this.setState({ shapeId: 'custom' }),
      });
    }

    const comp = cur ? cur.comp : { level: 'ok', fidelity: 96, avgSegM: 100 };
    const cc = COMPLEXITY_COPY[comp.level];
    const complexColor = cc.color;
    const complexMsg = cc.msg(comp, s.distanceKm * s.scale);

    const fidDash = (CIRC * (1 - comp.fidelity / 100)).toFixed(1);

    const now = new Date();
    const hr = now.getHours();
    const daypart = hr < 12 ? 'Morning' : hr < 17 ? 'Afternoon' : 'Evening';
    const distKm = cur ? cur.distKm : s.distanceKm;
    const sharePath = cur
      ? engine.toSvgPath(cur.points, 210, 34).replace(/(\d+\.?\d*),(\d+\.?\d*)/g, (m2, x, y) => `${(+x + 95).toFixed(1)},${y}`)
      : '';

    const statDistance = distKm.toFixed(1);
    const statTime = this.fmtTime(distKm * s.paceMinPerKm * 60);
    const statPace = this.fmtPace(s.paceMinPerKm);
    const locationShort = (s.location.name || '').split(',')[0];
    const shareTitle = `${this.currentName()} — GPS Art`;

    let snapStatusText = '';
    if (s.snapStatus === 'loading') snapStatusText = 'Following real streets…';
    else if (s.snapStatus === 'ok' && s.snappedRoute) {
      const pct = Math.round((s.snappedRoute.ratio - 1) * 100);
      snapStatusText = `Following real streets — ${s.snappedRoute.distanceKm.toFixed(1)} km`
        + (pct > 15 ? ` (streets add about ${pct}% to the drawn shape)` : '') + '.';
    } else if (s.snapStatus === 'error') {
      snapStatusText = `${s.snapError} Showing the drawn shape instead.`;
    }

    return (
      <div className="ra-app">

        <header className="ra-header">
          <svg className="ra-watermark" viewBox="0 0 600 68" preserveAspectRatio="none" aria-hidden="true">
            <path d="M-10,20 Q65,-8 140,20 T290,20 T440,20 T610,20" fill="none" stroke="var(--paper)" strokeWidth="1" />
            <path d="M-10,40 Q65,12 140,40 T290,40 T440,40 T610,40" fill="none" stroke="var(--paper)" strokeWidth="1" />
            <path d="M-10,58 Q65,30 140,58 T290,58 T440,58 T610,58" fill="none" stroke="var(--paper)" strokeWidth="1" />
          </svg>
          <div className="ra-header-inner">
            <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--turf)', boxShadow: '0 0 12px rgba(47,216,151,.8)' }}></div>
            <div className="ra-display ra-wordmark">Route<span className="ra-wordmark-accent">Art</span></div>
          </div>
          <div className="ra-tagline">Draw it. Run it.</div>
        </header>

        <div className="ra-body">

          <aside className="ra-sidebar">

            {/* 01 — Start */}
            <section className="ra-step">
              <div className="ra-step-head">
                <span className="ra-mono ra-step-num">01</span>
                <h2 className="ra-step-title">Start</h2>
              </div>
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
            </section>

            {/* 02 — Distance & Pace */}
            <section className="ra-step">
              <div className="ra-step-head">
                <span className="ra-mono ra-step-num">02</span>
                <h2 className="ra-step-title">Distance &amp; Pace</h2>
              </div>
              <div className="ra-value-row">
                <div className="ra-field-label">Target distance</div>
                <div className="ra-mono ra-value">{s.distanceKm.toFixed(1)}<span className="ra-value-unit"> km</span></div>
              </div>
              <input type="range" className="ra-range" min="2" max="50" step="0.5" value={s.distanceKm} onChange={(e) => this.setState({ distanceKm: +e.target.value })} style={{ width: '100%' }} />
              <div className="ra-range-minmax"><span>2 km</span><span>50 km</span></div>

              <div className="ra-subfield">
                <div className="ra-value-row">
                  <div className="ra-field-label">Your pace</div>
                  <div className="ra-mono ra-value">{statPace}<span className="ra-value-unit"> /km</span></div>
                </div>
                <input type="range" className="ra-range ra-range--chalk" min="3" max="9" step="0.25" value={s.paceMinPerKm} onChange={(e) => this.setState({ paceMinPerKm: +e.target.value })} style={{ width: '100%' }} />
                <div className="ra-range-minmax"><span>{this.fmtPace(3)} /km</span><span>{this.fmtPace(9)} /km</span></div>
              </div>
            </section>

            {/* 03 — Shape */}
            <section className="ra-step">
              <div className="ra-step-head">
                <span className="ra-mono ra-step-num">03</span>
                <h2 className="ra-step-title">Shape</h2>
              </div>
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

              <div className="ra-complexity" style={{ '--cx': complexColor }}>
                <div className="ra-complexity-head">
                  <div className="ra-complexity-dot"></div>
                  <div className="ra-complexity-title">{cc.title}</div>
                </div>
                <div className="ra-complexity-msg">{complexMsg}</div>
              </div>
            </section>

            {/* 04 — Fine-tune */}
            <section className="ra-step">
              <div className="ra-step-head">
                <span className="ra-mono ra-step-num">04</span>
                <h2 className="ra-step-title">Fine-tune</h2>
              </div>

              <div className="ra-toggle-row">
                <div className="ra-toggle-label">Follow real streets</div>
                <button type="button" aria-pressed={s.snapToRoads} className={`ra-toggle${s.snapToRoads ? ' ra-toggle--on' : ''}`} onClick={() => this.setState({ snapToRoads: !s.snapToRoads })}>
                  <span className="ra-toggle-thumb"></span>
                </button>
              </div>
              {s.snapToRoads ? (
                snapStatusText && (
                  <div className={`ra-status ra-status--${s.snapStatus === 'ok' ? 'ok' : s.snapStatus === 'loading' ? 'loading' : 'warn'}`}>
                    {s.snapStatus === 'loading' && <span className="ra-spin ra-spin-lt"></span>}
                    <span>{snapStatusText}</span>
                  </div>
                )
              ) : (
                <div className="ra-status-copy">Showing the drawn shape as straight lines, without following streets.</div>
              )}

              <div className="ra-subfield">
                <div className="ra-value-row">
                  <div className="ra-field-label">Rotate</div>
                  <div className="ra-mono ra-value" style={{ fontSize: 20 }}>{Math.round(s.rotationDeg)}°</div>
                </div>
                <input type="range" className="ra-range" min="0" max="360" step="1" value={s.rotationDeg} onChange={(e) => this.setState({ rotationDeg: +e.target.value })} style={{ width: '100%' }} />
              </div>

              <div className="ra-subfield">
                <div className="ra-value-row">
                  <div className="ra-field-label">Scale</div>
                  <div className="ra-mono ra-value" style={{ fontSize: 20 }}>{Math.round(s.scale * 100)}%</div>
                </div>
                <input type="range" className="ra-range" min="0.55" max="1.7" step="0.01" value={s.scale} onChange={(e) => this.setState({ scale: +e.target.value })} style={{ width: '100%' }} />
              </div>

              <button className="ra-btn ra-btn-ghost" style={{ width: '100%', height: 40, marginTop: 16 }} onClick={() => this.setState({ rotationDeg: 0, scale: 1 })}>Reset position</button>
            </section>

          </aside>

          <main className="ra-main">
            <div className="ra-main-inner">

              <div className="ra-map-card">
                <div ref={(el) => { this.mapEl = el; }} className="ra-map"></div>

                {!s.ready && (
                  <div className="ra-loading-veil">
                    <div className="ra-loading-veil-spin"></div>
                    <div className="ra-loading-veil-text">LOADING MAP</div>
                  </div>
                )}

                <div className="ra-drag-hint">
                  <div className="ra-drag-hint-dot"></div>
                  Drag the pin to reposition
                </div>
              </div>

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
                <div className="ra-split ra-split--fidelity">
                  <div style={{ position: 'relative', width: 66, height: 66, flex: 'none' }}>
                    <svg viewBox="0 0 72 72" style={{ width: 66, height: 66, transform: 'rotate(-90deg)' }}>
                      <circle cx="36" cy="36" r="30" fill="none" stroke="var(--ink-800)" strokeWidth="7"></circle>
                      <circle cx="36" cy="36" r="30" fill="none" stroke={complexColor} strokeWidth="7" strokeLinecap="round" strokeDasharray={CIRC.toFixed(1)} strokeDashoffset={fidDash} style={{ transition: 'stroke-dashoffset .4s ease,stroke .3s' }}></circle>
                    </svg>
                    <div className="ra-mono" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 19, color: complexColor }}>{comp.fidelity}</div>
                  </div>
                  <div>
                    <div className="ra-split-label" style={{ marginBottom: 3 }}>Shape</div>
                    <div className="ra-split-label">Fidelity</div>
                  </div>
                </div>
              </div>

              <div className="ra-actions">

                <div className="ra-share-card">
                  <div className="ra-share-head">
                    <div className="ra-mono ra-share-avatar">YR</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="ra-share-name">Your Run</div>
                      <div className="ra-share-meta">{daypart} Run · {now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {locationShort}</div>
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
                  <div className="ra-share-stats">
                    <div className="ra-share-stat">
                      <div className="ra-share-stat-label">Distance</div>
                      <div className="ra-mono ra-share-stat-value">{statDistance}<span style={{ fontSize: 12, color: 'var(--paper-dim)' }}> km</span></div>
                    </div>
                    <div className="ra-share-stat">
                      <div className="ra-share-stat-label">Pace</div>
                      <div className="ra-mono ra-share-stat-value">{statPace}</div>
                    </div>
                    <div className="ra-share-stat">
                      <div className="ra-share-stat-label">Time</div>
                      <div className="ra-mono ra-share-stat-value">{statTime}</div>
                    </div>
                  </div>
                </div>

                <div className="ra-export">
                  <button className="ra-btn ra-btn-fill ra-export-primary" onClick={() => this.downloadGpx()}>
                    <span style={{ fontSize: 17 }}>↓</span> Download GPX
                  </button>
                  <button className="ra-btn ra-btn-ghost ra-export-secondary" onClick={() => this.copyShare()}>Copy route summary</button>
                  <div className="ra-export-note">Load the GPX into Strava, Garmin or Komoot to run it for real.</div>
                </div>
              </div>

            </div>
          </main>
        </div>

        {!!s.toast && <div className="ra-toast">{s.toast}</div>}

      </div>
    );
  }
}
