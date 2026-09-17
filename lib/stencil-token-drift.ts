/**
 * Builder/template placeholder-drift scanner for the 14-stencil Slides deck.
 *
 * ## The gap this closes
 *
 * A rendered deck's text does not arrive with the template copy. The copy is
 * BARE stencils carrying `{{TOKEN}}` placeholders, and every value is
 * substituted by `replaceAllText` requests the builder emits. So the template
 * and the builder are two halves of one contract, maintained in different
 * places — a Slides file nobody diffs, and TypeScript that CI tests. They can
 * drift in BOTH directions, and each direction has already shipped:
 *
 *  - **orphaned** — the stencil carries a token the builder does not replace.
 *    Nothing targets it, so it survives onto the rendered slide and the
 *    reader sees a literal `{{DURATION}}`. This is ace#2429: the duration
 *    badge left the builder's contract on 2026-09-09 and stayed on the live
 *    template, so 13 exercise slides of `poverty-graduation/20260915-1518`
 *    shipped the raw token to a partner.
 *
 *  - **missing** — the builder replaces a token the stencil does not carry.
 *    The replacement matches zero shapes, the API returns 200, and the value
 *    is silently dropped. This is ace#2126 / ace#1503 (every timeline slide in
 *    every ACE training deck rendered a literal `{{BODY}}` and dropped all of
 *    its steps).
 *
 * ## Why neither existing check sees it
 *
 * `unmatchedReplacements` (the ace#2126 guard) only reports tokens the builder
 * TRIED to replace, so it covers `missing` and is structurally blind to
 * `orphaned` — a token the builder stopped emitting is never targeted, and the
 * poverty-graduation render reported 281 requests, 281 replies, 0 unmatched
 * while 13 slides carried the token. `training-deck-generate`'s
 * `/\{\{[A-Z_]+\}\}/` sweep scans the SPEC, which is clean; the token lives in
 * the template.
 *
 * This module scans the one artifact that holds BOTH halves at once: the
 * copied deck's stencil pages, read back after `slides_copy_template` and
 * compared against the builder's declared placeholder contract
 * (`STENCIL_PLACEHOLDERS`). It is deliberately pure — the Slides round-trip
 * lives in `scripts/check-stencil-token-drift.ts`, so the logic is unit
 * testable without a network call.
 */

/**
 * A placeholder token as it appears in stencil text.
 *
 * Digits are in the class on purpose: the live contract includes `{{STAT1}}`,
 * `{{STAT1_LABEL}}` and `{{STEP_0_CAPTION}}`. The narrower `/\{\{[A-Z_]+\}\}/`
 * used elsewhere in the repo would miss every one of them.
 */
export const STENCIL_TOKEN_RE = /\{\{[A-Z0-9_]+\}\}/g;

/** Text harvested from ONE stencil page: one entry per text-bearing shape. */
export interface StencilPageText {
  pageId: string;
  /**
   * One string per shape. Kept per-shape rather than pre-joined so a token can
   * never be manufactured by concatenating two adjacent shapes' text.
   */
  texts: readonly string[];
}

export interface StencilTokenDriftFinding {
  /** The stencil key, e.g. `exercise`. */
  stencil: string;
  /** The stencil page objectId, e.g. `ace_stencil_exercise`. */
  pageId: string;
  /**
   * Tokens the page carries that the builder never replaces. These render
   * LITERALLY to the reader.
   */
  orphaned: string[];
  /**
   * Tokens the builder replaces that the page does not carry. These are
   * silently DROPPED from the rendered slide.
   */
  missing: string[];
}

export interface StencilTokenDriftReport {
  ok: boolean;
  scannedPages: number;
  findings: StencilTokenDriftFinding[];
  /** Stencil keys whose page was not present in the scanned deck at all. */
  absentPages: { stencil: string; pageId: string }[];
}

export interface ScanOptions {
  /**
   * Tokens that legitimately appear without a body-page replacement.
   *
   * `{{NOTES}}` is the standing case: the bootstrap injects it into each
   * stencil's SPEAKER NOTES page (`<pageId>:notes`), not onto the stencil
   * body, and the builder's replacement is scoped to the notes page. A caller
   * that harvests notes text into `texts` would otherwise see it as orphaned.
   */
  exempt?: readonly string[];
}

const DEFAULT_EXEMPT = ['{{NOTES}}'] as const;

/** Every distinct placeholder token in a string, in first-seen order. */
export function extractTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(STENCIL_TOKEN_RE)) seen.add(m[0]);
  return [...seen];
}

/**
 * Compare a deck's stencil pages against the builder's placeholder contract.
 *
 * @param pages        text harvested per stencil page (see `StencilPageText`)
 * @param stencils     stencil key -> page objectId (the `STENCILS` constant)
 * @param placeholders stencil key -> tokens the builder replaces
 *                     (the `STENCIL_PLACEHOLDERS` constant)
 */
export function scanStencilTokenDrift(
  pages: readonly StencilPageText[],
  stencils: Readonly<Record<string, string>>,
  placeholders: Readonly<Record<string, readonly string[]>>,
  opts: ScanOptions = {},
): StencilTokenDriftReport {
  const exempt = new Set<string>(opts.exempt ?? DEFAULT_EXEMPT);
  const textByPageId = new Map<string, readonly string[]>();
  for (const page of pages) textByPageId.set(page.pageId, page.texts);

  const findings: StencilTokenDriftFinding[] = [];
  const absentPages: { stencil: string; pageId: string }[] = [];
  let scannedPages = 0;

  for (const stencil of Object.keys(stencils).sort()) {
    const pageId = stencils[stencil];
    const texts = textByPageId.get(pageId);
    if (texts === undefined) {
      absentPages.push({ stencil, pageId });
      continue;
    }
    scannedPages++;

    const declared = new Set<string>(placeholders[stencil] ?? []);
    const present = new Set<string>();
    for (const text of texts) for (const token of extractTokens(text)) present.add(token);

    const orphaned = [...present].filter((t) => !declared.has(t) && !exempt.has(t)).sort();
    const missing = [...declared].filter((t) => !present.has(t) && !exempt.has(t)).sort();

    if (orphaned.length || missing.length) {
      findings.push({ stencil, pageId, orphaned, missing });
    }
  }

  return {
    ok: findings.length === 0 && absentPages.length === 0,
    scannedPages,
    findings,
    absentPages,
  };
}

/** Human-readable report — the text a halting skill or script prints. */
export function formatStencilTokenDrift(report: StencilTokenDriftReport): string {
  if (report.ok) {
    return `stencil token drift: OK (${report.scannedPages} stencil pages, no drift)`;
  }

  const lines: string[] = [
    `stencil token drift: DRIFT (${report.scannedPages} stencil pages scanned)`,
    '',
  ];

  for (const f of report.findings) {
    lines.push(`  ${f.stencil} (${f.pageId}):`);
    if (f.orphaned.length) {
      lines.push(
        `    orphaned — on the template, never replaced by the builder; these render`,
        `    LITERALLY to the reader: ${f.orphaned.join(', ')}`,
      );
    }
    if (f.missing.length) {
      lines.push(
        `    missing  — replaced by the builder, absent from the template; these`,
        `    values are silently DROPPED: ${f.missing.join(', ')}`,
      );
    }
  }

  for (const a of report.absentPages) {
    lines.push(`  ${a.stencil}: page ${a.pageId} is not in the deck at all`);
  }

  lines.push(
    '',
    '  The live template and the builder have drifted. Reconcile the TEMPLATE to',
    '  lib/training-deck-stencil-geometry.ts — this rebuilds the drifted stencil',
    '  pages in place, so the template id does not change and no 1Password /',
    '  .env rotation is needed:',
    '',
    '    npx tsx scripts/check-stencil-token-drift.ts \\',
    '      --template "$ACE_TRAINING_DECK_TEMPLATE_ID" --repair',
    '',
    '  Do NOT paper over it by folding the value into a neighbouring token, and do',
    '  not patch the RENDERED deck — that fixes one artifact and leaves the next',
    '  render to reproduce it (ace#2429).',
  );

  return lines.join('\n');
}
