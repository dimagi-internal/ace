/**
 * The archetype drift rail that DISCOVERS its sites (dimagi-internal/ace#2312).
 *
 * ## The failure class, and why two correct ratchets did not stop it
 *
 * `longitudinal-visits` shipped 2026-08-17. "A prose surface enumerates a stale
 * archetype set" has recurred SIX times since — ace#1486 → #1541 → #1630 →
 * #1784 → #2128 → #2294 — across two drift tests that are each CORRECT about
 * what they cover:
 *
 *   | test                                       | sites it pins |
 *   |--------------------------------------------|---------------|
 *   | `test/skills/archetype-enum-drift.test.ts`  | 5, by hand    |
 *   | `test/lib/archetype-enum-docs.test.ts`      | 5, by hand    |
 *
 * The two lists are disjoint, and that is the whole defect:
 *
 *   **A guard against "one fact enumerated in many places" that itself
 *   enumerates places has the very defect it guards against.**
 *
 * A new surface is unguarded BY CONSTRUCTION. ace#2294 is exactly that: two
 * Phase-4 eval rubrics in neither list, both enumerating the pre-2026-08-17
 * three, both tests green — and one of them carried a 3-point deduction on a
 * 14%-weighted dimension keyed to a list that excluded the archetype under
 * test, so a correctly configured `longitudinal-visits` opportunity was
 * gradeable as a mismatch against all three shapes it is not.
 *
 * So this file names no sites. `lib/archetype-enumeration-scan.ts` walks the
 * live-guidance roots and finds them; its header carries the detector's design
 * and the four false-positive classes that shaped it.
 *
 * The two list-based tests STAY. They are stricter about the files they name
 * (`pdd-to-work-order` must have a `### ` heading per archetype, not merely a
 * mention). This is the floor under them.
 *
 * ## Why a ratchet rather than a hard bar
 *
 * The scan finds 16 stale enumerations today, almost all `## Archetypes` rubric
 * tables in `-eval` skills that need a judgement per rubric ("what does
 * `longitudinal-visits` change about grading a training FAQ?"), not a
 * search-and-replace. Failing all 16 at once produces a test nobody can land,
 * which is how guards get deleted. So the debt is pinned per file as a COUNT
 * and only GROWTH is blocked — the shape `predictive-guard-citation` uses and
 * the shape ace#2443 converged on for `negative-control-ratchet` after a
 * membership rail could not be made to converge against a `main` that merges
 * every few minutes. A count is immune to that churn and still says the one
 * load-bearing thing: the debt cannot grow.
 *
 * Adding a FIFTH archetype fails every one of the 16 at once, loudly, by name —
 * which is the behaviour ace#1486 wanted and could only buy one file at a time.
 */
import { describe, it, expect } from 'vitest';

import { ARCHETYPES } from '../../lib/decisions-archetype-consistency.js';
import {
  ENUMERATION_THRESHOLD,
  GUIDANCE_ROOTS,
  countArchetypeMentions,
  guidanceFiles,
  scanArchetypeEnumerations,
  scanRepo,
} from '../../lib/archetype-enumeration-scan.js';

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Stale enumerations as of 2026-09-17, by file. A DEBT LEDGER, not an approval.
 *
 * Every entry is a `## Archetypes` branch table that omits `longitudinal-visits`
 * and therefore tells a producer or a judge that an archetype ACE fully supports
 * does not exist. Lower these numbers; do not raise them. Deleting a file's
 * entry entirely is always allowed and never needs this list rewritten.
 *
 * Measured by this file's own scanner over 661 archetype mentions in
 * `skills/ agents/ commands/ playbook/ templates/ lib/ mcp/` + `CLAUDE.md`.
 * It stood at 24 in 21 files before this change; the 8 closed here were
 * ace#2294's two Phase-4 rubrics (4) plus three surfaces whose fix needed no
 * product judgement (4).
 */
const BASELINE: Record<string, number> = {
  'skills/app-release-eval/SKILL.md': 1,
  'skills/cycle-grade-eval/SKILL.md': 1,
  'skills/flw-data-review-eval/SKILL.md': 1,
  'skills/learnings-summary-eval/SKILL.md': 1,
  'skills/llo-launch-eval/SKILL.md': 1,
  'skills/llo-uat-eval/SKILL.md': 1,
  'skills/pdd-to-deliver-app-eval/SKILL.md': 1,
  'skills/pdd-to-learn-app-eval/SKILL.md': 1,
  'skills/run-surface-audit-eval/SKILL.md': 1,
  'skills/training-deck-generate-eval/SKILL.md': 1,
  'skills/training-deck-generate/SKILL.md': 1,
  'skills/training-faq-eval/SKILL.md': 1,
  'skills/training-flw-guide-eval/SKILL.md': 1,
  'skills/training-llo-guide-eval/SKILL.md': 1,
  'skills/training-onboarding-email-eval/SKILL.md': 1,
  'skills/training-quick-reference-eval/SKILL.md': 1,
};

const BASELINE_NOTE = [
  '2026-09-17 at ACE 0.13.14xx: 16 stale enumerations in 16 files, from 661 archetype',
  '  mentions across 7 roots + CLAUDE.md. Pre-change: 24 in 21 files.',
  '  Every remaining entry is a `## Archetypes` branch table missing `longitudinal-visits`.',
  '  They are NOT search-and-replace: each needs a judgement about what the archetype',
  '  changes for that rubric, which is why they are ledgered rather than bulk-edited.',
].join('\n');

function scan() {
  return scanRepo(repoRoot, ARCHETYPES);
}

describe('archetype enumerations are DISCOVERED, not listed (#2312)', () => {
  it('discovery actually reaches the repo (liveness)', () => {
    // Without this, a walker that returned [] or a token regex that matched
    // nothing would report a perfectly healthy repo — which is the exact class
    // this file exists to stop, so it must not be this file's own.
    const files = guidanceFiles(repoRoot);
    expect(files.length, 'the walker found no guidance files').toBeGreaterThan(200);
    expect(
      countArchetypeMentions(repoRoot, ARCHETYPES),
      'the token regex matched no archetype anywhere — the scan is inert',
    ).toBeGreaterThan(300);
  });

  it('discovery covers files NO hand-maintained list names', () => {
    // The point of the change. `connect-*-setup-eval` are the ace#2294 files:
    // in neither drift test's list, and reached here purely by walking.
    const files = new Set(guidanceFiles(repoRoot).map((f) => f.slice(repoRoot.length + 1)));
    for (const rel of [
      'skills/connect-opp-setup-eval/SKILL.md',
      'skills/connect-program-setup-eval/SKILL.md',
      'agents/commcare-setup.md',
      'templates/pdd-template.md',
      'CLAUDE.md',
    ]) {
      expect(files.has(rel), `${rel} is not in scope — discovery is narrower than it reads`).toBe(
        true,
      );
    }
  });

  it('no file gains a NEW stale archetype enumeration', () => {
    const found = scan();
    const offenders: string[] = [];

    for (const [file, hits] of found) {
      const allowed = BASELINE[file] ?? 0;
      if (hits.length <= allowed) continue;
      offenders.push(
        `${file}: ${hits.length} stale enumerations, baseline ${allowed}\n` +
          hits
            .slice(allowed)
            .map((h) => `    ${file}:${h.line} [${h.kind}] omits ${h.missing.join(', ')}\n      ${h.excerpt}`)
            .join('\n'),
      );
    }

    expect(
      offenders.join('\n\n'),
      'A surface enumerates the archetype vocabulary and leaves one out.\n\n' +
        'ACE has shipped this six times (ace#1486 → #1541 → #1630 → #1784 → #2128 → #2294). ' +
        'It is not cosmetic: on bednet-check-2-visit/20260908-1544 a rubric whose ' +
        'payment-unit anchors named only three archetypes made a CORRECTLY configured ' +
        'longitudinal-visits opportunity gradeable as a 3-point deduction.\n\n' +
        'Two correct fixes:\n' +
        '  - name the missing archetype and say what it does there; or\n' +
        '  - stop enumerating — name the ONE exception and let every other archetype ' +
        'fall through (agents/synthetic-data-and-workflows.md does this deliberately, ' +
        'after ace#1691).\n\n' +
        'See skills/README.md § How to register a new archetype.\n',
    ).toBe('');
  });

  it('the ledger is a debt to pay down, not a floor to fill', () => {
    // A file that improved must have its entry lowered or removed, or the
    // ratchet silently re-opens and the budget stops meaning anything.
    const found = scan();
    const stale = Object.entries(BASELINE)
      .filter(([file, n]) => (found.get(file)?.length ?? 0) < n)
      .map(([file, n]) => `${file}: baseline ${n}, actual ${found.get(file)?.length ?? 0}`);

    expect(
      stale.join('\n'),
      'These improved — lower their BASELINE entries (or delete them) to lock the gain in.',
    ).toBe('');
  });

  it('records the baseline, so erosion is distinguishable from the starting point', () => {
    expect(BASELINE_NOTE).not.toBe('');
    expect(Object.keys(BASELINE).length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Negative controls. BOTH directions, on synthetic text, so the detector's
// behaviour is pinned independently of whatever the repo happens to contain.
//
// The first half proves it FIRES; the second proves it stays quiet on the four
// false-positive classes ace#2312 measured. A rail that is noisy gets disabled,
// so the quiet half is load-bearing too — each case below is VERBATIM prose
// from this repo that must never be flagged.
// ───────────────────────────────────────────────────────────────────────────
describe('the detector fires on a new unguarded surface (negative control)', () => {
  const FOUR = ['atomic-visit', 'longitudinal-visits', 'focus-group', 'multi-stage'];

  it('a brand-new skill with a three-row § Archetypes table goes RED', () => {
    // This is ace#2294's exact shape in a file no list has ever named, which is
    // the entire claim of this change. Ledger-free: the scan is over text.
    const newSkill = [
      '---',
      'name: brand-new-skill',
      '---',
      '',
      '## Archetypes',
      '',
      '| Archetype | What this skill does |',
      '|---|---|',
      '| `atomic-visit` | Default. Grades per-delivery payment. |',
      '| `focus-group` | Grades per-session payment. |',
      '| `multi-stage` | Grades per-stage payment. |',
      '',
      '## MCP Tools Used',
    ].join('\n');

    const hits = scanArchetypeEnumerations('skills/brand-new-skill/SKILL.md', newSkill, FOUR);
    expect(hits.map((h) => h.kind)).toEqual(['section']);
    expect(hits[0].missing).toEqual(['longitudinal-visits']);
    expect(hits[0].line, 'points at the `## Archetypes` heading').toBe(5);
  });

  it('and goes GREEN once the missing row is added — the same text, fixed', () => {
    const fixed = [
      '## Archetypes',
      '',
      '| Archetype | What this skill does |',
      '|---|---|',
      '| `atomic-visit` | Default. Grades per-delivery payment. |',
      '| `longitudinal-visits` | One unit for the whole arc; sequence in `entity_id`. |',
      '| `focus-group` | Grades per-session payment. |',
      '| `multi-stage` | Grades per-stage payment. |',
    ].join('\n');
    expect(scanArchetypeEnumerations('skills/brand-new-skill/SKILL.md', fixed, FOUR)).toEqual([]);
  });

  it('and goes GREEN on the other correct fix — stop enumerating', () => {
    // agents/synthetic-data-and-workflows.md does exactly this on purpose
    // (ace#1691): name the ONE exception, let every other archetype fall
    // through. A rail that only accepted "add the row" would push authors
    // toward the shape that keeps going stale.
    const deEnumerated = [
      '## Archetypes',
      '',
      'Archetype-agnostic apart from one exception: `focus-group` skips this',
      'step entirely. Every other archetype proceeds unchanged.',
    ].join('\n');
    expect(scanArchetypeEnumerations('skills/x/SKILL.md', deEnumerated, FOUR)).toEqual([]);
  });

  it('a stale inline run goes RED and its fixed form goes GREEN', () => {
    const stale = '   - Opportunity archetype (`atomic-visit` / `focus-group` / `multi-stage`).';
    const fixed =
      '   - Opportunity archetype (`atomic-visit` / `longitudinal-visits` /\n' +
      '     `focus-group` / `multi-stage`).';
    expect(scanArchetypeEnumerations('skills/x/SKILL.md', stale, FOUR)).toHaveLength(1);
    expect(scanArchetypeEnumerations('skills/x/SKILL.md', stale, FOUR)[0].kind).toBe('run');
    expect(scanArchetypeEnumerations('skills/x/SKILL.md', fixed, FOUR)).toEqual([]);
  });

  it('a FIFTH archetype turns every three-of-four surface red at once', () => {
    // The O(1) property. The scan takes the vocabulary as an argument, so a
    // vocabulary edit re-judges every discovered surface with no list to update.
    const five = [...FOUR, 'panel-survey'];
    const today = [
      '## Archetypes',
      '',
      '| `atomic-visit` | a |',
      '| `longitudinal-visits` | b |',
      '| `focus-group` | c |',
      '| `multi-stage` | d |',
    ].join('\n');
    expect(scanArchetypeEnumerations('skills/x/SKILL.md', today, FOUR)).toEqual([]);
    const withFifth = scanArchetypeEnumerations('skills/x/SKILL.md', today, five);
    expect(withFifth).toHaveLength(1);
    expect(withFifth[0].missing).toEqual(['panel-survey']);
  });
});

describe('the detector stays quiet on the four false-positive classes (#2312)', () => {
  const FOUR = ['atomic-visit', 'longitudinal-visits', 'focus-group', 'multi-stage'];
  const clean = (text: string) => scanArchetypeEnumerations('skills/x/SKILL.md', text, FOUR);

  it('class 1 — contrastive prose is not a closed set', () => {
    // Verbatim from skills/pdd-to-test-prompts/SKILL.md. Naming two archetypes
    // in order to contrast them is correct and must never be flagged; the
    // detector's answer is that PROSE between two mentions means contrast.
    const contrast = [
      '2. **Read the PDD\'s `Archetype:` field.** This skill branches on archetype —',
      '   `atomic-visit` uses visit-centric categories, `focus-group` uses session-centric',
      '   ones, and `multi-stage` uses stage-gated ones.',
    ].join('\n');
    expect(clean(contrast)).toEqual([]);
  });

  it('class 2 — a changelog row quoting a historical list', () => {
    // Verbatim shape from skills/connect-program-setup/SKILL.md:485. Flagging
    // it would demand editing history: the row REPORTS the old stale set as
    // the thing it fixed.
    const changelog = [
      '## Changelog',
      '',
      '| Date | Change | Author |',
      '|------|--------|--------|',
      '| 2026-09-05 | § Archetypes: the section covered `atomic-visit` / `focus-group` / `multi-stage` only. | ACE team |',
    ].join('\n');
    expect(clean(changelog)).toEqual([]);

    // …and the same row still counts outside a Changelog heading, because the
    // date-stamped row shape is itself the signal.
    expect(
      clean('| 2026-09-05 | covered `atomic-visit` / `focus-group` / `multi-stage` only. | ACE |'),
    ).toEqual([]);
  });

  it('class 3 — a complete enumeration a delimiter regex would split', () => {
    // Verbatim from skills/README.md. A naive delimiter run breaks on `and`
    // and reads this as 3-of-4. It is complete.
    expect(
      clean(
        'The 4 current archetypes are `atomic-visit`, `longitudinal-visits`, `focus-group`, and `multi-stage`.',
      ),
    ).toEqual([]);
  });

  it('class 4 — an enumeration wrapped across a line break, exception named outside it', () => {
    // Verbatim shape from skills/solicitation-create/SKILL.md:612-613.
    // Line-at-a-time matching reports it stale; it is not.
    const wrapped = [
      'For every archetype except `focus-group` (`atomic-visit`,',
      '`multi-stage`, `longitudinal-visits`), derive the axes from the PDD.',
    ].join('\n');
    expect(clean(wrapped)).toEqual([]);

    // Verbatim shape from agents/synthetic-data-and-workflows.md:70-77: the
    // exception sits several lines ABOVE the run, in the same paragraph.
    const exceptionAbove = [
      'Do NOT run the pipeline below for `focus-group`. **For every other archetype —',
      '`atomic-visit`, `multi-stage`, `longitudinal-visits`, and any archetype added',
      'later — proceed.**',
    ].join('\n');
    expect(clean(exceptionAbove)).toEqual([]);
  });

  it('a two-archetype contrast is below the threshold even when glue-delimited', () => {
    // "A or B" is how you compare two things. Three is a set; two is a
    // contrast — the calibration that took the scan from 43 noisy files to 16.
    expect(ENUMERATION_THRESHOLD).toBe(3);
    expect(clean('For `atomic-visit` or `focus-group`, capture the consent screen.')).toEqual([]);
  });

  it('an "archetype-agnostic" section that mentions two as examples is not an enumeration', () => {
    // Verbatim shape from skills/opp-eval/SKILL.md:302.
    const agnostic = [
      '## Archetypes',
      '',
      '**This skill is archetype-agnostic by design.** Recommendations land in the right',
      'domain vocabulary (e.g. "tighten the FGD facilitator instructions" for `focus-group`',
      'vs. "tighten the visit-flow prompt" for `atomic-visit`).',
    ].join('\n');
    expect(clean(agnostic)).toEqual([]);
  });

  it('does not match an archetype name inside a longer hyphenated token', () => {
    expect(clean('The `non-atomic-visitor` and `multi-stagecoach` and `focus-grouping` cases.')).toEqual(
      [],
    );
  });

  it('docs/ is out of scope, and the reason is structural', () => {
    // `docs/superpowers/{specs,plans}/` are date-stamped records of a decision
    // AT A TIME — the same argument as the changelog exclusion. Including them
    // costs 7 findings across 5 files, every one of them frozen history.
    expect(GUIDANCE_ROOTS).not.toContain('docs');
    expect(GUIDANCE_ROOTS).toContain('skills');
  });
});
