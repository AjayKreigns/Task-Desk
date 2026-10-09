import { useEffect, useRef } from 'react';

// Ambient "constellation" background: nodes drift continuously and draw a line to
// any neighbour within LINK_DIST, so the layer is always visibly in motion.
//
// Confined to the content area and painted behind everything (see .bg-network in
// index.css). Purely decorative — aria-hidden, pointer-events: none.
//
// Cost control:
//  - throttled to FPS below (slow drift is indistinguishable from 60fps, and this
//    halves both the canvas work and the backdrop-filter re-sampling the .card /
//    .kpi-card blurs have to do whenever what's behind them changes)
//  - node count scales with area but is hard-capped, keeping the O(n^2) link scan bounded
//  - squared-distance compare, so Math.sqrt only runs for pairs actually linked
//  - paused while the tab is hidden, and fully static under prefers-reduced-motion
const MAX_NODES = 80;
const AREA_PER_NODE = 16000;
const LINK_DIST = 140;
const FPS = 30;
const DOT_RADIUS = 2;
const DOT_ALPHA = 0.62;
const LINE_ALPHA = 0.32;
// Spread of each velocity component: vx and vy land in [-DRIFT/2, +DRIFT/2] px per
// frame. Measured median node speed is roughly 8.5 x DRIFT px/s at 30fps.
//
// Tuning history, every figure measured rather than estimated:
//   0.32  ~4 px/s   - too slow (six minutes to cross a 1314px content area)
//   2.6   ~22 px/s  - too fast (one minute)
//   1.0   ~8.5 px/s - settled here: about 2.5 minutes to cross
// Crossing time and speed are the same knob (time = width / speed), so they cannot
// be targeted independently. This one number is the only thing to change.
const DRIFT = 1.0;

// `full`: renders edge-to-edge instead of inset by the sidebar/topbar. Used on
// the login and account screens, which have neither — without this the
// constellation would be confined to a dead 270x64 corner of a page that has no
// sidebar or topbar to inset from.
export default function BackgroundNetwork({ full = false } = {}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let nodes = [];
    let raf = null;
    let lastFrame = 0;
    let running = true;
    let prevW = 0;
    let prevH = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Cap DPR at 2 — beyond that the backing store grows fast for no visible gain
    const scale = () => Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;

      const dpr = scale();
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Rescale existing nodes into the new box rather than clamping them, so a
      // first measure taken before layout settles can't leave the field bunched
      // into one corner forever.
      if (prevW > 0 && prevH > 0 && (prevW !== w || prevH !== h)) {
        const sx = w / prevW;
        const sy = h / prevH;
        for (const n of nodes) { n.x *= sx; n.y *= sy; }
      }
      prevW = w;
      prevH = h;

      const target = Math.max(12, Math.min(MAX_NODES, Math.round((w * h) / AREA_PER_NODE)));
      // Keep existing nodes so resizing doesn't reshuffle the whole field
      nodes = Array.from({ length: target }, (_, i) => nodes[i] || {
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * DRIFT,
        vy: (Math.random() - 0.5) * DRIFT,
      });
      for (const n of nodes) {
        n.x = Math.max(0, Math.min(n.x, w));
        n.y = Math.max(0, Math.min(n.y, h));
      }
    }

    // Read the accent straight off the theme attribute so light/dark both work
    function accent() {
      return document.documentElement.getAttribute('data-theme') === 'dark'
        ? '167, 139, 250'
        : '124, 58, 237';
    }

    function draw() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const rgb = accent();
      ctx.clearRect(0, 0, w, h);

      ctx.lineWidth = 1;
      const maxD2 = LINK_DIST * LINK_DIST;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxD2) continue;
          const fade = 1 - Math.sqrt(d2) / LINK_DIST;
          ctx.strokeStyle = `rgba(${rgb}, ${(LINE_ALPHA * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }

      ctx.fillStyle = `rgba(${rgb}, ${DOT_ALPHA})`;
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function step(ts) {
      raf = requestAnimationFrame(step);
      if (!running) return;
      if (ts - lastFrame < 1000 / FPS) return;
      lastFrame = ts;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x <= 0 || n.x >= w) { n.vx *= -1; n.x = Math.max(0, Math.min(w, n.x)); }
        if (n.y <= 0 || n.y >= h) { n.vy *= -1; n.y = Math.max(0, Math.min(h, n.y)); }
      }
      draw();
    }

    function start() {
      if (raf === null && !reduced.matches) raf = requestAnimationFrame(step);
    }
    function stop() {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    }

    resize();
    draw();
    start();

    const observer = new ResizeObserver(() => { resize(); draw(); });
    observer.observe(canvas);

    // Redraw on theme flip so the accent updates even while paused
    const themeWatcher = new MutationObserver(() => draw());
    themeWatcher.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });

    const onVisibility = () => { running = !document.hidden; };
    document.addEventListener('visibilitychange', onVisibility);

    const onReducedChange = () => {
      if (reduced.matches) { stop(); draw(); } else start();
    };
    reduced.addEventListener('change', onReducedChange);

    return () => {
      stop();
      observer.disconnect();
      themeWatcher.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onReducedChange);
    };
  }, []);

  // The canvas is wrapped in a div because a <canvas> is a replaced element: it
  // will NOT stretch to fill top/left/right/bottom insets, it falls back to its
  // intrinsic 300x150. The div stretches; the canvas then fills the div at 100%.
  return (
    <div className={`bg-network${full ? ' bg-network-full' : ''}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
