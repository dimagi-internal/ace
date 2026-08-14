import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A skill may not assert that ANOTHER system rejects something without citing
 * evidence that it observed that rejection.
 *
 * ## The failure class
 *
 * ACE encodes a plausible claim about an external system's behaviour as a
 * rule, then obeys the rule. Three of these surfaced on 2026-08-13 alone:
 *
 *   | Claim                                            | Reality                          |
 *   |--------------------------------------------------|----------------------------------|
 *   | `caseWrite` acts as a preload                    | Write-only                       |
 *   | A visible case-bound field preloads implicitly   | Emits nothing                    |
 *   | A `<case>` block makes `make_build` reject       | No reproducer; HQ accepts these  |
 *
 * The third is the expensive one. `app-hq-settings` refused to patch any form
 * containing a `<case>` block — but Nova emits one inside `__nova_operations`
 * on every app that writes case properties, so the guard fired on essentially
 * every ACE Deliver app. Camera-only was never applied; `app-release-qa`
 * Step 2.8 then halted because it was missing. **Phase 3 deadlocked on every
 * run.** It shipped with no reproducer at all: it cited
 * `skills/pdd-to-learn-app/reference.md`, which does not contain the claim,
 * and the error string appeared exactly once in the repo — inside the guard's
 * own justification.
 *
 * Nothing caught it. Jonathan did, by asking "that seems odd/incorrect".
 *
 * The point fix (deleting that guard, ace#1238) does not generalise. ACE's own
 * convention already says *attempt the transition and let the conflict be the
 * answer* (CLAUDE.md), and a predictive substring scan is precisely the
 * violation. This test is the rail that makes the convention mechanical.
 *
 * ## Why a ratchet rather than a hard bar
 *
 * 41 such assertions exist today and 34 cite nothing on or beside their own line. Failing all of
 * them at once would produce a test nobody can land, which is how guards get
 * disabled. So the known set is pinned below and the test blocks only what is
 * NEW. Shrinking `BASELINE` is always allowed and never needs this file
 * rewritten — the assertion is one-directional.
 */

const CLAIM = new RegExp(
  [
    'rejects with',
    'will reject',
    'would reject',
    'refuses to',
    'silently (drops|fails)',
    'HQ (will|rejects)',
    'Nova (will|cannot|does not)',
  ].join('|'),
);

/**
 * Evidence that the claim was OBSERVED: a tracker reference, an ACE run id
 * (`20260813-2101`), or the word "repro".
 *
 * The window is DELIBERATELY tight (±1 line: the claim's own line, or the one
 * either side of it). A ±3 window was tried first and the negative control
 * caught it out — a claim appended anywhere near a skill's changelog table
 * borrowed one of that table's issue numbers and read as cited. The citation
 * has to belong to the CLAIM, not merely share a neighbourhood with one.
 * Cost of the tightening: 27 -> 34 baseline entries. Worth it; a rail that a
 * nearby table can switch off is not a rail.
 */
const CITATION = /#\d{3,4}|20\d{6}-\d{4}|repro/i;
const CONTEXT_LINES = 1;

/**
 * Uncited claims as of 2026-08-14, by file. This is a DEBT LEDGER, not an
 * approval — every entry is a claim about another system that nobody has
 * shown fired. Lower these numbers; do not raise them.
 */
const BASELINE: Record<string, number> = {
  'skills/connect-opp-setup/SKILL.md': 6,
  'skills/app-hq-settings/SKILL.md': 3,
  'skills/pdd-to-learn-app/SKILL.md': 3,
  'skills/README.md': 3,
  'skills/pdd-to-deliver-app/SKILL.md': 2,
  'skills/_app-component-library.md': 1,
  'skills/_qa-decisions.md': 1,
  'skills/app-connect-coverage/SKILL.md': 1,
  'skills/app-deploy/SKILL.md': 1,
  'skills/app-multimedia-coverage/SKILL.md': 1,
  'skills/idea-to-pdd/SKILL.md': 1,
  'skills/ocs-agent-setup/SKILL.md': 1,
  'skills/ocs-chatbot-eval/SKILL.md': 1,
  'skills/partnership-angles/SKILL.md': 1,
  'skills/partnership-deck-build/SKILL.md': 1,
  'skills/partnership-microdemo/SKILL.md': 1,
  'skills/partnership-publish/SKILL.md': 1,
  'skills/partnership-video-build/SKILL.md': 1,
  'skills/pdd-to-learn-app-eval/SKILL.md': 1,
  'skills/pdd-to-learn-app/reference.md': 1,
  'skills/synthetic-narrative-plan-eval/SKILL.md': 1,
  'skills/video-render-local/SKILL.md': 1,
};

const repoRoot = new URL('../..', import.meta.url).pathname;

function markdownFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFilesUnder(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Claims in a file with no citation within ±CONTEXT_LINES. */
function uncitedClaims(absPath: string): { line: number; text: string }[] {
  const lines = readFileSync(absPath, 'utf8').split('\n');
  const hits: { line: number; text: string }[] = [];
  lines.forEach((line, i) => {
    if (!CLAIM.test(line)) return;
    const from = Math.max(0, i - CONTEXT_LINES);
    const to = Math.min(lines.length, i + CONTEXT_LINES + 1);
    if (CITATION.test(lines.slice(from, to).join('\n'))) return;
    hits.push({ line: i + 1, text: line.trim().slice(0, 140) });
  });
  return hits;
}

function scan(): Map<string, { line: number; text: string }[]> {
  const found = new Map<string, { line: number; text: string }[]>();
  for (const abs of markdownFilesUnder(join(repoRoot, 'skills'))) {
    const rel = abs.slice(repoRoot.length).replace(/^\//, '');
    const hits = uncitedClaims(abs);
    if (hits.length > 0) found.set(rel, hits);
  }
  return found;
}

describe('predictive guards must cite a reproducer', () => {
  it('no skill gains a NEW uncited claim about another system', () => {
    const found = scan();
    const offenders: string[] = [];

    for (const [file, hits] of found) {
      const allowed = BASELINE[file] ?? 0;
      if (hits.length > allowed) {
        const extra = hits.slice(allowed);
        offenders.push(
          `${file}: ${hits.length} uncited claims, baseline ${allowed}\n` +
            extra.map((h) => `    ${file}:${h.line}  ${h.text}`).join('\n'),
        );
      }
    }

    expect(
      offenders.join('\n\n'),
      'A skill asserts that another system rejects/refuses/silently-drops something, ' +
        'with no issue number, run id, or "repro" on or beside its own line.\n\n' +
        'ACE has shipped this exact class three times (ace#1238 deadlocked Phase 3 on ' +
        'EVERY run). Either observe the rejection once and cite it, or delete the ' +
        'prediction and let the real call be the authority — CLAUDE.md: "attempt the ' +
        'transition and treat the conflict as the skip."\n',
    ).toBe('');
  });

  it('the baseline is a ledger to pay down, not a floor to fill', () => {
    // A file that no longer carries its budgeted claims must have the budget
    // lowered, so the ratchet cannot silently re-open. This is what makes the
    // debt actually shrink instead of being traded between files.
    const found = scan();
    const stale = Object.entries(BASELINE)
      .filter(([file, n]) => (found.get(file)?.length ?? 0) < n)
      .map(([file, n]) => `${file}: baseline ${n}, actual ${found.get(file)?.length ?? 0}`);

    expect(
      stale.join('\n'),
      'These files improved — lower their BASELINE entries (or delete them) to lock the gain in.',
    ).toBe('');
  });

  it('the detector actually fires on the guard that cost us Phase 3', () => {
    // Negative control. Without this, a regex that matches nothing would pass
    // both assertions above and look like a healthy repo.
    const pathologic = [
      'Before patching, scan the form for a `<case>` block.',
      'If present, `commcare_make_build` rejects with "Cannot use Case Management UI',
      'if you already have a case block in your form" — so halt instead.',
    ].join('\n');

    const lines = pathologic.split('\n');
    const claimLine = lines.findIndex((l) => CLAIM.test(l));
    expect(claimLine, 'the detector must match the historical guard').toBeGreaterThanOrEqual(0);
    expect(CITATION.test(pathologic), 'and that guard cited nothing').toBe(false);
  });
});
