/* =============================================================================
   liquid-glass.js — SVG displacement "liquid glass" for Piratify's frosted surfaces.

   How it works
   ------------
   An SVG filter is applied through `backdrop-filter: url(#id)`. Inside that
   filter a *displacement map* image (generated here, on a canvas, per element)
   tells `feDisplacementMap` how to bend the pixels behind the glass. Each pixel
   of the map encodes a direction in its red (x) and green (y) channels, with 128
   meaning "no displacement" — the same scheme Apple-style liquid glass demos use.

   The map only has non-neutral values in a "bezel" band around the element's rim,
   so the middle of a panel stays flat and undistorted while the edges refract.

   Honest limitations
   ------------------
   * `backdrop-filter: url(#svgFilter)` is **Chromium-only**. WebKit reports
     support but does not apply SVG filters to the backdrop (WebKit bug 245510),
     and Gecko doesn't either. So this is a progressive enhancement: every glass
     surface keeps its plain `blur() saturate()` recipe as the base, and only
     Chromium gets the refraction layered on top. Safari and Firefox still look
     correct, just without the edge bending.
   * The refraction profile below is a tuned approximation, not a physical
     Snell's-law solver. It is chosen to read correctly on rounded rectangles.
   * Displacement maps are rasterised on a canvas and capped in resolution, and
     `backdrop-filter: url()` re-renders on scroll — so this stays opt-in per
     element and is disabled for reduced-motion / low-power hints.
   * Chromatic dispersion (below) costs a second displacement pass. That is the
     most expensive thing in this file and it is why the effect stays
     desktop-only and why the spread is a few percent rather than a lens' worth.
   ============================================================================= */

const BEZEL_RATIO = 0.30;   // bezel depth as a fraction of the shorter side
const BEZEL_MIN = 8;        // px floor so tiny chips still refract
const BEZEL_MAX = 46;       // px ceiling so big panels don't warp absurdly
const MAX_MAP_PX = 240;     // cap on the rasterised map's longest side
const STRENGTH = 26;        // peak feDisplacementMap scale, in px, on a big panel
const STRENGTH_MIN = 6;     // px floor: below this the refraction is invisible
const STRENGTH_RATIO = 0.6; // displacement as a fraction of the bezel's own depth
const BLUR_MIN = 2.6;       // px — small chips, which the blur must not soften away
const BLUR_MAX = 13;        // px — the depth a large panel can carry
const BLUR_DIVISOR = 24;    // blur radius = shorter side / this, clamped
const CHROMA = 0.13;        // rim dispersion: how far the two passes differ
const GLASS_SATURATE = 1.9;

/* Chromium-only gate. Feature detection alone is not enough: WebKit claims
   support for `url()` in backdrop-filter and then paints nothing. */
/* Per-element SVG displacement filters are the most expensive thing this file
   can put on screen: the backdrop is re-filtered every frame the element moves
   or the page scrolls under it. On a phone that is exactly where animations
   stopped feeling smooth, so the effect is desktop-only and mobile keeps the
   plain blur(), which composites far better. */
const WIDE = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
  ? window.matchMedia('(min-width: 900px)').matches
  : true;

const SUPPORTED = (() => {
  if (!WIDE()) return false;
  if (typeof CSS === 'undefined' || !CSS.supports) return false;
  if (!CSS.supports('backdrop-filter', 'url("#lg-probe")')) return false;
  const ua = navigator.userAgent || '';
  if (/Firefox|FxiOS|CriOS/i.test(ua)) return false;            // Gecko, and iOS Chrome (WebKit)
  if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg\//i.test(ua)) return false; // WebKit Safari
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return /Chrome|Chromium|Edg\//i.test(ua);
})();

/* How deep the refracting band is, for one element. */
function bezelFor(w, h) {
  return Math.max(BEZEL_MIN, Math.min(BEZEL_MAX, Math.min(w, h) * BEZEL_RATIO));
}

/* Displacement and frost both scale with the element.

   One pair of values for everything is what made the small elements look wrong:
   a 26px bend and a 2.2px blur were tuned on panels, and applied to 28px icon
   buttons they turned a chip into a puddle — the whole control sat inside its own
   bezel, so its entire backdrop was pulled inward. Scaling instead keeps the
   material feeling the same at every size: a chip refracts a few pixels, a panel
   bends as much as it ever did, and the frost is deep enough to read as glass
   rather than as a haze only because big surfaces can afford a wide blur. */
function strengthFor(w, h) {
  return Math.max(STRENGTH_MIN, Math.min(STRENGTH, bezelFor(w, h) * STRENGTH_RATIO));
}
function blurFor(w, h) {
  return Math.max(BLUR_MIN, Math.min(BLUR_MAX, Math.min(w, h) / BLUR_DIVISOR));
}

/* Refraction magnitude along the bezel.
   u = 0 at the outer rim, 1 at the inner end of the bezel. Zero at both ends so
   the silhouette stays crisp and the flat centre stays untroubled, peaking just
   inside the rim where a real glass edge bends light hardest. */
const PEAK = 0.28;
function refractionProfile(u) {
  if (u <= 0 || u >= 1) return 0;
  return u < PEAK
    ? Math.pow(u / PEAK, 1.6)
    : Math.pow(1 - (u - PEAK) / (1 - PEAK), 1.9);
}

/* Signed distance to a rounded rectangle: negative inside, 0 on the edge. */
function sdRoundRect(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r);
  const qy = Math.abs(py - h / 2) - (h / 2 - r);
  const dx = Math.max(qx, 0);
  const dy = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(dx, dy) - r;
}

/* Rasterise a displacement map for one element. Returns a PNG data URL. */
function buildDisplacementMap(w, h, radius, bezel) {
  const scale = Math.min(1, MAX_MAP_PX / Math.max(w, h));
  const mw = Math.max(8, Math.round(w * scale));
  const mh = Math.max(8, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(mw, mh);
  const data = image.data;

  const r = Math.min(radius, Math.min(mw, mh) / 2);
  const step = 1; // sample spacing in map pixels for the numeric gradient

  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const i = (y * mw + x) * 4;
      const px = x / scale;
      const py = y / scale;

      const sd = sdRoundRect(px, py, w, h, radius);
      const inside = -sd; // distance inside the shape

      // Neutral = no displacement.
      let rr = 128, gg = 128;
      if (inside > 0 && inside < bezel) {
        const u = inside / bezel;
        const mag = refractionProfile(u);

        // Numeric gradient of the distance field gives the outward normal.
        const gx = sdRoundRect(px + step, py, w, h, radius) - sdRoundRect(px - step, py, w, h, radius);
        const gy = sdRoundRect(px, py + step, w, h, radius) - sdRoundRect(px, py - step, w, h, radius);
        const len = Math.hypot(gx, gy) || 1;
        // Inward normal: pull the backdrop toward the middle, like a lens rim.
        const nx = -gx / len;
        const ny = -gy / len;

        rr = 128 + nx * mag * 127;
        gg = 128 + ny * mag * 127;
      }

      data[i] = Math.max(0, Math.min(255, rr));
      data[i + 1] = Math.max(0, Math.min(255, gg));
      data[i + 2] = 128; // blue is ignored by feDisplacementMap
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  // Note: the radius is applied in map space above; `r` is kept for clarity.
  void r;
  return canvas.toDataURL('image/png');
}

/* The filter, in three parts: frost, bend, and a rim that disperses.

   The dispersion is what separates glass from a blurred rectangle. Light really
   does bend by wavelength, and the fringing it leaves on a thick edge is the
   single strongest cue that what you are looking at has thickness. It is two
   displacement passes instead of one — the backdrop is bent once at `scale` and
   once at `scale * (1 + CHROMA)`, then the two are recombined: red and green from
   the stronger bend, blue from the weaker, so one side of the rim runs warm and
   the other cool.

   `feBlend mode="lighten"` is exact here rather than approximate, which is why
   it is used instead of the arithmetic sum. The two passes carry disjoint
   channels (one holds R and G, the other only B), so a per-channel maximum is a
   sum; and where the map is neutral — the whole middle of every element — the two
   passes are the same image, so the maximum is that image. No blurred centre, no
   brightened middle, no seam. */
function filterMarkup(id, mapUrl, w, h, { blur, scale }) {
  const frontScale = scale * (1 + CHROMA);
  return `<filter id="${id}" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feImage href="${mapUrl}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
      <feColorMatrix in="SourceGraphic" type="saturate" values="${GLASS_SATURATE}" result="rich"/>
      <feGaussianBlur in="rich" stdDeviation="${blur.toFixed(2)}" result="soft"/>
      <feDisplacementMap in="soft" in2="map" scale="${frontScale.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="bentFront"/>
      <feDisplacementMap in="soft" in2="map" scale="${scale.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="bentBack"/>
      <feColorMatrix in="bentFront" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1" result="warm"/>
      <feColorMatrix in="bentBack" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 1" result="cool"/>
      <feBlend in="warm" in2="cool" mode="lighten" result="bent"/>
      <feComposite in="bent" in2="SourceGraphic" operator="in"/>
    </filter>`;
}

let host = null;
let seq = 0;
const applied = new WeakMap(); // element -> { id, w, h, radius }
const observed = new Set();

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('class', 'lg-defs');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('focusable', 'false');
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  document.body.appendChild(host);
  return host;
}

function cornerRadius(el) {
  const cs = getComputedStyle(el);
  const raw = cs.borderTopLeftRadius || '0';
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* Apply (or re-apply) the effect to one element. */
function applyTo(el) {
  if (!SUPPORTED) return;

  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w < 12 || h < 12) return;

  const radius = cornerRadius(el);
  const prev = applied.get(el);
  if (prev && prev.w === w && prev.h === h && prev.radius === radius) return;

  const id = prev ? prev.id : `lg-${++seq}`;
  const bezel = bezelFor(w, h);
  const mapUrl = buildDisplacementMap(w, h, radius, bezel);
  const optics = { blur: blurFor(w, h), scale: strengthFor(w, h) };

  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const svg = ensureHost();
  svg.insertAdjacentHTML('beforeend', filterMarkup(id, mapUrl, w, h, optics));

  el.style.backdropFilter = `url(#${id})`;
  el.style.webkitBackdropFilter = `url(#${id})`;
  el.classList.add('lg-active');

  applied.set(el, { id, w, h, radius });
}

function refresh() {
  document.querySelectorAll('[data-lg-glass]').forEach(applyTo);
}

/* Public API — call `refreshLiquidGlass()` after the DOM changes shape. */
window.refreshLiquidGlass = refresh;

function init() {
  if (!SUPPORTED) return refresh; // no-op, plain glass stays in place
  refresh();

  // Re-rasterise when an element actually changes size (map is size-specific).
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(entries => {
      entries.forEach(entry => {
        if (observed.has(entry.target)) applyTo(entry.target);
      });
    });
    document.querySelectorAll('[data-lg-glass]').forEach(el => {
      observed.add(el);
      ro.observe(el);
    });
  }

  // Panels that appear later (the action sheet) still get treated.
  document.addEventListener('click', () => {
    document.querySelectorAll('[data-lg-glass]').forEach(el => {
      if (!applied.has(el)) applyTo(el);
    });
  });
  return refresh;
}

export const liquidGlassSupported = SUPPORTED;
export { refresh as refreshLiquidGlass };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
