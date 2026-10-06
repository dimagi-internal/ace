/**
 * Plain-language lint for the registry text a report RENDERS (ace#2748).
 *
 * A semantic registry carries two kinds of prose. AUTHOR-facing text —
 * `scope_note`, `means`, a measure's `description` — is for the next person
 * maintaining the registry, and should cite the PDD (`semantic-registry-author-qa`'s
 * `pdd-anchor` check requires it). READER-facing text is what the indicator
 * cascade prints on screen for a programme manager, who has never seen the PDD
 * and does not know its section numbers or metric ids.
 *
 * spark-facilitator/20261004-1706 (registry 7748) shipped
 * `display.targets_note: "Targets are the PDD's own (§8.1 P1 ≥ 80%, P3 ≥ 75%). …"`.
 * canopy's DDD user-artifact judge scored it clarity 2 and it alone capped the
 * demo at 2.0 (DDD run spark-facilitator-programme-cascade-2026-10-06-004). The
 * same registry's `visit_flags[].description` cite `(PDD §5.4)` and
 * `(PDD §7.2 S-1)`. No build-level gate read any of it, so the demo judge was the
 * first reader. This module is that gate: deterministic, no LLM, run by
 * `semantic-registry-author-qa` (`display-text`) and `demo-data-setup-qa`
 * (`cascade_registry_text_is_plain`).
 *
 * Pure: no I/O.
 */

export type DisplayTextRule = 'design-doc-ref' | 'indicator-code' | 'symbol' | 'field-name';

export interface DisplayTextFinding {
  /** Where in the registry, e.g. `display.targets_note`, `indicator SF_P1 meta.plain`. */
  path: string;
  rule: DisplayTextRule;
  /** The offending substring. */
  match: string;
  text: string;
}

export interface DisplayTextReport {
  pass: boolean;
  /** How many reader-facing strings were read. */
  checked: number;
  findings: DisplayTextFinding[];
}

/** What to write instead, per rule — the auto-fix a QA result carries. */
export const DISPLAY_TEXT_FIX: Record<DisplayTextRule, string> = {
  'design-doc-ref':
    'say where it comes from in words ("the pilot design") — a programme manager has no PDD and no section numbers; keep the citation in scope_note',
  'indicator-code':
    'name the measure in words ("a meeting in at least 80% of weeks"), not its code (P1, S-1, SF_P1)',
  symbol: 'write the words: "at least", "at most", "more than", "less than"',
  'field-name': 'use the words a reader knows ("households enrolled"), not the column name (enrolled_households)',
};

interface Rule {
  rule: DisplayTextRule;
  re: RegExp;
}

const RULES: Rule[] = [
  // Design-document references: the PDD by name, a section sign, a "section 8"
  // phrase, a multi-level number (7.2.1), a dotted number in brackets "(5.4)", or
  // a dotted number glued to a metric code "8.1 P1". A bare decimal ("0.2 mg/L",
  // "1.5 visits") is a quantity, not a section, and is deliberately not matched.
  { rule: 'design-doc-ref', re: /\bPDDs?\b/g },
  { rule: 'design-doc-ref', re: /§\s*[\d.]*/g },
  { rule: 'design-doc-ref', re: /\b(?:section|sec\.)\s*\d+(?:\.\d+)*/gi },
  { rule: 'design-doc-ref', re: /\b\d+\.\d+\.\d+(?:\.\d+)*\b/g },
  { rule: 'design-doc-ref', re: /\(\s*\d+\.\d+\s*\)/g },
  { rule: 'design-doc-ref', re: /\b\d+\.\d+\s+(?=[A-Z]{1,2}-?\d)/g },
  // Internal indicator codes: P1, P3, S-1, D2 and series ids like SF_P1. Q1–Q4
  // (quarters) are plain language and are exempt.
  { rule: 'indicator-code', re: /\b[A-Z]{2,}_[A-Z0-9_]+\b/g },
  { rule: 'indicator-code', re: /\b(?!Q[1-4]\b)[A-Z]{1,2}-?\d{1,2}\b/g },
  // Comparison symbols standing in for words.
  { rule: 'symbol', re: /[≥≤≠]|>=|<=|!=|(?:^|\s)[<>]\s*(?=\d)/g },
  // Raw field / column names: snake_case.
  { rule: 'field-name', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
];

/** Every rule a string breaks, with the substring that broke it. One finding per (rule, match). */
export function lintDisplayText(text: string): Array<{ rule: DisplayTextRule; match: string }> {
  const out: Array<{ rule: DisplayTextRule; match: string }> = [];
  const seen = new Set<string>();
  for (const { rule, re } of RULES) {
    for (const m of text.matchAll(re)) {
      const match = m[0].trim();
      const key = `${rule}\u0000${match}`;
      if (!match || seen.has(key)) continue;
      seen.add(key);
      out.push({ rule, match });
    }
  }
  return out;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * The reader-facing strings of a registry, with where each lives. Reads the
 * `indicators_doc` (`display` + every measure that carries `meta.indicator`).
 * Author-facing fields — `scope_note`, `means`, `description` on a measure — are
 * deliberately NOT returned. `visit_flags[].description` IS: the worker review
 * prints it beside the flag.
 */
export function readerFacingTexts(indicatorsDoc: unknown): Array<{ path: string; text: string }> {
  const doc = asObj(indicatorsDoc);
  const display = asObj(doc.display);
  const out: Array<{ path: string; text: string }> = [];
  const push = (path: string, v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push({ path, text: v });
  };
  push('display.title', display.title);
  push('display.targets_note', display.targets_note);
  for (const noun of ['entity', 'worker', 'organisation'] as const) {
    push(`display.${noun}.name`, asObj(display[noun]).name);
    push(`display.${noun}.plural`, asObj(display[noun]).plural);
  }
  for (const [i, c] of asArr(display.categories).entries()) push(`display.categories[${i}]`, c);
  push('display.reading.label', asObj(display.reading).label);
  for (const [i, f] of asArr(display.case_fields).entries()) push(`display.case_fields[${i}].label`, asObj(f).label);
  for (const [i, f] of asArr(display.visit_fields).entries()) push(`display.visit_fields[${i}].label`, asObj(f).label);
  for (const [i, f] of asArr(display.visit_flags).entries()) {
    push(`display.visit_flags[${i}].label`, asObj(f).label);
    push(`display.visit_flags[${i}].description`, asObj(f).description);
  }
  for (const m of asArr(doc.measures)) {
    const meta = asObj(asObj(m).meta);
    if (!meta.indicator) continue;
    push(`indicator ${String(meta.indicator)} meta.label`, meta.label);
    push(`indicator ${String(meta.indicator)} meta.plain`, meta.plain);
  }
  return out;
}

/** Lint every reader-facing string of a registry's `indicators_doc`. */
export function checkRegistryDisplayText(indicatorsDoc: unknown): DisplayTextReport {
  const texts = readerFacingTexts(indicatorsDoc);
  const findings: DisplayTextFinding[] = [];
  for (const { path, text } of texts) {
    for (const { rule, match } of lintDisplayText(text)) findings.push({ path, rule, match, text });
  }
  return { pass: findings.length === 0, checked: texts.length, findings };
}

/** One line per finding, with what to write instead — for a QA result's `detail`. */
export function describeDisplayTextFindings(findings: readonly DisplayTextFinding[]): string {
  return findings.map((f) => `${f.path}: "${f.match}" (${f.rule}) — ${DISPLAY_TEXT_FIX[f.rule]}`).join('; ');
}

/**
 * Find the `indicators_doc` in what a caller has on disk: the authored registry
 * (`{properties_doc, indicators_doc, deployment}`) or a `semantic_registry_get`
 * response that nests it one level down.
 */
export function indicatorsDocOf(registry: unknown): Record<string, unknown> | null {
  const root = asObj(registry);
  if (root.indicators_doc) return asObj(root.indicators_doc);
  for (const v of Object.values(root)) {
    const inner = asObj(v);
    if (inner.indicators_doc) return asObj(inner.indicators_doc);
  }
  return null;
}
