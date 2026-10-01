//
// Structural pre-checks over a RENDERED Google Slides deck — the deterministic
// half of `training-deck-render-eval`.
//
// `training-deck-generate-eval` grades the SPEC; `training-deck-render`'s
// self-eval counts slides and image calls. Nothing looked at what the render
// actually produced. Some of what goes wrong there is visible in the Slides
// API's page model without looking at a single pixel — an empty slide, a
// leftover `{{token}}` or template prompt, an element hanging off the page, a
// text box asked to hold far more text than fits. This module finds those, so
// the judge's LOOK starts from a list of suspects and every slide it judges
// carries its structural facts. It does not replace the look: overflow in
// particular is a HEURISTIC here ("suspected"), confirmed or dismissed on the
// thumbnail.
//
// Pure, over `slides.presentations.get` JSON.

export type SlideFindingKind = 'empty-slide' | 'placeholder-text' | 'off-page-element' | 'suspected-text-overflow' | 'no-image-on-image-slide';

export interface SlideFinding {
  kind: SlideFindingKind;
  detail: string;
}

export interface SlideReport {
  index: number; // 1-based
  objectId: string;
  /** The slide's visible text, whitespace-collapsed (for the judge's page_text). */
  text: string;
  images: number;
  findings: SlideFinding[];
}

interface Dim { magnitude?: number | null; unit?: string | null }
interface Transform { scaleX?: number | null; scaleY?: number | null; translateX?: number | null; translateY?: number | null; unit?: string | null }
interface TextRun { content?: string | null; style?: { fontSize?: Dim | null } | null }
interface PageElement {
  objectId?: string | null;
  size?: { width?: Dim | null; height?: Dim | null } | null;
  transform?: Transform | null;
  shape?: { text?: { textElements?: Array<{ textRun?: TextRun | null }> | null } | null; placeholder?: unknown } | null;
  image?: unknown;
  table?: unknown;
  elementGroup?: { children?: PageElement[] | null } | null;
}
export interface PresentationJson {
  pageSize?: { width?: Dim | null; height?: Dim | null } | null;
  slides?: Array<{ objectId?: string | null; pageElements?: PageElement[] | null }> | null;
}

/** Tokens a finished slide must never show. */
const PLACEHOLDER = /\{\{[^}]*\}\}|\bclick to add\b|\blorem ipsum\b|\bTODO\b|\bTBD\b|\[(?:insert|placeholder|screenshot)[^\]]*\]/i;

const EMU_PER_PT = 12_700;

function emu(d: Dim | null | undefined): number {
  const m = d?.magnitude ?? 0;
  return d?.unit === 'PT' ? m * EMU_PER_PT : m;
}

function flatten(els: PageElement[] | null | undefined): PageElement[] {
  const out: PageElement[] = [];
  for (const e of els ?? []) {
    out.push(e);
    if (e.elementGroup?.children) out.push(...flatten(e.elementGroup.children));
  }
  return out;
}

/** Rendered box of an element in EMU: [x, y, w, h]. */
function box(e: PageElement): [number, number, number, number] {
  const t = e.transform ?? {};
  const k = t.unit === 'PT' ? EMU_PER_PT : 1;
  const w = emu(e.size?.width) * (t.scaleX ?? 1);
  const h = emu(e.size?.height) * (t.scaleY ?? 1);
  return [(t.translateX ?? 0) * k, (t.translateY ?? 0) * k, w, h];
}

function textOf(e: PageElement): { text: string; maxPt: number | null } {
  let text = '';
  let maxPt: number | null = null;
  for (const te of e.shape?.text?.textElements ?? []) {
    const run = te.textRun;
    if (!run?.content) continue;
    text += run.content;
    const pt = run.style?.fontSize?.magnitude;
    if (typeof pt === 'number') maxPt = Math.max(maxPt ?? 0, pt);
  }
  return { text, maxPt };
}

/**
 * Wrap estimate: paragraphs wrapped at ~0.52·pt per character across the box's
 * inner width (a word longer than a line — a raw URL — breaks across lines),
 * each line 1.2·pt tall. Flags only when that exceeds the box height, and only
 * for an explicit font size — an inherited size is unknown here, and unknown
 * is not a finding. It UNDER-reports: paragraph spacing is not modelled, so a
 * box can overflow on screen while passing here (spark-facilitator/20260926-1800
 * slide 53 did). The look is authoritative; this only nominates suspects.
 */
export function estimateTextHeightPt(text: string, pt: number, boxWidthPt: number): number {
  const cpl = Math.max(1, Math.floor((boxWidthPt - 14) / (0.52 * pt)));
  let lines = 0;
  for (const para of text.replace(/\n+$/, '').split('\n')) {
    let n = 1;
    let cur = 0;
    for (const word of para.split(' ')) {
      let len = word.length;
      while (len > cpl) {
        n += 1;
        len -= cpl;
      }
      if (cur && cur + 1 + len > cpl) {
        n += 1;
        cur = len;
      } else cur = cur + (cur ? 1 : 0) + len;
    }
    lines += n;
  }
  return lines * pt * 1.2 + 14;
}

function overflowSuspected(text: string, pt: number, wEmu: number, hEmu: number): boolean {
  if (text.trim().length < 40 || wEmu <= 0 || hEmu <= 0) return false;
  return estimateTextHeightPt(text, pt, wEmu / EMU_PER_PT) > hEmu / EMU_PER_PT;
}

export function checkRenderedDeck(p: PresentationJson, opts: { imageSlideIndices?: ReadonlySet<number> } = {}): SlideReport[] {
  const W = emu(p.pageSize?.width) || 9_144_000;
  const H = emu(p.pageSize?.height) || 5_143_500;
  const tol = 0.02;
  return (p.slides ?? []).map((slide, i) => {
    const els = flatten(slide.pageElements);
    const findings: SlideFinding[] = [];
    let text = '';
    let images = 0;
    for (const e of els) {
      if (e.image) images += 1;
      const { text: t, maxPt } = textOf(e);
      text += ` ${t}`;
      const [x, y, w, h] = box(e);
      if ((e.image || t.trim()) && (x < -W * tol || y < -H * tol || x + w > W * (1 + tol) || y + h > H * (1 + tol))) {
        findings.push({ kind: 'off-page-element', detail: `${e.image ? 'image' : 'text box'} ${e.objectId ?? '?'} extends past the slide edge` });
      }
      const m = PLACEHOLDER.exec(t);
      if (m) findings.push({ kind: 'placeholder-text', detail: `unfilled placeholder "${m[0]}"` });
      if (maxPt && overflowSuspected(t, maxPt, w, h)) {
        findings.push({ kind: 'suspected-text-overflow', detail: `${t.trim().length} chars at ${maxPt}pt in a ${Math.round(w / EMU_PER_PT)}×${Math.round(h / EMU_PER_PT)}pt box — confirm on the thumbnail` });
      }
    }
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (!collapsed && images === 0 && !els.some((e) => e.table)) findings.push({ kind: 'empty-slide', detail: 'no text, image or table on the slide' });
    if (opts.imageSlideIndices?.has(i + 1) && images === 0) findings.push({ kind: 'no-image-on-image-slide', detail: 'the spec puts a screenshot here but the slide has no image' });
    return { index: i + 1, objectId: slide.objectId ?? '', text: collapsed, images, findings };
  });
}

/**
 * Which slides the judge must look at: every slide when the deck is small,
 * else every flagged slide plus a sample spread evenly across the rest, so the
 * look never covers only the population that cannot fail (ace#856).
 */
export function slidesToJudge(reports: readonly SlideReport[], maxUnflagged = 16): number[] {
  if (reports.length <= 25) return reports.map((r) => r.index);
  const flagged = reports.filter((r) => r.findings.length).map((r) => r.index);
  const rest = reports.filter((r) => !r.findings.length);
  const step = Math.max(1, rest.length / maxUnflagged);
  const sample: number[] = [];
  for (let k = 0; k < rest.length && sample.length < maxUnflagged; k += step) sample.push(rest[Math.floor(k)].index);
  return [...new Set([...flagged, ...sample])].sort((a, b) => a - b);
}
