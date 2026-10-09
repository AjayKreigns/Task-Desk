// Vector drawing helpers for the Monthly Report PDF — KPI cards and charts,
// built from jsPDF primitives so they stay sharp at any zoom and don't depend on
// anything being rendered on screen. The cover page lives in reportCover.js.

const NAVY = '#1e1b4b';
const PURPLE = '#7c3aed';
const PURPLE_DARK = '#5b21b6';
const GREY = '#64748b';
const LIGHT_GREY = '#e2e8f0';

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [124, 58, 237];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const fill = (doc, hex) => { const [r, g, b] = hexToRgb(hex); doc.setFillColor(r, g, b); };
const stroke = (doc, hex) => { const [r, g, b] = hexToRgb(hex); doc.setDrawColor(r, g, b); };
const textColor = (doc, hex) => { const [r, g, b] = hexToRgb(hex); doc.setTextColor(r, g, b); };

const polar = (cx, cy, r, deg) => {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

// ----------------------------------------------------------------- KPI cards

export function drawKpiCards(doc, { x, y, width, cards, height = 24 }) {
  const gap = 4;
  const cw = (width - gap * (cards.length - 1)) / cards.length;
  cards.forEach((card, i) => {
    const cx = x + i * (cw + gap);
    fill(doc, '#ffffff');
    stroke(doc, LIGHT_GREY);
    doc.setLineWidth(0.3);
    doc.roundedRect(cx, y, cw, height, 2, 2, 'FD');
    // accent strip along the top
    fill(doc, card.color);
    doc.roundedRect(cx, y, cw, 2.2, 1, 1, 'F');
    doc.rect(cx, y + 1.4, cw, 0.9, 'F');

    textColor(doc, GREY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(String(card.label).toUpperCase(), cx + 5, y + 10);

    textColor(doc, NAVY);
    doc.setFontSize(17);
    doc.text(String(card.value), cx + 5, y + 19.5);
  });
  return y + height;
}

// --------------------------------------------------------------------- donut

export function drawDonutChart(doc, { x, y, size, slices, legendWidth = 0 }) {
  const total = slices.reduce((s, v) => s + (Number(v.value) || 0), 0);
  const r = size / 2;
  const cx = x + r;
  const cy = y + r;
  if (total <= 0) return y + size;

  let angle = -90;
  slices.forEach(s => {
    const sweep = ((Number(s.value) || 0) / total) * 360;
    if (sweep <= 0) return;
    fill(doc, s.color);
    // fan of thin triangles approximates the sector cleanly at this size
    const step = 1.5;
    for (let a = angle; a < angle + sweep - 1e-9; a += step) {
      const a2 = Math.min(a + step, angle + sweep);
      const p1 = polar(cx, cy, r, a);
      const p2 = polar(cx, cy, r, a2);
      doc.triangle(cx, cy, p1.x, p1.y, p2.x, p2.y, 'F');
    }
    angle += sweep;
  });

  // punch the hole
  fill(doc, '#ffffff');
  doc.circle(cx, cy, r * 0.58, 'F');
  textColor(doc, NAVY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(String(total), cx, cy + 1, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  textColor(doc, GREY);
  doc.text('TASKS', cx, cy + 5.5, { align: 'center' });

  // legend
  if (legendWidth > 0) {
    const lx = x + size + 8;
    let ly = y + 4;
    doc.setFontSize(8);
    slices.forEach(s => {
      if (ly > y + size) return;
      fill(doc, s.color);
      doc.roundedRect(lx, ly - 2.4, 2.6, 2.6, 0.5, 0.5, 'F');
      textColor(doc, NAVY);
      const pct = total > 0 ? Math.round(((Number(s.value) || 0) / total) * 100) : 0;
      const label = doc.splitTextToSize(s.label, legendWidth - 22)[0];
      doc.text(label, lx + 4.5, ly);
      textColor(doc, GREY);
      doc.text(`${pct}%`, lx + legendWidth - 4, ly, { align: 'right' });
      ly += 5.6;
    });
  }
  return y + size;
}

// ------------------------------------------------------- horizontal bar pairs

export function drawHorizontalBars(doc, { x, y, width, rows, series, labelWidth = 42, rowHeight = 9 }) {
  const max = Math.max(1, ...rows.flatMap(r => series.map(s => Number(r[s.key]) || 0)));
  const trackX = x + labelWidth;
  const trackW = width - labelWidth - 14;
  const barH = (rowHeight - 3) / series.length;

  rows.forEach((row, i) => {
    const ry = y + i * rowHeight;
    textColor(doc, NAVY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(doc.splitTextToSize(String(row.label), labelWidth - 3)[0], x, ry + rowHeight / 2 + 0.5);

    series.forEach((s, si) => {
      const v = Number(row[s.key]) || 0;
      const bw = (v / max) * trackW;
      fill(doc, '#f1f5f9');
      doc.rect(trackX, ry + 1.5 + si * barH, trackW, barH - 0.5, 'F');
      if (bw > 0) {
        fill(doc, s.color);
        doc.rect(trackX, ry + 1.5 + si * barH, bw, barH - 0.5, 'F');
      }
      textColor(doc, GREY);
      doc.setFontSize(6.5);
      doc.text(String(v), trackX + trackW + 2, ry + 1.5 + si * barH + barH - 1);
    });
  });

  return y + rows.length * rowHeight;
}

// ------------------------------------------------------------- line/area trend

export function drawTrendChart(doc, { x, y, width, height, points, series }) {
  const max = Math.max(1, ...points.flatMap(p => series.map(s => Number(p[s.key]) || 0)));
  const plotX = x + 10;
  const plotW = width - 12;
  const plotY = y;
  const plotH = height - 8;

  // gridlines + y labels
  doc.setLineWidth(0.2);
  doc.setFontSize(6);
  for (let i = 0; i <= 4; i++) {
    const gy = plotY + plotH - (plotH * i) / 4;
    stroke(doc, LIGHT_GREY);
    doc.line(plotX, gy, plotX + plotW, gy);
    textColor(doc, GREY);
    doc.text(String(Math.round((max * i) / 4)), plotX - 2, gy + 1, { align: 'right' });
  }

  const px = (i) => plotX + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const py = (v) => plotY + plotH - ((Number(v) || 0) / max) * plotH;

  series.forEach(s => {
    stroke(doc, s.color);
    doc.setLineWidth(0.8);
    for (let i = 0; i < points.length - 1; i++) {
      doc.line(px(i), py(points[i][s.key]), px(i + 1), py(points[i + 1][s.key]));
    }
    fill(doc, s.color);
    points.forEach((p, i) => doc.circle(px(i), py(p[s.key]), 1.1, 'F'));
  });

  // x labels
  textColor(doc, GREY);
  doc.setFontSize(6.5);
  points.forEach((p, i) => doc.text(String(p.label), px(i), plotY + plotH + 4, { align: 'center' }));

  return plotY + plotH + 6;
}

// --------------------------------------------------------------- shared legend

export function drawLegend(doc, { x, y, series }) {
  let lx = x;
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'normal');
  series.forEach(s => {
    fill(doc, s.color);
    doc.roundedRect(lx, y - 2.2, 2.6, 2.6, 0.5, 0.5, 'F');
    textColor(doc, GREY);
    doc.text(s.name, lx + 4, y);
    lx += doc.getTextWidth(s.name) + 12;
  });
  return y + 4;
}

export function sectionHeading(doc, text, x, y, accent = PURPLE) {
  fill(doc, accent);
  doc.rect(x, y - 3.6, 1.6, 4.6, 'F');
  textColor(doc, NAVY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(text, x + 4, y);
  return y + 6;
}

export const PDF_COLORS = { NAVY, PURPLE, PURPLE_DARK, GREY, LIGHT_GREY };
