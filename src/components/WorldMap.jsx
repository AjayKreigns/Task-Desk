import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus, Minus } from 'lucide-react';
import { getCountryCodeFromPhone } from '../lib/phoneCountry';
import ModalPortal from './ModalPortal';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

// Fallback aspect ratio (matches world-map.svg's own width/height) used only
// before the real viewBox has loaded — pan math needs SOME ratio to clamp
// against on the very first frame.
const DEFAULT_ASPECT = 1009.6727 / 665.96301;

// Assumed tooltip footprint for viewport-edge clamping — generous enough for
// the longest realistic content ("Central African Republic - 12 enquiries"
// at 0.78rem), checked against window size rather than the rendered
// element's actual size so positioning never lags a frame behind the cursor.
const TOOLTIP_W = 260;
const TOOLTIP_H = 46;
const TOOLTIP_OFFSET = 14; // gap from the cursor, matching the old CSS translate

// Fetched once per page session and shared across every mounted instance
// (Dashboard's and Lead Center's maps both use this component) — a second
// mount reuses the same in-flight/resolved promise instead of re-fetching
// and re-parsing a ~1MB SVG.
let svgFetchPromise = null;

// Per-country pin anchor, computed once and shared across instances too —
// getBBox() needs the path to be laid out in a live document, so this can
// only run after the SVG is actually injected into the DOM.
const centroidCache = new Map(); // code -> {x, y} | null

// Several countries (Indonesia, Philippines, Japan, the UK, Greece...) are
// archipelagos described as ONE <path> with many disjoint M/m sub-paths.
// The whole path's bounding box centers somewhere in open ocean between
// islands, not on land — e.g. Indonesia's bbox spans Sumatra to Papua, so
// its center sits in the Java/Banda Sea.
//
// The fix is NOT to split the path's `d` string on M/m boundaries and
// measure each fragment separately — that was tried and produces garbage:
// these paths use relative (lowercase) commands throughout, so a subpath
// after the first one is positioned relative to wherever the PREVIOUS
// subpath ended. Lifted out on its own, that same fragment's leading "m"
// becomes the first command of a brand new path, which SVG always treats
// as absolute — collapsing every subpath after the first onto essentially
// nonsense coordinates near the fragment's own tiny internal deltas.
//
// Instead this samples points along the path's actual rendered geometry via
// getPointAtLength/getTotalLength — browser APIs that already resolve all
// the relative/absolute math correctly, since they walk the real geometry,
// not the source text. Consecutive samples land close together while
// tracing one landmass's outline; a big jump between samples marks a
// subpath boundary (a "moveto" jumps the pen without drawing). Splitting on
// those jumps and keeping the largest resulting cluster is what actually
// lands the pin on Java/Sumatra rather than mid-ocean.
function computeCentroid(svg, code) {
  if (centroidCache.has(code)) return centroidCache.get(code);

  const path = svg.querySelector(`#${CSS.escape(code)}`);
  const result = path ? centroidFromPathGeometry(path) : null;
  centroidCache.set(code, result);
  return result;
}

function centroidFromPathGeometry(path) {
  let totalLength;
  try { totalLength = path.getTotalLength(); } catch { totalLength = 0; }
  if (!totalLength) return centroidFromWholeBBox(path);

  const SAMPLE_COUNT = 300; // ample resolution for this map's precision
  const step = totalLength / SAMPLE_COUNT;
  const points = [];
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const p = path.getPointAtLength(Math.min(i * step, totalLength));
    points.push({ x: p.x, y: p.y });
  }

  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    gaps.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const avgGap = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
  // A subpath boundary jump dwarfs the normal point-to-point spacing along
  // a contour — several times the average is a generous, reliable cutoff.
  const jumpThreshold = Math.max(avgGap * 6, 2);

  const clusters = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    if (gaps[i - 1] > jumpThreshold) clusters.push([]);
    clusters[clusters.length - 1].push(points[i]);
  }

  let best = null; // { area, cx, cy }
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const xs = cluster.map(p => p.x), ys = cluster.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const area = (maxX - minX) * (maxY - minY);
    if (!best || area > best.area) {
      best = { area, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    }
  }

  return best ? { x: best.cx, y: best.cy } : centroidFromWholeBBox(path);
}

// Last-resort fallback — used only when the path has no measurable length
// or the clustering above found nothing (both signs of malformed data), so
// a pin still shows up rather than silently vanishing for that country.
function centroidFromWholeBBox(path) {
  try {
    const box = path.getBBox();
    return (box.width > 0 || box.height > 0) ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  } catch {
    return null;
  }
}

// Keeps the tooltip fully on-screen — without this, hovering a country near
// the right or bottom edge (anything past India on a wide map) pushes the
// tooltip partly or fully off-screen, and can even force the page itself to
// grow a stray scrollbar to accommodate it.
function clampToViewport(x, y) {
  const maxX = Math.max(0, window.innerWidth - TOOLTIP_W - TOOLTIP_OFFSET);
  const maxY = Math.max(0, window.innerHeight - TOOLTIP_H - TOOLTIP_OFFSET);
  return { x: Math.min(x + TOOLTIP_OFFSET, maxX), y: Math.min(y + TOOLTIP_OFFSET, maxY) };
}

export default function WorldMap({ leads, compact }) {
  const outerRef = useRef(null);
  const wrapperRef = useRef(null);
  const [svgReady, setSvgReady] = useState(false);
  const [viewBox, setViewBox] = useState(null);
  const [tooltip, setTooltip] = useState(null); // { name, count, x, y } | null
  const [pulsingCode, setPulsingCode] = useState(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const prevNewestId = useRef(undefined); // undefined = not yet initialized (first mount)
  const pulseTimeoutRef = useRef(null);
  const dragRef = useRef(null); // { startX, startY, startPanX, startPanY } | null

  const mapAspect = useMemo(() => {
    if (!viewBox) return DEFAULT_ASPECT;
    const [, , w, h] = viewBox.split(' ').map(Number);
    return w / h;
  }, [viewBox]);

  useEffect(() => {
    let cancelled = false;
    svgFetchPromise ??= fetch('/world-map.svg').then(r => r.text());
    svgFetchPromise.then(markup => {
      if (cancelled || !wrapperRef.current) return;
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
      const svg = doc.documentElement;

      // The source has no viewBox, only fixed width/height attributes —
      // synthesize one from those so the map scales responsively instead
      // of clipping/overflowing its card at other widths.
      const w = parseFloat(svg.getAttribute('width'));
      const h = parseFloat(svg.getAttribute('height'));
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', 'auto');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      wrapperRef.current.replaceChildren(svg);
      setViewBox(`0 0 ${w} ${h}`);
      setSvgReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Lead count per ISO2 code — recomputes whenever leads changes, which
  // happens automatically when a new enquiry arrives via the realtime
  // subscription (it prepends to the leads array in AppContext).
  const countsByCode = useMemo(() => {
    const m = new Map();
    for (const lead of leads) {
      const code = getCountryCodeFromPhone(lead.phone);
      if (!code) continue;
      m.set(code, (m.get(code) || 0) + 1);
    }
    return m;
  }, [leads]);

  // Compute centroids for any newly-seen country now that the map is in
  // the DOM (and on every leads change, in case a lead from a country with
  // no prior enquiries just arrived). Measuring the DOM belongs in a layout
  // effect, not render — useLayoutEffect runs synchronously after the DOM
  // updates but before the browser paints, so bumping state here to reflect
  // newly-computed centroids still lands in the same visual frame, with no
  // flicker of pin-less countries popping in a moment later.
  const [, forceRerenderForCentroids] = useState(0);
  useLayoutEffect(() => {
    const svg = wrapperRef.current?.querySelector('svg');
    if (!svgReady || !svg) return;
    let computedSomethingNew = false;
    for (const code of countsByCode.keys()) {
      if (!centroidCache.has(code)) computedSomethingNew = true;
      computeCentroid(svg, code);
    }
    if (computedSomethingNew) forceRerenderForCentroids(n => n + 1);
  }, [svgReady, countsByCode]);

  // "Just arrived" pulse — only for a lead that arrives AFTER this
  // component is already mounted and showing data, never on initial load
  // (leads[0] is always the newest, since realtime INSERTs prepend it).
  useEffect(() => {
    const newest = leads[0];
    if (prevNewestId.current === undefined) {
      prevNewestId.current = newest ? newest.id : null;
      return;
    }
    if (newest && newest.id !== prevNewestId.current) {
      prevNewestId.current = newest.id;
      const code = getCountryCodeFromPhone(newest.phone);
      if (code) {
        // This pairs the state update with a timer that clears it — the
        // timer can't be scheduled during render, so it can't be moved out
        // of the effect the way a plain derived-state sync could be.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPulsingCode(code);
        clearTimeout(pulseTimeoutRef.current);
        pulseTimeoutRef.current = setTimeout(() => setPulsingCode(null), 5000);
      }
    }
  }, [leads]);

  useEffect(() => () => clearTimeout(pulseTimeoutRef.current), []);

  // How far the map can be panned at a given zoom level before its edge
  // would pull away from the visible card and reveal empty space, in the
  // same UNSCALED units `pan` itself is stored in (translate() is applied
  // inside scale(), so 1 pan unit = `z` screen pixels at zoom level z).
  function getPanBounds(z) {
    const outerW = outerRef.current?.clientWidth || 0;
    const outerH = outerRef.current?.clientHeight || 0;
    const contentH = outerW / mapAspect;
    const overflowX = outerW * (z - 1);
    const overflowY = Math.max(0, contentH * z - outerH);
    return { maxX: (overflowX / 2) / z, maxY: (overflowY / 2) / z };
  }
  function clampPan(x, y, z) {
    const { maxX, maxY } = getPanBounds(z);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  }

  function handleZoomIn() {
    setZoom(z => {
      const nz = Math.min(MAX_ZOOM, z + ZOOM_STEP);
      setPan(p => clampPan(p.x, p.y, nz));
      return nz;
    });
  }
  function handleZoomOut() {
    setZoom(z => {
      const nz = Math.max(MIN_ZOOM, z - ZOOM_STEP);
      setPan(p => (nz <= MIN_ZOOM ? { x: 0, y: 0 } : clampPan(p.x, p.y, nz)));
      return nz;
    });
  }

  // Drag-to-pan — only meaningful once zoomed in; at 1x there's nothing
  // beyond the visible edge to reveal — EXCEPT in compact mode (Dashboard's
  // letterboxed overview), which already clips content top/bottom even at
  // 1x, so there's something worth panning to from the start there. Pointer
  // events (not mouse events) so a fast drag that briefly leaves the
  // element mid-gesture is still tracked via setPointerCapture, and
  // touch-drag works for free.
  function handlePanPointerDown(e) {
    if (!compact && zoom <= MIN_ZOOM) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanY: pan.y };
    setIsDragging(true);
    setTooltip(null);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not a capturable pointer (e.g. synthetic) */ }
  }
  function handlePanPointerMove(e) {
    if (!dragRef.current) return;
    const dx = (e.clientX - dragRef.current.startX) / zoom;
    const dy = (e.clientY - dragRef.current.startY) / zoom;
    setPan(clampPan(dragRef.current.startPanX + dx, dragRef.current.startPanY + dy, zoom));
  }
  function handlePanPointerUp(e) {
    if (!dragRef.current) return;
    dragRef.current = null;
    setIsDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  function handleMouseOver(e) {
    if (dragRef.current) return;
    const path = e.target.closest && e.target.closest('path[id]');
    if (!path) return;
    const code = path.id;
    const name = path.getAttribute('title') || code;
    const pos = clampToViewport(e.clientX, e.clientY);
    setTooltip({ name, count: countsByCode.get(code) || 0, ...pos });
  }
  function handleMouseMove(e) {
    if (dragRef.current) return;
    setTooltip(t => (t ? { ...t, ...clampToViewport(e.clientX, e.clientY) } : t));
  }
  function handleMouseOut(e) {
    const related = e.relatedTarget;
    if (!related || !related.closest || !related.closest('path[id]')) setTooltip(null);
  }

  const cursor = (compact || zoom > MIN_ZOOM) ? (isDragging ? 'grabbing' : 'grab') : undefined;

  return (
    <div ref={outerRef} className={`world-map-outer${compact ? ' world-map-outer--compact' : ''}`}>
      <div className="world-map-zoom-controls">
        <button
          type="button"
          className="world-map-zoom-btn"
          onClick={handleZoomIn}
          disabled={zoom >= MAX_ZOOM}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="world-map-zoom-btn"
          onClick={handleZoomOut}
          disabled={zoom <= MIN_ZOOM}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus size={14} />
        </button>
      </div>
      <div
        className="world-map-zoomable"
        style={{
          transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
          // The CSS transition (for smooth +/- button clicks) would also
          // ease every drag-move update, making panning lag behind the
          // cursor instead of tracking it 1:1 — suppressed while dragging.
          transition: isDragging ? 'none' : undefined,
        }}
      >
        <div
          ref={wrapperRef}
          className="world-map-wrapper"
          role="img"
          aria-label="World map showing which countries enquiries have come from"
          style={{ cursor, touchAction: (compact || zoom > MIN_ZOOM) ? 'none' : undefined }}
          onMouseOver={handleMouseOver}
          onMouseMove={handleMouseMove}
          onMouseOut={handleMouseOut}
          onPointerDown={handlePanPointerDown}
          onPointerMove={handlePanPointerMove}
          onPointerUp={handlePanPointerUp}
          onPointerCancel={handlePanPointerUp}
        />
        {svgReady && viewBox && (
          <svg className="world-map-pins" viewBox={viewBox} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {[...countsByCode.entries()].map(([code, count]) => {
              const c = centroidCache.get(code);
              if (!c) return null;
              const bucket = count >= 4 ? 'lg' : count >= 2 ? 'md' : 'sm';
              return (
                <g key={code} className={`world-map-pin world-map-pin--${bucket}`}>
                  {pulsingCode === code && <circle cx={c.x} cy={c.y} className="world-map-pin-ring" />}
                  <circle cx={c.x} cy={c.y} className="world-map-pin-dot" />
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {tooltip && (
        // Portalled to document.body — a CSS `transform` on any ancestor
        // (Dashboard wraps its content in framer-motion elements, which
        // carry one) turns `position: fixed` descendants into being
        // positioned relative to that ancestor instead of the real
        // viewport, which was landing this tooltip far from the cursor.
        <ModalPortal>
          <div className="world-map-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
            <strong>{tooltip.name}</strong>
            {tooltip.count > 0 && <span> - {tooltip.count} {tooltip.count === 1 ? 'enquiry' : 'enquiries'}</span>}
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
