// lib/screenshot-composite.ts
//
// Composited common-pool frames (dimagi-internal/ace#3060).
//
// Some screens in the cross-opp training pool cannot be captured generically.
// The Connect home screen and the opportunity-detail screen always show some
// program's name, description and modules, because the test worker's invites are
// real ACE runs. A frame that shows one program's content cannot go on every
// program's deck (the 2.63.0 pool audit, 2026-05-26). The only real-pixel fix
// is a test worker whose only invite is a generically named opportunity, which
// means a new Connect opportunity with its own released apps, just to change a
// title string.
//
// So for ILLUSTRATION ONLY, we composite. Start from a real capture of the same
// APK version, paint over the opp-specific text elements at the bounds the
// capture's own UI dump gives, and draw generic text in their place. The layout,
// chrome, icons and every untouched element are the device's pixels. Only named
// strings change, and the same inputs produce the same frame every time.
//
// The safety rules, all enforced here or in the reader:
//   1. COVERAGE: every text element in the dump must match a `keep` rule
//      (generic chrome) or a `replace` rule. Anything unaccounted for is
//      refused, so a new string on a later APK can't leak through unseen.
//      A replace rule that matches nothing is refused too (a stale spec).
//   2. PROVENANCE: the output is labelled `source: composited` with the base
//      capture's sha256 and the ids replaced. The original strings are not
//      recorded, since they are exactly what we are removing.
//   3. NEVER EVIDENCE: a composited frame illustrates; it never shows what the
//      app did. `collectCaptureEntries` (lib/capture-manifest.ts), the one
//      reader for per-opp evidence manifests, throws on a composited entry.
//
// Pixel work runs in Chromium (scripts/composite-pool-frame.ts). This file is
// the pure half: parse, check coverage, plan.

import { DOMParser } from '@xmldom/xmldom';

export interface UiTextNode {
  /** resource-id without the package prefix ('' when the node has none). */
  id: string;
  text: string;
  bounds: [number, number, number, number];
  /** Zero-based occurrence index among nodes with the same id, in dump order. */
  index: number;
}

export interface KeepRule {
  id: string;
  /** Regex the whole text must match. */
  text: string;
}

export interface ReplaceRule {
  id: string;
  /** Which occurrence of `id`. Omitted = every occurrence (then `text` must be a list, one per occurrence). */
  index?: number;
  text: string | string[];
  font_px: number;
  weight?: number;
  line_px?: number;
}

export interface CompositeFrameSpec {
  base: { recipe: string; step: string; sha256: string };
  keep: KeepRule[];
  replace: ReplaceRule[];
}

export interface PaintOp {
  id: string;
  index: number;
  rect: [number, number, number, number];
  text: string;
  fontPx: number;
  weight: number;
  linePx: number;
}

export interface CompositeProvenance {
  source: 'composited';
  composited_from: { recipe: string; step: string; sha256: string };
  replaced: Array<{ id: string; index: number }>;
}

const BOUNDS = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/;

/** Every node in a uiautomator dump that carries visible text. */
export function parseUiTextNodes(xml: string): UiTextNode[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const nodes = doc.getElementsByTagName('node');
  const seen = new Map<string, number>();
  const out: UiTextNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const text = n.getAttribute('text') ?? '';
    if (!text.trim()) continue;
    const id = (n.getAttribute('resource-id') ?? '').split('/').pop() ?? '';
    const m = BOUNDS.exec(n.getAttribute('bounds') ?? '');
    if (!m) continue;
    const index = seen.get(id) ?? 0;
    seen.set(id, index + 1);
    out.push({ id, text, index, bounds: [+m[1], +m[2], +m[3], +m[4]] });
  }
  return out;
}

export class CompositeCoverageError extends Error {}

/**
 * Plan the paint ops for one frame. Throws `CompositeCoverageError` naming every
 * text element no rule accounts for, and every replace rule that matched nothing.
 */
export function planComposite(nodes: UiTextNode[], spec: CompositeFrameSpec): PaintOp[] {
  const ops: PaintOp[] = [];
  const problems: string[] = [];
  const covered = new Set<UiTextNode>();

  for (const r of spec.replace) {
    const matches = nodes.filter((n) => n.id === r.id && (r.index === undefined || n.index === r.index));
    if (matches.length === 0) {
      problems.push(`replace rule matched nothing: id=${r.id || "''"}${r.index === undefined ? '' : ` index=${r.index}`}`);
      continue;
    }
    const texts = Array.isArray(r.text) ? r.text : [r.text];
    if (r.index === undefined && texts.length !== matches.length) {
      problems.push(`replace rule id=${r.id} matches ${matches.length} elements but gives ${texts.length} replacement(s)`);
      continue;
    }
    matches.forEach((n, i) => {
      covered.add(n);
      ops.push({
        id: n.id,
        index: n.index,
        rect: n.bounds,
        text: texts[r.index === undefined ? i : 0],
        fontPx: r.font_px,
        weight: r.weight ?? 400,
        linePx: r.line_px ?? Math.round(r.font_px * 1.17),
      });
    });
  }

  const keepers = spec.keep.map((k) => ({ id: k.id, re: new RegExp(`^(?:${k.text})$`, 's') }));
  for (const n of nodes) {
    if (covered.has(n)) continue;
    if (keepers.some((k) => k.id === n.id && k.re.test(n.text))) continue;
    // Never echo more than a prefix: this text is what we are trying not to publish.
    problems.push(`text element not covered by keep or replace: id=${n.id || "''"} index=${n.index} text="${n.text.slice(0, 24)}…"`);
  }

  if (problems.length) throw new CompositeCoverageError(problems.join('\n'));
  return ops;
}

export function compositeProvenance(spec: CompositeFrameSpec, ops: PaintOp[]): CompositeProvenance {
  return {
    source: 'composited',
    composited_from: { ...spec.base },
    replaced: ops.map((o) => ({ id: o.id, index: o.index })),
  };
}

/** True for a manifest entry that is a composited illustration. */
export function isComposited(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && (entry as { source?: unknown }).source === 'composited';
}
