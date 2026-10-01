//
// What is ON a captured phone frame — measured from its pixels.
//
// `app-screenshot-capture` records which file a frame is (`file_id`, `md5`,
// `duplicate_of`) and, for the frames somebody opened, a one-line `shows:`.
// On `spark-facilitator/20260925-1536` that is 31 `shows:` lines over 114
// frames. The other 83 say nothing about what is in the picture, and a deck
// that picks one of them is guessing.
//
// The training-deck render eval scored exactly those guesses down
// (spark-facilitator/20260926-1800, 4.66 fail):
//
//   - slide 10 — "an almost empty blue 'Downloading Learn App' screen";
//   - slides 6 and 32 — a soft keyboard covering half the frame, "shrinking the
//     payment note it is meant to show".
//
// Both are decidable from pixels, deterministically, before anyone renders a
// deck. This module decodes the PNG (no native dependency — `fflate` is
// already a dependency and inflates the IDAT stream) and reports two numbers:
//
//   - `inkRowFraction` — the share of the screen's rows that carry anything
//     other than the screen's own background colour. A loading screen is a
//     flat field with one icon and one line of text; it measures ~0.2. A real
//     form screen measures 0.3–0.95.
//   - `keyboardFraction` — the height of a bottom-anchored soft-keyboard band,
//     as a share of the frame. A keyboard is the one UI element made of rows
//     of equal-width KEYS separated by gutters of a single surface colour;
//     text, tile grids and lists are not.
//
// The thresholds are calibrated on the committed real frames under
// `test/fixtures/training-deck/spark-20260926-1800/frames/` and pinned by
// `test/lib/frame-pixels.test.ts`, positives and negatives both.
//

import { unzlibSync } from 'fflate';

export interface Raster {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel, row-major. Alpha is composited onto white. */
  rgb: Uint8Array;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Decode an 8-bit, non-interlaced PNG (every colour type). That covers what
 * Android's `screencap` writes (RGBA) and what `sips` writes when it scales a
 * frame (RGB or palette). Anything else throws rather than guessing.
 */
export function decodePng(bytes: Uint8Array): Raster {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('decodePng: not a PNG');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`decodePng: bit depth ${bitDepth} unsupported (8 only)`);
  if (interlace !== 0) throw new Error('decodePng: interlaced PNG unsupported');
  const bpp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!bpp) throw new Error(`decodePng: colour type ${colorType} unsupported`);
  if (colorType === 3 && !palette) throw new Error('decodePng: palette image without PLTE');

  const total = idat.reduce((n, c) => n + c.length, 0);
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  const raw = unzlibSync(z);
  const stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = v & 0xff;
    }
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    let r: number;
    let g: number;
    let b: number;
    let alpha = 255;
    if (colorType === 0 || colorType === 4) {
      r = g = b = px[i * bpp];
      if (colorType === 4) alpha = px[i * bpp + 1];
    } else if (colorType === 3) {
      const idx = px[i];
      r = palette![idx * 3];
      g = palette![idx * 3 + 1];
      b = palette![idx * 3 + 2];
      if (trns && idx < trns.length) alpha = trns[idx];
    } else {
      r = px[i * bpp];
      g = px[i * bpp + 1];
      b = px[i * bpp + 2];
      if (colorType === 6) alpha = px[i * bpp + 3];
    }
    if (alpha < 255) {
      // Composite onto white — how Slides draws a transparent region.
      r = Math.round((r * alpha + 255 * (255 - alpha)) / 255);
      g = Math.round((g * alpha + 255 * (255 - alpha)) / 255);
      b = Math.round((b * alpha + 255 * (255 - alpha)) / 255);
    }
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { width, height, rgb };
}

export interface FrameStats {
  width: number;
  height: number;
  /** Share of content rows carrying anything but the screen background. */
  inkRowFraction: number;
  /** Height of a bottom-anchored soft-keyboard band / frame height (0 = none). */
  keyboardFraction: number;
}

/** A frame below this ink share is a loading / splash / blank screen. */
export const NEAR_EMPTY_INK = 0.25;
/** A keyboard band at least this tall covers the screen a slide is about. */
export const KEYBOARD_COVERS = 0.25;

/**
 * Rows and columns are SAMPLED on a fixed 270x600 grid whatever the frame's
 * resolution, so a full-size capture and the scaled fixture of the same frame
 * measure the same — the thresholds above must not depend on which one a
 * caller happened to download.
 */
const GRID_W = 270;
const GRID_H = 600;

function sampler(r: Raster) {
  const xs = Array.from({ length: GRID_W }, (_, i) => Math.min(r.width - 1, Math.floor(((i + 0.5) * r.width) / GRID_W)));
  const ys = Array.from({ length: GRID_H }, (_, i) => Math.min(r.height - 1, Math.floor(((i + 0.5) * r.height) / GRID_H)));
  const at = (gx: number, gy: number): [number, number, number] => {
    const k = (ys[gy] * r.width + xs[gx]) * 3;
    return [r.rgb[k], r.rgb[k + 1], r.rgb[k + 2]];
  };
  return at;
}

const quant = (c: [number, number, number]) => ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
const near = (a: [number, number, number], b: [number, number, number], tol = 8) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

export function measureFrame(r: Raster): FrameStats {
  const at = sampler(r);
  // Ignore the status bar and the gesture/nav bar: present on every frame,
  // they would lend a blank screen two rows of "ink".
  const top = Math.floor(GRID_H * 0.03);
  const bot = Math.floor(GRID_H * 0.97);

  const counts = new Map<number, number>();
  for (let y = top; y < bot; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const q = quant(at(x, y));
      counts.set(q, (counts.get(q) ?? 0) + 1);
    }
  }
  let bg = -1;
  let best = -1;
  for (const [q, n] of counts) if (n > best) [bg, best] = [q, n];

  let ink = 0;
  for (let y = top; y < bot; y++) {
    let diff = 0;
    for (let x = 0; x < GRID_W; x++) if (quant(at(x, y)) !== bg) diff++;
    if (diff > GRID_W * 0.01) ink++;
  }

  return {
    width: r.width,
    height: r.height,
    inkRowFraction: ink / (bot - top),
    keyboardFraction: keyboardBand(at),
  };
}

/**
 * A soft keyboard, bottom-anchored. Its signature is structural, not a colour:
 * a "key row" is a sampled row holding at least three FLAT-FILLED runs of
 * non-surface pixels each 4–30% of the width (letter keys ~9%, a numeric
 * pad's ~25%), and a keyboard is three or more SEPARATE groups of key rows
 * (the board's rows, split by gutters of the surface colour) reaching down to
 * the bottom of the frame — with either one row of at least seven keys (a
 * letter board: QWERTY's top row has ten) or keys covering most of the width
 * (a numeric pad).
 *
 * Text lines are glyph-width runs, and tile grids two runs per row, so neither
 * reads as keys. The last clause is the one a list of cards needs: Connect's
 * opportunity list (`claim-opp-list`) stacks four cards, each with a row of
 * two pill buttons and a progress ring — three flat runs per row, four times
 * over, bottom-anchored, and nothing like a keyboard.
 */
function keyboardBand(at: (x: number, y: number) => [number, number, number]): number {
  // The keyboard surface colour: what the bottom of the frame is painted.
  const surfaceCounts = new Map<number, { n: number; c: [number, number, number] }>();
  for (let y = Math.floor(GRID_H * 0.955); y < Math.floor(GRID_H * 0.975); y++) {
    for (let x = 0; x < GRID_W; x++) {
      const c = at(x, y);
      const q = quant(c);
      const e = surfaceCounts.get(q) ?? { n: 0, c };
      e.n++;
      surfaceCounts.set(q, e);
    }
  }
  let surface: [number, number, number] = [255, 255, 255];
  let bestN = -1;
  for (const { n, c } of surfaceCounts.values()) if (n > bestN) [surface, bestN] = [c, n];

  // A key is a FLAT FILL: most of a run's pixels share one colour (the key
  // cap), with a glyph in the middle. A word of text is a run too once the
  // frame is scaled — but it is ink and background interleaved, so no single
  // colour holds it.
  /** Number of key-like runs in row `y`, and how much of the width they cover. */
  const keyRuns = (y: number): { runs: number; cover: number } => {
    let runs = 0;
    let cover = 0;
    let start = 0;
    for (let x = 0; x <= GRID_W; x++) {
      const off = x === GRID_W || near(at(x, y), surface);
      if (!off) continue;
      const len = x - start;
      if (len >= GRID_W * 0.04 && len <= GRID_W * 0.3) {
        const fill = new Map<number, number>();
        let top = 0;
        for (let k = start; k < x; k++) {
          const q = quant(at(k, y));
          const n = (fill.get(q) ?? 0) + 1;
          fill.set(q, n);
          if (n > top) top = n;
        }
        if (top / len >= 0.6) {
          runs++;
          cover += len;
        }
      }
      start = x + 1;
    }
    return { runs, cover: cover / GRID_W };
  };

  // Walk up from just above the gesture bar, collecting key-row groups, and
  // stop at the first long stretch of rows that are neither keys nor gutter.
  let groups = 0;
  let inGroup = false;
  let topOfBand = -1;
  let foreign = 0;
  let widest = 0;
  let maxCover = 0;
  for (let y = Math.floor(GRID_H * 0.97); y >= Math.floor(GRID_H * 0.35); y--) {
    const k = keyRuns(y);
    if (k.runs >= 3) {
      widest = Math.max(widest, k.runs);
      maxCover = Math.max(maxCover, k.cover);
      if (!inGroup) groups++;
      inGroup = true;
      topOfBand = y;
      foreign = 0;
      continue;
    }
    inGroup = false;
    let surfaceShare = 0;
    for (let x = 0; x < GRID_W; x++) if (near(at(x, y), surface)) surfaceShare++;
    if (surfaceShare / GRID_W < 0.6) {
      // Not a gutter either. Tolerate a short stretch (the suggestion strip,
      // the toolbar icons), then call the band finished.
      if (++foreign > GRID_H * 0.04) break;
    }
  }
  if (groups < 3 || topOfBand < 0) return 0;
  if (widest < 7 && maxCover < 0.75) return 0;
  return (GRID_H * 0.97 - topOfBand) / GRID_H;
}
