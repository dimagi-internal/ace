/**
 * Builder/template GEOMETRY + COLOUR drift scanner for the stencil deck.
 *
 * ## The gap this closes (ace#2204)
 *
 * `lib/training-deck-stencil-geometry.ts` is the single source of stencil
 * geometry, but its builders run ONLY when the template is minted
 * (`scripts/bootstrap-training-deck-template.ts`). The render path copies
 * `ACE_TRAINING_DECK_TEMPLATE_ID` and `replaceAllText`s into whatever boxes
 * that copy already has. So a merged geometry fix reaches no rendered deck
 * until someone re-mints, and nothing reports the gap.
 *
 * That is how ace#1305 got reopened: the `two_column` fix landed 2026-08-14
 * and every deck rendered in the next three weeks shipped the defect with every
 * render check green (24/24 slides, zero unmatched replacements, visual
 * coverage 1.0). Measured against the live template:
 *
 *   live    ace_stencil_two_column_rhead  y=1300000  colour navy
 *   builder buildTwoColumnTextBoxes       y=1642275  colour COLOR_WHITE
 *
 * `lib/stencil-token-drift.ts` compares `{{TOKEN}}`s only, so it is blind to
 * this: both sides carry `{{RIGHT_HEADING}}`.
 *
 * ## What it compares
 *
 * For each stencil, the builder's own requests (`STENCIL_TEXT_BUILDERS[key]
 * (pageId)`) are read as the EXPECTED page: every `createShape` gives an
 * objectId + bounds, its `updateTextStyle` gives a text colour + font size, and
 * a `shapeBackgroundFill` gives a fill colour. The live page's elements are
 * matched by objectId (the mint creates them with exactly these ids, and a
 * Drive copy preserves them), and bounds are normalised through
 * `elementBounds` so a flipped transform does not read as drift.
 *
 * Only builder-owned objects are compared. Chrome, images and anything an
 * operator added are not the builder's and are left alone. That is the line
 * between drift and a legitimate hand-edit of the template: the builder's own
 * boxes moving or changing colour IS drift, because the next mint or `--repair`
 * would undo it anyway.
 *
 * Pure: the Slides round-trip lives in `scripts/check-stencil-token-drift.ts`.
 * Report-only: geometry drift is a WARN, never a render gate.
 */

import { elementBounds, type PageElementLike } from './training-deck-stencil-geometry.js';

type Rgb = { red?: number; green?: number; blue?: number };

/** What the builder says one of its objects looks like. */
export interface ExpectedObject {
  objectId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  textColor?: Rgb;
  fillColor?: Rgb;
  fontSize?: number;
}

/** A live Slides page element, as `presentations.get` returns it. */
export interface LiveElement extends PageElementLike {
  shape?: {
    shapeType?: string | null;
    text?: {
      textElements?: Array<{
        textRun?: {
          content?: string | null;
          style?: {
            fontSize?: { magnitude?: number | null } | null;
            foregroundColor?: {
              opaqueColor?: { rgbColor?: Rgb | null; themeColor?: string | null } | null;
            } | null;
          } | null;
        } | null;
      }> | null;
    } | null;
    shapeProperties?: {
      shapeBackgroundFill?: {
        solidFill?: { color?: { rgbColor?: Rgb | null; themeColor?: string | null } | null } | null;
      } | null;
    } | null;
  } | null;
}

export interface StencilPageElements {
  pageId: string;
  elements: readonly LiveElement[];
}

export type GeometryDriftKind = 'missing' | 'bounds' | 'text-colour' | 'fill-colour' | 'font-size';

export interface GeometryDriftDifference {
  objectId: string;
  kind: GeometryDriftKind;
  expected: string;
  actual: string;
}

export interface StencilGeometryDriftFinding {
  stencil: string;
  pageId: string;
  differences: GeometryDriftDifference[];
}

export interface StencilGeometryDriftReport {
  ok: boolean;
  scannedPages: number;
  findings: StencilGeometryDriftFinding[];
  absentPages: { stencil: string; pageId: string }[];
}

export interface GeometryScanOptions {
  /** Bounds tolerance in EMU per edge. Default 12_700 (1pt). */
  toleranceEmu?: number;
  /** Colour tolerance per channel (0-1). Default 0.01. */
  colourTolerance?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Read the builder's requests as the objects it creates. */
export function expectedObjects(requests: ReadonlyArray<Record<string, unknown>>): ExpectedObject[] {
  const byId = new Map<string, ExpectedObject>();
  const order: string[] = [];
  for (const req of requests as any[]) {
    if (req.createShape) {
      const cs = req.createShape;
      const ep = cs.elementProperties ?? {};
      const b = elementBounds({ size: ep.size, transform: ep.transform });
      byId.set(cs.objectId, { objectId: cs.objectId, x: b.left, y: b.top, w: b.w, h: b.h });
      order.push(cs.objectId);
    } else if (req.updateTextStyle) {
      const o = byId.get(req.updateTextStyle.objectId);
      const style = req.updateTextStyle.style ?? {};
      if (o && style.foregroundColor?.opaqueColor?.rgbColor) o.textColor = style.foregroundColor.opaqueColor.rgbColor;
      if (o && typeof style.fontSize?.magnitude === 'number') o.fontSize = style.fontSize.magnitude;
    } else if (req.updateShapeProperties) {
      const o = byId.get(req.updateShapeProperties.objectId);
      const fill = req.updateShapeProperties.shapeProperties?.shapeBackgroundFill?.solidFill?.color?.rgbColor;
      if (o && fill) o.fillColor = fill;
    }
  }
  return order.map((id) => byId.get(id)!);
}

function fmtColour(c: { rgbColor?: Rgb | null; themeColor?: string | null } | Rgb | null | undefined): string {
  if (!c) return 'unset';
  const anyC = c as any;
  if (anyC.themeColor) return `theme:${anyC.themeColor}`;
  const rgb: Rgb = anyC.rgbColor ?? anyC;
  const hex = (v?: number) => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0');
  return `#${hex(rgb.red)}${hex(rgb.green)}${hex(rgb.blue)}`;
}

function sameRgb(a: Rgb, b: Rgb | null | undefined, tol: number): boolean {
  if (!b) return false;
  return (['red', 'green', 'blue'] as const).every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) <= tol);
}

/** The first explicit text style on a live shape (the builder styles ALL text). */
function liveTextStyle(el: LiveElement) {
  for (const te of el.shape?.text?.textElements ?? []) {
    const style = te?.textRun?.style;
    if (te?.textRun && style) return style;
  }
  return undefined;
}

/**
 * Compare a deck's stencil pages against what the geometry builders emit.
 *
 * @param pages     live elements per stencil page
 * @param stencils  stencil key -> page objectId (`STENCILS`)
 * @param builders  stencil key -> builder (`STENCIL_TEXT_BUILDERS`)
 */
export function scanStencilGeometryDrift(
  pages: readonly StencilPageElements[],
  stencils: Readonly<Record<string, string>>,
  builders: Readonly<Record<string, (pageId: string) => ReadonlyArray<Record<string, unknown>>>>,
  opts: GeometryScanOptions = {},
): StencilGeometryDriftReport {
  const tolEmu = opts.toleranceEmu ?? 12_700;
  const tolColour = opts.colourTolerance ?? 0.01;
  const byPage = new Map<string, readonly LiveElement[]>();
  for (const p of pages) byPage.set(p.pageId, p.elements);

  const findings: StencilGeometryDriftFinding[] = [];
  const absentPages: { stencil: string; pageId: string }[] = [];
  let scannedPages = 0;

  for (const stencil of Object.keys(stencils).sort()) {
    const pageId = stencils[stencil];
    const builder = builders[stencil];
    if (!builder) continue;
    const live = byPage.get(pageId);
    if (live === undefined) {
      absentPages.push({ stencil, pageId });
      continue;
    }
    scannedPages++;
    const liveById = new Map<string, LiveElement>();
    for (const el of live) if (el.objectId) liveById.set(el.objectId, el);

    const differences: GeometryDriftDifference[] = [];
    for (const exp of expectedObjects(builder(pageId))) {
      const el = liveById.get(exp.objectId);
      if (!el) {
        differences.push({ objectId: exp.objectId, kind: 'missing', expected: 'present', actual: 'absent' });
        continue;
      }
      const b = elementBounds(el);
      const off =
        Math.abs(b.left - exp.x) > tolEmu ||
        Math.abs(b.top - exp.y) > tolEmu ||
        Math.abs(b.w - exp.w) > tolEmu ||
        Math.abs(b.h - exp.h) > tolEmu;
      if (off) {
        differences.push({
          objectId: exp.objectId,
          kind: 'bounds',
          expected: `x=${exp.x} y=${exp.y} w=${exp.w} h=${exp.h}`,
          actual: `x=${Math.round(b.left)} y=${Math.round(b.top)} w=${Math.round(b.w)} h=${Math.round(b.h)}`,
        });
      }
      const style = liveTextStyle(el);
      if (exp.textColor) {
        const liveColour = style?.foregroundColor?.opaqueColor;
        if (!sameRgb(exp.textColor, liveColour?.rgbColor ?? null, tolColour) || liveColour?.themeColor) {
          differences.push({
            objectId: exp.objectId,
            kind: 'text-colour',
            expected: fmtColour(exp.textColor),
            actual: fmtColour(liveColour ?? null),
          });
        }
      }
      if (exp.fontSize !== undefined) {
        const size = style?.fontSize?.magnitude;
        if (size !== exp.fontSize) {
          differences.push({
            objectId: exp.objectId,
            kind: 'font-size',
            expected: `${exp.fontSize}pt`,
            actual: size == null ? 'unset' : `${size}pt`,
          });
        }
      }
      if (exp.fillColor) {
        const fill = el.shape?.shapeProperties?.shapeBackgroundFill?.solidFill?.color;
        if (!sameRgb(exp.fillColor, fill?.rgbColor ?? null, tolColour) || fill?.themeColor) {
          differences.push({
            objectId: exp.objectId,
            kind: 'fill-colour',
            expected: fmtColour(exp.fillColor),
            actual: fmtColour(fill ?? null),
          });
        }
      }
    }
    if (differences.length) findings.push({ stencil, pageId, differences });
  }

  return { ok: findings.length === 0, scannedPages, findings, absentPages };
}

/** Human-readable WARN block. Absent pages are the token scan's to report. */
export function formatStencilGeometryDrift(report: StencilGeometryDriftReport): string {
  if (report.ok) {
    return `stencil geometry drift: OK (${report.scannedPages} stencil pages match the builders)`;
  }
  const lines = [
    `stencil geometry drift: WARN (${report.findings.length} of ${report.scannedPages} stencil pages differ ` +
      `from lib/training-deck-stencil-geometry.ts)`,
    '',
  ];
  for (const f of report.findings) {
    lines.push(`  ${f.stencil} (${f.pageId}):`);
    for (const d of f.differences) {
      lines.push(`    ${d.objectId} ${d.kind}: template ${d.actual}, builder ${d.expected}`);
    }
  }
  lines.push(
    '',
    '  A geometry fix merged to the builders never reaches a rendered deck until the',
    '  template is reconciled (ace#2204). Rebuild the drifted pages in place:',
    '',
    '    npx tsx scripts/check-stencil-token-drift.ts --repair',
    '',
    '  or re-mint with scripts/bootstrap-training-deck-template.ts. If a difference is',
    '  a deliberate hand-edit of the template, move it into the builder instead, or',
    '  the next mint or repair will undo it.',
  );
  return lines.join('\n');
}
