//
// Frames that show the Phase 4 DOGFOOD opportunity's name — and what the
// training deck binds instead of them (ace#2660).
//
// ## Why a deck can show ACE scaffolding
//
// Phase 4's opportunity is ACE's own build/QA vehicle, and its name carries
// the run id by contract: `connect-opp-setup` constructs it as
// `"<run_id> · <PDD display name>"` and `connect_create_opportunity` refuses an
// `is_test: true` name without that prefix (`mcp/connect/opportunity-name.ts`,
// jjackson/ace#755 — the Phase 6 recipes anchor their tile match on it).
// Phase 6 captures its Connect frames against that opportunity, so every frame
// that renders the opportunity's title reads e.g.
// "20261004-1706 · Spark Facilitator — FCAP Community Meeting Facilitation".
// The partner LLO's opportunity (Phase 9, `llo-onboarding`) carries no prefix,
// so a deck that binds those frames shows trainees a name they will never see.
// The render eval flagged exactly that on spark-facilitator/20261004-1706
// (slide 8 `@claim-opp`, slide 9 `@claim-opp-handoff-learn-home`).
//
// ## The rule (decided by the orchestrator, ace#2660)
//
//   1. PREFER a sibling frame of the same screen in which the title is not
//      visible — "the same screen" meaning a frame that matches the slide at
//      least as well as the one it replaces (the binder's own test, see
//      `bindDeckFrames`).
//   2. Otherwise bind a CROP of the frame that starts below the title block,
//      computed deterministically from the frame's pixels (`belowTitleCropTop`).
//      Cropping is the only pixel operation: rows below the cut are copied
//      byte-for-byte (`cropRasterTop`), nothing is painted, blurred or
//      re-lettered, and no frame is fabricated.
//   3. Where neither works — a list of opportunity cards, where every card
//      carries a run-id title, or a certificate that repeats it lower down —
//      the frame is left in place and the binder REPORTS it, so the deck
//      author decides; a crop that still shows a prefix would be a lie.
//
// Which frames render the title is a fixed property of the capture recipe's
// steps (`app-screenshot-capture`), calibrated on the real frames of
// spark-facilitator/20260925-1536 (1080x2400):
//
//   - `claim-opp`, `claim-opp-detail` — the opportunity detail page: the title
//     is the first block under the app bar; the description follows it.
//   - `claim-opp-handoff-learn-home`, `learn-launch-home-tiles` — the Learn
//     app home: a job card holding the title sits directly under the app bar.
//   - `claim-opp-list*`, `claim-opp-new-tile`, `connect-resume-opp-list*`,
//     `connect-resume-opp-tile` — opportunity LISTS: one titled card per
//     opportunity, several of them run-id prefixed. No crop removes them all.
//   - `connect-resume-opp-landed` — the card AND a certificate that repeats
//     the title mid-screen. No top crop removes both.
//

import { zlibSync } from 'fflate';
import type { Raster } from './frame-pixels.js';

/** `"<run_id> · "` — the Phase 4 test-opportunity name prefix (`YYYYMMDD-HHMM`). */
export const RUN_ID_TITLE_PREFIX = /\b\d{8}-\d{4}\s*·/;

/** Steps whose frame renders the opportunity title ONCE, at the top — croppable. */
const TITLE_AT_TOP_STEP = /^(claim-opp|claim-opp-detail|claim-opp-handoff-learn-home|learn-launch-home-tiles)$/;
/** Steps whose frame renders the title more than once, or in a list — not croppable. */
const TITLE_REPEATED_STEP = /^(claim-opp-list.*|claim-opp-new-tile|connect-resume-.*)$/;

export type OppTitleExposure = 'none' | 'top' | 'repeated';

/**
 * Does this frame show the dogfood opportunity's (run-id-prefixed) title, and
 * where? Decided by the recipe step first — the step is what the recipe set out
 * to capture — and by `shows:` second, so a frame of an unlisted step whose
 * description quotes a run-id prefix is still caught (as `repeated`: nobody has
 * calibrated where its title sits, so nobody may crop it).
 */
export function oppTitleExposure(frame: { step: string; shows?: string }): OppTitleExposure {
  if (TITLE_AT_TOP_STEP.test(frame.step)) return 'top';
  if (TITLE_REPEATED_STEP.test(frame.step)) return 'repeated';
  if (RUN_ID_TITLE_PREFIX.test(frame.shows ?? '')) return 'repeated';
  return 'none';
}

export function showsOppTitle(frame: { step: string; shows?: string }): boolean {
  return oppTitleExposure(frame) !== 'none';
}

/** The alias a below-the-title crop of `alias` is cited by. */
export function belowTitleAlias(alias: string): string {
  return `${alias}--below-title`;
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

const TOL = 6;

/**
 * The first row BELOW the title block, or null when the frame does not have
 * the shape this needs (a header, then a block, then a clear gap, all in the
 * top half). Deterministic; reads pixels only.
 *
 *   - background = the most common colour of a thin column at 1% of the width,
 *     between 30% and 60% of the height — the page margin, which neither
 *     cards, tiles nor the scrollbar reach;
 *   - header = the status bar + app bar: the rows from the top until that
 *     column first shows the background;
 *   - title block = the first run of "ink" rows after the header (a row is ink
 *     when >3% of the columns between 2% and 95% of the width differ from the
 *     background — the right edge is skipped because Connect draws a scrollbar
 *     there on the detail page);
 *   - the block ends at the first gap of background rows at least 1.2% of the
 *     frame tall. Lines of one wrapped title are ~0.6% apart, the title and the
 *     description ~1.5%, the job card and the CommCare logo ~2.7% (measured on
 *     spark-facilitator/20260925-1536).
 *
 * The crop starts in the middle of that gap.
 */
export function belowTitleCropTop(r: Raster): number | null {
  const px = (x: number, y: number): [number, number, number] => {
    const k = (y * r.width + x) * 3;
    return [r.rgb[k], r.rgb[k + 1], r.rgb[k + 2]];
  };
  const near = (a: [number, number, number], b: [number, number, number]) =>
    Math.abs(a[0] - b[0]) <= TOL && Math.abs(a[1] - b[1]) <= TOL && Math.abs(a[2] - b[2]) <= TOL;

  const mx = Math.max(0, Math.floor(r.width * 0.01));
  const counts = new Map<string, { n: number; c: [number, number, number] }>();
  for (let y = Math.floor(r.height * 0.3); y < Math.floor(r.height * 0.6); y++) {
    const c = px(mx, y);
    const key = c.join(',');
    const e = counts.get(key) ?? { n: 0, c };
    e.n++;
    counts.set(key, e);
  }
  let bg: [number, number, number] | null = null;
  let best = -1;
  for (const { n, c } of counts.values()) if (n > best) [bg, best] = [c, n];
  if (!bg) return null;

  const x0 = Math.floor(r.width * 0.02);
  const x1 = Math.floor(r.width * 0.95);
  const step = Math.max(1, Math.floor((x1 - x0) / 400));
  const isInk = (y: number) => {
    let diff = 0;
    let n = 0;
    for (let x = x0; x < x1; x += step) {
      n++;
      if (!near(px(x, y), bg!)) diff++;
    }
    return diff > n * 0.03;
  };

  const half = Math.floor(r.height * 0.5);
  let y = 0;
  while (y < half && !near(px(mx, y), bg)) y++; // header
  while (y < half && !isInk(y)) y++; // margin above the block
  if (y >= half) return null;
  const gapNeed = Math.ceil(r.height * 0.012);
  let gap = 0;
  for (; y < half; y++) {
    if (isInk(y)) {
      gap = 0;
      continue;
    }
    gap++;
    if (gap >= gapNeed) {
      // walk to the end of the gap, cut in its middle
      const start = y - gap + 1;
      let end = y;
      while (end + 1 < r.height && !isInk(end + 1)) end++;
      return Math.floor((start + end + 1) / 2);
    }
  }
  return null;
}

/** Rows `top..height-1` of `r`, copied unchanged. */
export function cropRasterTop(r: Raster, top: number): Raster {
  if (!Number.isInteger(top) || top < 0 || top >= r.height) throw new Error(`cropRasterTop: bad top ${top}`);
  const height = r.height - top;
  return { width: r.width, height, rgb: r.rgb.slice(top * r.width * 3) };
}

// CRC32 for PNG chunks.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode an RGB raster as an 8-bit truecolour PNG (lossless; filter 0). */
export function encodePng(r: Raster): Uint8Array {
  const stride = r.width * 3;
  const raw = new Uint8Array(r.height * (stride + 1));
  for (let y = 0; y < r.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(r.rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, r.width);
  dv.setUint32(4, r.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}
