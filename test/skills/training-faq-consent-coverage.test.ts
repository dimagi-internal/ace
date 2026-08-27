/**
 * `training-faq` must own a consent-coverage obligation, and it must be keyed
 * on the PDD rather than on the archetype (dimagi-internal/ace#1687).
 *
 * The defect: consent reached the FAQ only through step 5's `focus-group`
 * category set ("Facilitation & Consent"). For `atomic-visit` and
 * `multi-stage` — the default, and the majority of opps — nothing in the skill
 * required the topic at all, so coverage depended on a consent question
 * happening to survive the seeding in steps 2-4.
 *
 * On `hh-poverty-targeting/20260824-1404` none did. A case-insensitive scan of
 * the published FAQ for "consent" returned ZERO hits across 11,822 characters,
 * on an `atomic-visit` PDD that mentions consent 35 times, mandates a
 * six-element read-aloud script in § 7.5, and makes refusal one of three
 * non-payable visit outcomes. An upstream test prompt about the script went
 * unanswered. The independent `training-faq-eval` caught it; nothing inside
 * the producing skill did, and `comprehensiveness` had scored the document as
 * covering the consent gate.
 *
 * SCOPE: this asserts the skill DECLARES the obligation and cites a real
 * trigger — the contract, not the output. Whether any particular FAQ actually
 * covers consent is graded per-run by `training-faq-eval`'s BLOCKER rule; a
 * unit test cannot see a run's Drive artifacts. What it CAN prevent is the
 * obligation being dropped, softened to advice, or re-narrowed to one
 * archetype, which is how the gap existed in the first place.
 *
 * Deliberately generic: the rule under test is "cover the consent protocol the
 * PDD declares", never "cover the Nigeria PPI consent script". A skill that
 * hardcoded this opportunity's specifics would fail the last assertion.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FAQ = path.join(REPO_ROOT, 'skills/training-faq/SKILL.md');
const FAQ_EVAL = path.join(REPO_ROOT, 'skills/training-faq-eval/SKILL.md');

const faq = fs.readFileSync(FAQ, 'utf8');
const faqEval = fs.readFileSync(FAQ_EVAL, 'utf8');

describe('training-faq owns a consent-coverage obligation', () => {
  it('states the obligation in REQUIRED language, not as a suggestion', () => {
    // "must" + "consent" in one sentence somewhere in the Process section.
    const process = faq.slice(faq.indexOf('## Process'));
    const required = /consent[^.]*\bmust\b|\bmust\b[^.]*consent/i.test(process);
    expect(
      required,
      'skills/training-faq/SKILL.md § Process never states a REQUIRED consent obligation. ' +
        'Advice does not survive a run under load — that is exactly how a consent-free FAQ ' +
        'shipped on hh-poverty-targeting/20260824-1404 (ace#1687).',
    ).toBe(true);
  });

  it('keys the obligation on a real, citable trigger rather than re-deriving one', () => {
    // The trigger is shared with the build and the Deliver-app eval. Citing it
    // is what keeps the three from drifting; restating it is what let the
    // Deliver-side trigger drift once already (ace#1137).
    expect(
      faq.includes('consent-script-floor'),
      'skills/training-faq/SKILL.md must cite `_app-component-library.md § consent-script-floor` ' +
        'as the trigger. Its clauses are evaluated independently and can fire on a PDD that ' +
        'never uses the word "consent" — a locally-invented trigger will miss those.',
    ).toBe(true);
  });

  it('covers BOTH the script and the refusal/withdrawal path', () => {
    // One entry naming the script is not coverage. The question a worker
    // actually has mid-visit is what to do when the answer is no — and on the
    // live miss, refusal was one of three non-payable visit outcomes.
    const hasRefusalPath = /refus|withdraw|declin/i.test(faq);
    expect(
      hasRefusalPath,
      'skills/training-faq/SKILL.md names a consent obligation but never the refusal / ' +
        'withdrawal path. "What do I do when they say no" is the worker-facing half.',
    ).toBe(true);
  });

  it('does not gate the obligation on the archetype', () => {
    // The regression shape: consent living only inside the focus-group branch.
    // Assert the skill says in so many words that the category set does not
    // decide whether consent is covered.
    const decouples =
      /where consent is filed, never whether it is covered/i.test(faq) ||
      /not an archetype question/i.test(faq);
    expect(
      decouples,
      'skills/training-faq/SKILL.md must state that the archetype category set changes WHERE ' +
        'consent is filed, not WHETHER it is covered. Consent previously appeared only in the ' +
        'focus-group branch, so every atomic-visit and multi-stage opp was uncovered.',
    ).toBe(true);
  });

  it('stays general — no opportunity-specific consent content baked into the skill', () => {
    // The rule is "cover the consent protocol the PDD declares". A skill that
    // hardcoded the opp that surfaced the bug would pass every assertion above
    // and still be wrong for every other opportunity.
    const leaks = ['Nigeria', 'PPI', 'poverty scorecard'].filter((t) =>
      new RegExp(`\\b${t}\\b`, 'i').test(faq),
    );
    expect(
      leaks,
      `skills/training-faq/SKILL.md leaks opportunity-specific content (${leaks.join(', ')}). ` +
        'The rule is "cover the consent protocol the PDD declares", not this opp\'s script. ' +
        'Cite the run only as evidence in the Change Log.',
    ).toEqual([]);
  });
});

describe('training-faq-eval grades the same obligation', () => {
  it('makes an absent consent protocol a BLOCKER', () => {
    // Build-emit and eval-grade are deliberately symmetric across ACE. The
    // producer requiring something the grader does not check is how the
    // Deliver-side consent trigger drifted apart once already (ace#1137).
    const hardDeducts = faqEval.slice(faqEval.indexOf('**Hard-deduct rules:**'));
    const blocks = /consent[\s\S]{0,400}?BLOCKER/i.test(hardDeducts);
    expect(
      blocks,
      'skills/training-faq-eval/SKILL.md § Hard-deduct rules must make a missing consent ' +
        'protocol a BLOCKER, mirroring training-faq § step 4b. A producer obligation the ' +
        'grader does not enforce drifts silently.',
    ).toBe(true);
  });

  it('cites the same trigger the producer does', () => {
    expect(
      faqEval.includes('consent-script-floor'),
      'skills/training-faq-eval/SKILL.md must fire on the same ' +
        '`_app-component-library.md § consent-script-floor` trigger as the producer.',
    ).toBe(true);
  });
});
