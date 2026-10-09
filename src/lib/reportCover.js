// Builds the Monthly Report cover from the supplied SVG template.
//
// The template is edited in-memory before rendering: the month / generated-date
// text nodes are replaced with live values, and the placeholder logo group (which
// approximates the letters with plain rectangles) is swapped for the real
// logo.png embedded as a data URI. jsPDF can't place SVG directly, so the result
// is rasterised to a high-resolution PNG and stamped onto the page.
// The default import resolves to the asset's URL in dev and to the hashed URL
// in a production build, so fetching it works in both.
import coverUrl from '../assets/report-cover.svg';

// Portrait canvas matching A4's 1:1.414 ratio, so the cover fills exactly the
// same page size as every other page — no letterboxing, no cropping.
export const COVER_W = 1536;
export const COVER_H = 2172;

let templateCache = null;

export async function loadCoverTemplate() {
  if (templateCache) return templateCache;
  const res = await fetch(coverUrl);
  if (!res.ok) throw new Error(`could not load cover template (${res.status})`);
  templateCache = await res.text();
  return templateCache;
}

// Where the real logo is placed, right-aligned so it keeps the template's
// top-right position regardless of the source image's aspect ratio.
const LOGO_BOX = { x: 1232, y: 55, width: 200, height: 160 };

function loadImage(src, { crossOrigin } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load image: ${src}`));
    img.src = src;
  });
}

// Read a same-origin image into a data URI so it survives SVG rasterisation
// (external references inside an SVG being drawn to canvas are not fetched).
export async function toDataUrl(src) {
  const img = await loadImage(src, { crossOrigin: 'anonymous' });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || 192;
  canvas.height = img.naturalHeight || 192;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}

export function buildCoverSvg(template, { periodLabel, generatedLabel, logoDataUrl }) {
  const doc = new DOMParser().parseFromString(template, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('cover template is not valid SVG');

  const setText = (id, value) => {
    const node = doc.getElementById(id);
    if (node && value != null) node.textContent = value;
  };
  setText('report-month', periodLabel);
  setText('generated-date', generatedLabel);

  // Replace the rectangle-based placeholder with the real mark
  const placeholder = doc.getElementById('ife-logo');
  if (placeholder && logoDataUrl) {
    const image = doc.createElementNS('http://www.w3.org/2000/svg', 'image');
    image.setAttribute('id', 'ife-logo');
    image.setAttribute('x', String(LOGO_BOX.x));
    image.setAttribute('y', String(LOGO_BOX.y));
    image.setAttribute('width', String(LOGO_BOX.width));
    image.setAttribute('height', String(LOGO_BOX.height));
    image.setAttribute('preserveAspectRatio', 'xMaxYMid meet');
    image.setAttribute('href', logoDataUrl);
    // xlink:href keeps older renderers happy
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', logoDataUrl);
    placeholder.replaceWith(image);
  }

  return new XMLSerializer().serializeToString(doc);
}

// Rasterise the finished SVG. scale 1.5 => 2304x3258, roughly 280 dpi across a
// 210mm-wide page, which stays sharp in print without bloating the file.
export async function rasterizeSvg(svgString, scale = 1.5) {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(COVER_W * scale);
  canvas.height = Math.round(COVER_H * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export async function buildCoverImage({ periodLabel, generatedLabel, logoSrc = '/logo.png', scale = 1.5 }) {
  let logoDataUrl = null;
  try {
    logoDataUrl = await toDataUrl(logoSrc);
  } catch {
    // Fall back to the template's own logo artwork rather than failing the export
  }
  const template = await loadCoverTemplate();
  const svg = buildCoverSvg(template, { periodLabel, generatedLabel, logoDataUrl });
  return { dataUrl: await rasterizeSvg(svg, scale), usedRealLogo: Boolean(logoDataUrl) };
}

// The template canvas is 1536x2172 (1:1.4141) and A4 portrait is 210x297
// (1:1.4143) — a 0.02% difference — so the cover is simply drawn edge to edge.
export function stampCover(doc, dataUrl) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  doc.addImage(dataUrl, 'PNG', 0, 0, pageW, pageH, undefined, 'FAST');
  return { pageW, pageH };
}
