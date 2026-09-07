/**
 * The work-order writing-style reference must not sanction a phrasing it bans
 * elsewhere (dimagi-internal/ace#2164).
 *
 * `skills/pdd-to-work-order/references/writing-style.md` is required reading
 * before `pdd-to-work-order` synthesizes any prose token, and
 * `pdd-to-work-order-eval § writing_style` grades the produced document against
 * it. So a rule the reference states twice in one direction and once in the
 * other is not a cosmetic wart: the producer follows the sanctioned example, the
 * independent eval strikes it, and `writing_style` (weight 0.15) drops to
 * `partial` on every run rather than once.
 *
 * That is exactly what shipped. Until this test, § Hedging and commercial
 * softness recommended `We think this could allow…` and
 * `Our suggestion is to try to get…` while § Pronoun and naming strategy
 * ("no `we`, no `our team`") and § Terminology preferences ("Dimagi | Dimagi,
 * Inc., we, our team") forbade the pronouns those phrasings are built from.
 * Observed live on `bednet-check-2-visit/20260907-1126`, where
 * `{{primary_deliverable_body}}` rendered as *"We think this could allow a
 * meaningful read on net-use rates…"* — verbatim from the hedging table — and
 * took a `writing_style` strike for it.
 *
 * The resolution is that the BAN wins: a work order is a partner-facing
 * contractual document, so Dimagi is named in the third person throughout.
 * Hedging keeps its intent and loses its pronouns.
 *
 * This test pins the CLASS, not those two rows — a newly added hedging row
 * reintroducing `we`/`our` fails here rather than in a run's eval verdict. It
 * also holds the reference and the eval rubric in agreement, so "fixing" the
 * contradiction by deleting the ban fails too.
 *
 * SCOPE: static and deterministic. It reads two markdown files; no network, no
 * LLM, no judgement about whether a given hedge is *good* — only that a
 * sanctioned phrasing is satisfiable under the file's own pronoun rules.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STYLE = path.join(REPO_ROOT, 'skills/pdd-to-work-order/references/writing-style.md');
const EVAL = path.join(REPO_ROOT, 'skills/pdd-to-work-order-eval/SKILL.md');

/** First-person plural, as a whole word. The pronoun class the doc bans. */
const FIRST_PERSON_PLURAL = /\b(we|we'?re|we'?ll|we'?ve|our|ours|us)\b/i;

const styleDoc = fs.readFileSync(STYLE, 'utf8');
const evalDoc = fs.readFileSync(EVAL, 'utf8');

/** Lines of the section whose heading matches `heading`, up to the next heading of the same-or-higher level. */
function section(doc: string, heading: string): string[] {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) throw new Error(`writing-style.md has no section "${heading}" — the reference was restructured; update this test deliberately.`);
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#+\s/.test(l) && l.match(/^#+/)![0].length <= level);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Backticked spans in the first cell of each markdown table row (skipping header + separator). */
function sanctionedPhrases(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator
    const firstCell = line.split('|')[1] ?? '';
    if (/^\s*Softening phrase\s*$/i.test(firstCell)) continue; // header
    for (const m of firstCell.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out;
}

describe('work-order writing-style: hedging table obeys the doc\'s own pronoun ban', () => {
  it('every sanctioned softening phrase is free of first-person plural', () => {
    const phrases = sanctionedPhrases(section(styleDoc, '## Hedging and commercial softness'));
    expect(phrases.length).toBeGreaterThanOrEqual(5); // the table did not silently empty out

    const offenders = phrases.filter((p) => FIRST_PERSON_PLURAL.test(p));
    expect(
      offenders,
      `writing-style.md § Hedging and commercial softness recommends ${JSON.stringify(offenders)}, ` +
        `but the same file bans we/our (§ Pronoun and naming strategy, § Terminology preferences) and ` +
        `pdd-to-work-order-eval § writing_style grades that ban. A producer obeying the hedging table ` +
        `takes a guaranteed strike. Re-express the hedge in the third person ` +
        `(e.g. "Dimagi expects this could allow…", "Dimagi suggests aiming for…") — see ace#2164.`,
    ).toEqual([]);
  });

  it('the reusable sentence-level patterns are free of first-person plural too', () => {
    const phrases: string[] = [];
    for (const line of section(styleDoc, '## Sentence-level patterns')) {
      for (const m of line.matchAll(/`([^`]+)`/g)) phrases.push(m[1]);
    }
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases.filter((p) => FIRST_PERSON_PLURAL.test(p))).toEqual([]);
  });

  it('the ban the hedging table now respects is still stated in the reference', () => {
    // Deleting the ban is the other way to make the doc self-consistent — but it
    // would silently diverge from the eval rubric, which is graded independently.
    expect(styleDoc).toMatch(/no `we`, no `our team`/);
    expect(styleDoc).toMatch(/\|\s*Dimagi\s*\|\s*Dimagi, Inc\., we, our team\s*\|/);
  });

  it('pdd-to-work-order-eval still grades that same ban', () => {
    expect(evalDoc).toContain('skills/pdd-to-work-order/references/writing-style.md');
    expect(evalDoc).toMatch(/`Dimagi` not `Dimagi, Inc\.`\/`we`\/`our team`/);
  });
});
