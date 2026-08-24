/**
 * Drive-export normalisation shared by the `*-qa` skills that read a NATIVE
 * Google Doc back out of Drive.
 *
 * Two sibling QA skills read native gdocs and they want OPPOSITE export
 * formats — `pdd-to-work-order-qa` mandates `text/plain` (ace#1609),
 * `idea-to-pdd-qa` mandates `text/markdown` because its checks anchor on `##`
 * heading markers (ace#1617). Whichever a caller picks, the checks downstream
 * must see the same document, so both funnel their input through
 * `normalizeDriveExport` and the reader's format stops being load-bearing.
 *
 * Extracted to `lib/` (from `skills/pdd-to-work-order-qa/checks.ts`, where
 * ace#1612 first landed it) the moment the second skill needed it — a copy in
 * each skill is the drift class ace#1227 already paid for once.
 */

/**
 * Matches a backslash escaping any ASCII punctuation character — the
 * CommonMark escapable set, which is what Drive's markdown exporter emits.
 *
 * The ones actually observed in a real ACE work-order export
 * (`1_Dzp2ND_qDI2m9hMr_q2qf2VIIUsbR11ElM4cNRHQww`, revision 11, captured
 * 2026-08-23) are `\_` (118x), `\.` (9x), `\]` (8x), `\[` (8x) and `\#` (2x).
 */
export const MD_ESCAPABLE_PUNCT = /\\([\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E])/g;

/**
 * Strip Google Drive markdown-export escaping so a checker matches the same
 * document regardless of which `exportAs` the caller used.
 *
 * WHY THIS EXISTS: Drive's `text/markdown` export escapes markdown-significant
 * characters, so a numbered H2 `## 1. Background` arrives as
 * `## **1\. Background**`, `[TBD]` as `\[TBD\]` and `learn_passing_score` as
 * `learn\_passing\_score` — defeating heading, section, placeholder and
 * table-key matchers at once. Twice now that turned a CORRECT document into a
 * `verdict: fail` whose `auto_fix_hint`s told the producer to regenerate a
 * healthy artifact to fix a reader bug: 9/9 → 4/9 on a work order
 * (dimagi-internal/ace#1609) and 9/9 → 4/9 on a PDD
 * (dimagi-internal/ace#1617, hh-poverty-targeting/20260824-1404 Phase 1,
 * which blocked Phase 1 outright).
 *
 * Normalisation is applied for MATCHING only — reported `detail` strings are
 * taken from the normalised text, which is also what a human wants to read.
 *
 * Note `\n` in a source string is a literal backslash-n, NOT an escapable
 * punctuation char, so real newlines and C-style escapes survive untouched.
 */
export function normalizeDriveExport(text: string): string {
  return text.replace(MD_ESCAPABLE_PUNCT, '$1');
}
