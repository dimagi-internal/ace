/**
 * Unit tests for static QA checks in skills/pdd-to-work-order-qa/checks.ts.
 *
 * Each check is a pure function. Tests use the fixture files under
 * test/skills/pdd-to-work-order-qa/fixtures/ for realistic full-document
 * coverage, plus small inline strings to exercise individual branches.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  checkAllRequiredSectionsPresent,
  checkRequiredWoDecisionsPresent,
  checkPeriodOfPerformanceComplete,
  checkPaymentScheduleSumsTo100,
  checkTotalNtePresent,
  checkSignatureBlocksPresent,
  checkArchetypeAppropriateScope,
  checkNoScaffoldingMarkers,
  checkNoRendererInstructions,
  checkPaymentUnitMatchesEntityGrain,
  normalizeDriveExport,
  CHECKS,
} from '../../../skills/pdd-to-work-order-qa/checks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

const GOOD_WO = readFileSync(join(FIXTURES, 'good-work-order.md'), 'utf8');
const MISSING_SECTIONS_WO = readFileSync(join(FIXTURES, 'missing-sections.md'), 'utf8');
const BAD_PAYMENT_WO = readFileSync(join(FIXTURES, 'bad-payment-schedule.md'), 'utf8');
const GOOD_DECISIONS = readFileSync(join(FIXTURES, 'good-decisions.yaml'), 'utf8');
const MISSING_WO_DECISIONS = readFileSync(join(FIXTURES, 'missing-wo-decisions.yaml'), 'utf8');

// Real gdoc-as-plain-text exports — what Drive returns at runtime for the
// work-order doc and decisions.yaml after the skill renders them.
// Captured 2026-05-21 from malaria-itn-app/20260521-1025. Lines use \r\n
// endings; headings have no `##` prefix; tables use tab separators.
const GDOC_WO = readFileSync(join(FIXTURES, 'gdoc-work-order.txt'), 'utf8');

// The SAME work order as a `text/markdown` gdoc export — Drive's markdown
// exporter escapes markdown-significant punctuation and renders tables as
// pipe tables. Captured 2026-08-23 from the live artifact
// `1_Dzp2ND_qDI2m9hMr_q2qf2VIIUsbR11ElM4cNRHQww` (revision 11) named in
// dimagi-internal/ace#1609 — real ground truth, not a hand-written
// approximation of Drive's escaping rules.
const GDOC_WO_MARKDOWN = readFileSync(join(FIXTURES, 'gdoc-work-order-markdown.txt'), 'utf8');

// The SAME document again, via the `text/plain` export the skill mandates —
// the paired half of the fixture above. Both were captured from revision 11
// in the same breath, so any check that disagrees between the two is
// disagreeing about the EXPORT, never about the content.
const GDOC_WO_PLAIN = readFileSync(join(FIXTURES, 'gdoc-work-order-plain.txt'), 'utf8');
const GDOC_DECISIONS = readFileSync(join(FIXTURES, 'gdoc-decisions.txt'), 'utf8');

describe('checkAllRequiredSectionsPresent', () => {
  test('passes for the good fixture (all 11 sections)', () => {
    const r = checkAllRequiredSectionsPresent(GOOD_WO);
    expect(r.pass).toBe(true);
  });

  test('fails for missing-sections fixture (payment terms removed)', () => {
    const r = checkAllRequiredSectionsPresent(MISSING_SECTIONS_WO);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Payment Terms|Total Not-to-Exceed|Payment Schedule/i);
    expect(r.auto_fix_hint).toBeTruthy();
  });
});

describe('checkRequiredWoDecisionsPresent', () => {
  test('passes for good-decisions.yaml (all four wo-* rows)', () => {
    const r = checkRequiredWoDecisionsPresent(GOOD_DECISIONS);
    expect(r.pass).toBe(true);
  });

  test('fails when wo-total-not-to-exceed-usd and wo-payment-schedule-split missing', () => {
    const r = checkRequiredWoDecisionsPresent(MISSING_WO_DECISIONS);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('wo-total-not-to-exceed-usd');
    expect(r.detail).toContain('wo-payment-schedule-split');
    expect(r.auto_fix_hint).toBeTruthy();
  });
});

describe('checkPeriodOfPerformanceComplete', () => {
  test('passes for explicit "2026-05-22 to 2026-07-31"', () => {
    const r = checkPeriodOfPerformanceComplete(GOOD_WO);
    expect(r.pass).toBe(true);
  });

  test('passes for [TBD] placeholder', () => {
    const wo = GOOD_WO.replace('2026-05-22 to 2026-07-31', '[TBD]');
    expect(checkPeriodOfPerformanceComplete(wo).pass).toBe(true);
  });

  test('fails when scaffolding marker remains', () => {
    const wo = GOOD_WO.replace('2026-05-22 to 2026-07-31', '{{wo_period_of_performance}}');
    const r = checkPeriodOfPerformanceComplete(wo);
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when only one date is present', () => {
    const wo = GOOD_WO.replace('2026-05-22 to 2026-07-31', '2026-05-22');
    const r = checkPeriodOfPerformanceComplete(wo);
    expect(r.pass).toBe(false);
  });
});

describe('checkPaymentScheduleSumsTo100', () => {
  test('passes when 40% + 60% sum to 100', () => {
    const r = checkPaymentScheduleSumsTo100(GOOD_WO);
    expect(r.pass).toBe(true);
  });

  test('fails when 40% + 50% sum to 90', () => {
    const r = checkPaymentScheduleSumsTo100(BAD_PAYMENT_WO);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('90');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when payment schedule section is missing', () => {
    const r = checkPaymentScheduleSumsTo100(MISSING_SECTIONS_WO);
    expect(r.pass).toBe(false);
  });
});

describe('checkTotalNtePresent', () => {
  test('passes for "USD 2500" in section 6.1', () => {
    expect(checkTotalNtePresent(GOOD_WO).pass).toBe(true);
  });

  test('passes for "USD [TBD]" placeholder', () => {
    const wo = GOOD_WO.replace('USD 2500', 'USD [TBD]');
    expect(checkTotalNtePresent(wo).pass).toBe(true);
  });

  test('fails when section is missing entirely', () => {
    const r = checkTotalNtePresent(MISSING_SECTIONS_WO);
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('fails when USD has no value or placeholder', () => {
    const wo = GOOD_WO.replace('USD 2500', 'USD ');
    const r = checkTotalNtePresent(wo);
    expect(r.pass).toBe(false);
  });
});

describe('checkSignatureBlocksPresent', () => {
  test('passes when both Subcontractor and Dimagi blocks present', () => {
    expect(checkSignatureBlocksPresent(GOOD_WO).pass).toBe(true);
  });

  test('fails when Subcontractor block missing', () => {
    const wo = GOOD_WO.replace('**Subcontractor**', '');
    const r = checkSignatureBlocksPresent(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Subcontractor/i);
  });

  test('fails when Dimagi block missing', () => {
    const wo = GOOD_WO.replace('**Dimagi, Inc.**', '');
    const r = checkSignatureBlocksPresent(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Dimagi/i);
  });

  // Regression for jjackson/ace#706: the work-order template's Signatures
  // section is a 2-col Google Docs table whose two column headers live in the
  // SAME table row, so the gdoc plain-text export renders BOTH labels on ONE
  // tab-separated line. The old `^\s*X\s*$` (alone-on-a-line) alternative failed
  // on this shape and falsely reported both blocks missing.
  test('passes when both labels share one tab-separated row (gdoc 2-col header export, ace#706)', () => {
    const wo =
      'IN WITNESS WHEREOF, the parties hereto have caused this Work Order to be executed.\n\n' +
      'Subcontractor\tDimagi, Inc.\n' +
      'By: __________________________\tBy: __________________________\n' +
      'Name: [Partner Name]\tName: Lucina Tse\n';
    const r = checkSignatureBlocksPresent(wo);
    expect(r.pass).toBe(true);
  });
});

describe('checkArchetypeAppropriateScope', () => {
  // ── longitudinal-visits (ace#1462) ──────────────────────────────
  //
  // The archetype exists because a longitudinal programme can produce a
  // work order that reads exactly like an atomic-visit one — visits,
  // photos, GPS — while saying nothing about the entity being followed.
  // That is precisely what shipped for spark-facilitator: the PDD prose
  // was longitudinal-aware and the payment predicate was not. So the
  // gate has to REJECT an atomic-visit-shaped scope under this
  // archetype, not merely accept a good one.
  const LONGITUDINAL_SCOPE = (body: string) =>
    `## 2. Scope of Work\n\n${body}\n\n## 3. Deliverables\n`;

  test('rejects a scope that is indistinguishable from atomic-visit', () => {
    const wo = LONGITUDINAL_SCOPE(
      'The Subcontractor shall complete one visit per site, capturing a photo and GPS coordinate at each visit.',
    );
    const r = checkArchetypeAppropriateScope(wo, 'longitudinal-visits');
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/longitudinal marker/i);
  });

  test('accepts a scope naming the followed entity', () => {
    const wo = LONGITUDINAL_SCOPE(
      'The Subcontractor shall complete one visit per community meeting, capturing a photo and GPS ' +
      'coordinate, against each registered community case over the engagement.',
    );
    expect(checkArchetypeAppropriateScope(wo, 'longitudinal-visits').pass).toBe(true);
  });

  test('accepts a scope naming the sequence instead of the entity', () => {
    const wo = LONGITUDINAL_SCOPE(
      'Each visit records a photo and GPS fix; visits follow the published phase sequence and ' +
      'the follow-up cadence defined in the design document.',
    );
    expect(checkArchetypeAppropriateScope(wo, 'longitudinal-visits').pass).toBe(true);
  });

  test('still requires visit phrasing, not just a longitudinal word', () => {
    const wo = LONGITUDINAL_SCOPE(
      'The Subcontractor shall track each household case through its phases and report monthly.',
    );
    const r = checkArchetypeAppropriateScope(wo, 'longitudinal-visits');
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/visit/i);
  });

  // ── evidence mechanism is NOT an archetype property (ace#1771) ────
  //
  // The check used to require /photo|gps/ for both visit archetypes. The
  // regex had no polarity, so it failed in both directions on the SAME
  // document — verified live against bednet-check-2-visit/20260828-0629,
  // whose § 2 mentions photo/GPS exactly once, inside "The partner will
  // not:".
  //
  // (a) FALSE PASS — an exclusion satisfied the requirement, so QA
  //     asserted the contract carried photo/GPS evidence while the
  //     contract prohibited it.
  // (b) FALSE FAIL — delete that one exclusion bullet (a legitimate
  //     drafting choice) and the same contract FAILED, with an
  //     auto_fix_hint telling the producer to add photo/GPS language to a
  //     programme whose PDD puts photo/GPS out of scope. That is a checker
  //     instructing a producer to contradict its own design document.
  //
  // Both are now non-findings: the archetype check tests SHAPE only.

  const EXCLUSION_ONLY_SCOPE =
    'The Subcontractor shall complete one follow-up visit against each registered household case, ' +
    'recording the consent re-affirmation answer at the visit.\n\nThe partner will not:\n\n' +
    '* Collect photographs, GPS coordinates, or any biometric identifier.';

  test('(a) the verdict does not depend on an exclusion-bullet photo/GPS mention', () => {
    // The discriminator for the false PASS: the only difference between
    // these two documents is a prohibition bullet. A polarity-free
    // /photo|gps/ test reads that prohibition as satisfaction, so the two
    // verdicts diverge (pass vs fail) on a difference that changes nothing
    // about the archetype. They must now be identical.
    const withExclusion = LONGITUDINAL_SCOPE(EXCLUSION_ONLY_SCOPE);
    const withoutExclusion = LONGITUDINAL_SCOPE(
      EXCLUSION_ONLY_SCOPE.replace(/\n\nThe partner will not:[\s\S]*$/, ''),
    );
    expect(withExclusion).toMatch(/photographs/i);
    expect(withoutExclusion).not.toMatch(/photo|gps/i);

    const a = checkArchetypeAppropriateScope(withExclusion, 'longitudinal-visits');
    const b = checkArchetypeAppropriateScope(withoutExclusion, 'longitudinal-visits');
    expect(a).toEqual(b);
    expect(a.pass).toBe(true);
    // And the passing verdict must not cite photo/GPS as the reason.
    expect(JSON.stringify(a)).not.toMatch(/photo|gps/i);
  });

  test('(b) a photo-free programme passes, and is never told to add photo/GPS', () => {
    // Same scope with the exclusion bullet removed: a visit-shaped,
    // consent-attested programme that simply never mentions photo or GPS.
    const photoFree = EXCLUSION_ONLY_SCOPE.replace(
      /\n\nThe partner will not:[\s\S]*$/,
      '',
    );
    expect(photoFree).not.toMatch(/photo|gps/i);
    const r = checkArchetypeAppropriateScope(LONGITUDINAL_SCOPE(photoFree), 'longitudinal-visits');
    expect(r.pass).toBe(true);
    expect(r.auto_fix_hint ?? '').not.toMatch(/Missing markers.*photo/i);
  });

  test('(b) atomic-visit likewise passes a photo-free scope', () => {
    const wo = LONGITUDINAL_SCOPE(
      'The Subcontractor shall complete one household visit per registered household, recording the ' +
      'consent answer and the two bednet-use observations at the visit.',
    );
    expect(wo).not.toMatch(/photo|gps/i);
    expect(checkArchetypeAppropriateScope(wo, 'atomic-visit').pass).toBe(true);
  });

  test('the auto_fix_hint never instructs a producer to add photo/GPS evidence', () => {
    // A scope that genuinely fails (no visit-shaped unit at all) must not
    // recover by being told to bolt on an evidence mechanism the PDD may
    // put out of scope.
    const wo = LONGITUDINAL_SCOPE(
      'The Subcontractor shall track each household case through its phases and report monthly.',
    );
    const r = checkArchetypeAppropriateScope(wo, 'longitudinal-visits');
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
    expect(r.auto_fix_hint!).not.toMatch(/needs .*photo\/GPS/i);
    expect(r.detail!).not.toMatch(/missing.*photo or GPS/i);
  });

  test('names all four archetypes when the value is unknown', () => {
    const r = checkArchetypeAppropriateScope(GOOD_WO, 'nonsense-archetype');
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('longitudinal-visits');
  });

  test('atomic-visit passes when scope mentions per-visit + photo/GPS', () => {
    const r = checkArchetypeAppropriateScope(GOOD_WO, 'atomic-visit');
    expect(r.pass).toBe(true);
  });

  test('atomic-visit fails when scope lacks any visit-shaped unit-of-work phrasing', () => {
    // Strip every form of "visit" out of the scope section so the check
    // sees no atomic-visit signal at all. The check loosened over time:
    // it used to require exactly "per visit"; now it accepts any usage of
    // "visit" as the unit-of-work, differentiating from focus-group by
    // absence of session/attestation/gdoc language. To force a failure we
    // have to remove every visit appearance.
    const wo = GOOD_WO.replace(/visits?\b/gi, 'engagements');
    const r = checkArchetypeAppropriateScope(wo, 'atomic-visit');
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('focus-group passes when scope mentions per-session + gdoc', () => {
    const wo = GOOD_WO.replace(
      /## 2. Scope of Work[\s\S]*?## 3\./,
      `## 2. Scope of Work\n\nThe Partner facilitates one focus-group session per session, capturing notes in a gdoc and ending with an attestation form.\n\n## 3.`,
    );
    const r = checkArchetypeAppropriateScope(wo, 'focus-group');
    expect(r.pass).toBe(true);
  });

  test('focus-group fails when no per-session/attestation phrasing', () => {
    const r = checkArchetypeAppropriateScope(GOOD_WO, 'focus-group');
    expect(r.pass).toBe(false);
  });

  test('multi-stage passes when scope mentions stages', () => {
    const wo = GOOD_WO.replace(
      /## 2. Scope of Work[\s\S]*?## 3\./,
      `## 2. Scope of Work\n\nThe intervention runs across stage 1, stage 2, and stage 3 of the care pathway, with one form per stage.\n\n## 3.`,
    );
    const r = checkArchetypeAppropriateScope(wo, 'multi-stage');
    expect(r.pass).toBe(true);
  });

  test('multi-stage fails when no stage phrasing', () => {
    const r = checkArchetypeAppropriateScope(GOOD_WO, 'multi-stage');
    expect(r.pass).toBe(false);
  });
});

describe('checkNoScaffoldingMarkers', () => {
  test('passes when no <<...>> markers remain', () => {
    expect(checkNoScaffoldingMarkers(GOOD_WO).pass).toBe(true);
  });

  test('fails when a <<placeholder>> marker leaked through', () => {
    const wo = GOOD_WO + '\n\n<<unfilled_placeholder>> leaked here.\n';
    const r = checkNoScaffoldingMarkers(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('<<unfilled_placeholder>>');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('lists deduplicated markers when several appear', () => {
    const wo = GOOD_WO + '\n\n<<a>> and <<a>> and <<b>>.\n';
    const r = checkNoScaffoldingMarkers(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('<<a>>');
    expect(r.detail).toContain('<<b>>');
    // dedup: <<a>> appears once in detail
    expect((r.detail!.match(/<<a>>/g) || []).length).toBe(1);
  });

  test('fails when an unfilled {{...}} template token leaked through (jjackson/ace#833)', () => {
    const wo = GOOD_WO + '\n\nEthics: {{ethics_body}} to be observed.\n';
    const r = checkNoScaffoldingMarkers(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('{{ethics_body}}');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('flags both marker families together', () => {
    const wo = GOOD_WO + '\n\n<<producer_note>> and {{scope_will_body}} both leaked.\n';
    const r = checkNoScaffoldingMarkers(wo);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('<<producer_note>>');
    expect(r.detail).toContain('{{scope_will_body}}');
  });
});

describe('CHECKS array', () => {
  test('exports ten checks in canonical order', () => {
    expect(CHECKS).toHaveLength(10);
    const ids = CHECKS.map((c) => c.id);
    expect(ids).toEqual([
      'all_required_sections_present',
      'required_wo_decisions_present',
      'period_of_performance_complete',
      'payment_schedule_sums_to_100',
      'total_nte_present',
      'signature_blocks_present',
      'archetype_appropriate_scope',
      'no_renderer_instructions',
      'no_scaffolding_markers',
      'payment_unit_matches_entity_grain',
    ]);
  });
});

// ─── Gdoc-as-plain-text regression suite ────────────────────────────
// Why this exists: the markdown-fixture tests above all pass with the
// regexes that require `##` heading prefixes and `|` table separators.
// But at runtime the skill reads its artifacts as Drive plain-text exports
// (no `##`, tab-separated tables, bare signature headings). The first
// live-artifact smoke test surfaced 5 of 8 checks falsely failing because
// the regexes were too strict. These tests pin both forms.

describe('runtime gdoc-as-plain-text exports', () => {
  test('checkAllRequiredSectionsPresent passes against the real gdoc export', () => {
    const r = checkAllRequiredSectionsPresent(GDOC_WO);
    expect(r.pass).toBe(true);
  });

  test('checkRequiredWoDecisionsPresent passes against the real decisions.yaml gdoc export', () => {
    const r = checkRequiredWoDecisionsPresent(GDOC_DECISIONS);
    expect(r.pass).toBe(true);
  });

  test('checkPeriodOfPerformanceComplete passes against the real gdoc export', () => {
    const r = checkPeriodOfPerformanceComplete(GDOC_WO);
    expect(r.pass).toBe(true);
  });

  test('checkPaymentScheduleSumsTo100 passes against the real gdoc export', () => {
    const r = checkPaymentScheduleSumsTo100(GDOC_WO);
    expect(r.pass).toBe(true);
  });

  test('checkTotalNtePresent passes against the real gdoc export', () => {
    const r = checkTotalNtePresent(GDOC_WO);
    expect(r.pass).toBe(true);
  });

  test('checkSignatureBlocksPresent passes against the real gdoc export', () => {
    const r = checkSignatureBlocksPresent(GDOC_WO);
    expect(r.pass).toBe(true);
  });

  test('checkArchetypeAppropriateScope passes against the real gdoc export (atomic-visit)', () => {
    const r = checkArchetypeAppropriateScope(GDOC_WO, 'atomic-visit');
    expect(r.pass).toBe(true);
  });

  test('checkNoScaffoldingMarkers passes against the real gdoc export', () => {
    const r = checkNoScaffoldingMarkers(GDOC_WO);
    expect(r.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1092 — the period_of_performance auto_fix_hint must
// describe a placeholder form that actually passes the check. The pre-#1092
// hint said "use an explicit `[TBD]` placeholder", which read naturally as
// inviting `[Start date TBD] to [End date TBD]` — a form the whole-cell
// single-bracket regex rejects, burning a second auto-fix cycle on a hint
// the producer followed.
// ---------------------------------------------------------------------------

describe('period_of_performance auto_fix_hint is actionable (#1092)', () => {
  const failing = () => {
    const wo = GOOD_WO.replace('2026-05-22 to 2026-07-31', '14 weeks from contract execution');
    const res = checkPeriodOfPerformanceComplete(wo);
    expect(res.pass).toBe(false);
    return res;
  };

  test('the hint states the accepted placeholder form: one pair of brackets spanning the whole cell', () => {
    const res = failing();
    expect(res.auto_fix_hint).toMatch(/one pair of brackets|single bracketed placeholder/i);
  });

  test('every bracketed exemplar quoted in the hint itself passes the check', () => {
    // A hint that quotes an exemplar the checker rejects is always a bug —
    // this pins hint and checker together so they cannot drift.
    const res = failing();
    const exemplars = [...res.auto_fix_hint!.matchAll(/`(\[[^`]+\])`/g)].map((m) => m[1]);
    expect(exemplars.length).toBeGreaterThan(0);
    for (const ex of exemplars) {
      const fixed = GOOD_WO.replace('2026-05-22 to 2026-07-31', ex);
      expect(checkPeriodOfPerformanceComplete(fixed).pass).toBe(true);
    }
  });

  test('the compositional form the old hint invited still fails (interior `]`)', () => {
    const wo = GOOD_WO.replace('2026-05-22 to 2026-07-31', '[Start date TBD] to [End date TBD]');
    expect(checkPeriodOfPerformanceComplete(wo).pass).toBe(false);
  });
});

/**
 * dimagi-internal/ace#1004 — scaffolding that does not LOOK like scaffolding.
 *
 * The live WORK_ORDER_TEMPLATE_ID ended § 6.2 Payment Schedule with a
 * hardcoded, non-tokenized sentence:
 *
 *   "Dimagi will pay only for verified units at the per-visit (or per-session,
 *    per archetype) rate proposed in the partner's solicitation response."
 *
 * "(or per-session, per archetype)" is an instruction to the RENDERER about
 * which archetype branch to pick, and it rendered verbatim into a signed
 * contract. A partner reading their own work order saw a parenthetical telling
 * them their payment unit depends on an "archetype" defined nowhere in the
 * document.
 *
 * Every existing preventer passed it, and for the same reason: it is not a
 * `{{token}}` and not a `<<marker>>`. `no_scaffolding_markers` matches only
 * those two forms; the skill's own token-coverage check (§ Process step 5, the
 * ace#819 preventer) scans for surviving `{{` only. QA returned 8/8 pass with
 * the defect present, on run hh-poverty-targeting/20260728-0705.
 *
 * The template half is fixed (the sentence is now `{{payment_unit_closing}}`);
 * this is the half that keeps it fixed. Closing an issue deletes its memory —
 * a test does not.
 */
describe('no renderer instructions in the delivered contract (#1004)', () => {
  const wrap = (s: string) => `## 6. Payment\n\n### 6.2 Payment Schedule\n\n${s}\n`;

  test('catches the live sentence', () => {
    const r = checkNoRendererInstructions(
      wrap(
        "Dimagi will pay only for verified units at the per-visit (or per-session, per archetype) " +
          "rate proposed in the partner's solicitation response.",
      ),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/per archetype/i);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('catches an archetype-alternation parenthetical without the word "archetype"', () => {
    const r = checkNoRendererInstructions(
      wrap('Payment is made per visit (or per session) on verification.'),
    );
    expect(r.pass).toBe(false);
  });

  test('catches renderer TODOs that survived templating', () => {
    for (const s of ['TBD-by-renderer', 'TODO: pick one', 'FIXME before sending']) {
      expect(checkNoRendererInstructions(wrap(s)).pass, s).toBe(false);
    }
  });

  // ace#1484 — cross-check contradiction. Checks 3 and 5 tell the producer to
  // write `[TBD]`; check 9 used to fail the document for containing it, so
  // following one check's own auto_fix_hint guaranteed the other's blocker and
  // the Phase-1 loop oscillated until it halted `incomplete`. These assertions
  // pin BOTH directions so the two checks can't drift apart again.
  test('accepts [TBD] — the placeholder checks 3 and 5 recommend', () => {
    for (const s of ['USD [TBD]', 'Period of Performance | [TBD]', 'the cap is [tbd]']) {
      expect(checkNoRendererInstructions(wrap(s)).pass, s).toBe(true);
    }
  });

  test('still rejects a bare TBD, and brackets do not launder a renderer tell', () => {
    for (const s of ['TBD', 'rate is TBD', '[TBD-by-renderer]', '[TODO: pick one]']) {
      expect(checkNoRendererInstructions(wrap(s)).pass, s).toBe(false);
    }
  });

  test("check 5's auto_fix_hint does not recommend a string check 9 rejects", () => {
    // The literal cross-check: take every placeholder check 5 hands the
    // producer and run it through check 9. Any hint that fails here is the
    // ace#1484 defect reappearing.
    const missing = checkTotalNtePresent(MISSING_SECTIONS_WO);
    expect(missing.auto_fix_hint).toBeTruthy();
    const recommended = [...(missing.auto_fix_hint ?? '').matchAll(/`([^`]*TBD[^`]*)`/gi)].map(
      (m) => m[1],
    );
    expect(recommended.length).toBeGreaterThan(0);
    for (const s of recommended) {
      expect(checkNoRendererInstructions(wrap(s)).pass, `check 5 recommends "${s}"`).toBe(true);
    }
  });

  test('passes the corrected single-unit sentence', () => {
    const r = checkNoRendererInstructions(
      wrap(
        "Dimagi will pay only for verified units at the per-visit rate proposed in the partner's " +
          'solicitation response.',
      ),
    );
    expect(r.pass).toBe(true);
  });

  test('does not fire on an ordinary parenthetical', () => {
    for (const s of [
      'Payment is made per verified visit (see § 4.1 for the verification criteria).',
      'The partner may invoice monthly (or quarterly, at their discretion).',
      'Each household visit is one unit.',
    ]) {
      expect(checkNoRendererInstructions(wrap(s)).pass, s).toBe(true);
    }
  });

  test('passes the good fixture — this must not become the always-fires check', () => {
    expect(checkNoRendererInstructions(GOOD_WO).pass).toBe(true);
  });
});

// ── Export-format independence (dimagi-internal/ace#1609) ──────────
//
// `SKILL.md` § Process step 1 mandates `exportAs: 'text/plain'`. Its sibling
// QA skill `idea-to-pdd-qa` mandates the OPPOSITE (`text/markdown`, REQUIRED),
// and both run in the same Phase 1 — so an agent carrying the sibling's
// convention across reads the work order as markdown.
//
// When it did, this document — which is CORRECT and scores 9/9 on the
// text/plain export — scored 4/9, and the five spurious failures' auto_fix
// hints instructed the producer to regenerate a sound contract to fix a
// reader bug. These tests pin the CLASS: the checks must agree on the same
// document regardless of which export the caller used.
describe('export-format independence (ace#1609)', () => {
  const ctx = { decisionsYaml: GDOC_DECISIONS, archetype: 'longitudinal-visits' };

  test('normalizeDriveExport strips markdown-export punctuation escaping', () => {
    expect(normalizeDriveExport('## **1\\. Background**')).toBe('## **1. Background**');
    expect(normalizeDriveExport('\\[Start\\] to \\[End \\+ 8 weeks\\]')).toBe(
      '[Start] to [End + 8 weeks]',
    );
    expect(normalizeDriveExport('run\\_id')).toBe('run_id');
  });

  test('leaves a non-punctuation escape alone (not a markdown escape)', () => {
    expect(normalizeDriveExport('a\\nb')).toBe('a\\nb');
  });

  test('the markdown export of a healthy work order passes every check', async () => {
    const failures: string[] = [];
    for (const check of CHECKS) {
      if (!(await check.run(GDOC_WO_MARKDOWN, ctx)).pass) failures.push(check.id);
    }
    expect(failures).toEqual([]);
  });

  test('markdown and plain-text exports of the same document agree check-for-check', async () => {
    for (const check of CHECKS) {
      expect(
        (await check.run(GDOC_WO_MARKDOWN, ctx)).pass,
        `${check.id} disagrees between the markdown and plain-text exports`,
      ).toBe((await check.run(GDOC_WO_PLAIN, ctx)).pass);
    }
  });

  test.each([
    ['all_required_sections_present', checkAllRequiredSectionsPresent],
    ['period_of_performance_complete', checkPeriodOfPerformanceComplete],
    ['payment_schedule_sums_to_100', checkPaymentScheduleSumsTo100],
    ['total_nte_present', checkTotalNtePresent],
    ['signature_blocks_present', checkSignatureBlocksPresent],
  ] as const)(
    '%s passes on the markdown export (was a spurious blocker pre-fix)',
    (_id, fn) => {
      expect(fn(GDOC_WO_MARKDOWN).pass).toBe(true);
    },
  );

  // The pipe-cell tolerance added for the markdown signature table must not
  // turn the Roles and Responsibilities header row (`| Activity | Partner |
  // Dimagi |`) into a signature block.
  test('a pipe-table cell naming bare "Dimagi" is not a signature block', () => {
    const r = checkSignatureBlocksPresent(
      '## Roles and Responsibilities\n| Activity | Partner | Dimagi |\n| Recruit | Yes | No |\n',
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Dimagi/i);
  });
});

// ─── payment_unit_matches_entity_grain (dimagi-internal/ace#1946) ────
// The PDD-side counterpart is `idea-to-pdd-qa § payment_unit_matches_entity_grain`
// (ace#1420). That check gates the PDD; nothing gated the Work Order, so the
// producer skill's own archetype template could — and did — put the per-visit
// wording back into the document that actually gets signed, and this QA
// returned 9/9 with the contradiction present
// (bednet-check-2-visit/20260902-1555).

// A § 6.2 closing sentence quoting a per-VISIT rate. Verbatim shape of the
// defect as rendered on that run.
const WO_PER_VISIT_RATE = `
## 6. Payment Terms

### 6.2 Payment Schedule

Dimagi will pay only for verified units at the per-visit rate proposed in the
partner's solicitation response.
`;

// The same sentence re-derived per worker-day, as it was corrected in-run.
const WO_PER_DAY_RATE = `
## 6. Payment Terms

### 6.2 Payment Schedule

Dimagi will pay only for verified units at the per-day rate proposed in the
partner's solicitation response, for each verified follow-up day.
`;

// A PDD whose § Program Parameters pins entity_id to worker + encounter date,
// so Connect resolves ONE payable unit per worker-day.
const PDD_DAY_GRAIN = `
## Program Parameters

| Key | Value |
|---|---|
| payment_rate_min | 2.00 |
| payment_rate_max | 4.00 |
| entity_id_grain | worker username + encounter date |
`;

// A PDD whose entity_id resolves one payable unit per visit.
const PDD_VISIT_GRAIN = `
## Program Parameters

| Key | Value |
|---|---|
| entity_id_grain | one entity per household visit |
`;

describe('checkPaymentUnitMatchesEntityGrain (work order)', () => {
  test('FAILS a per-visit rate sentence against a per-worker-day entity_id_grain', () => {
    const r = checkPaymentUnitMatchesEntityGrain(WO_PER_VISIT_RATE, {
      pddText: PDD_DAY_GRAIN,
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/visit/i);
    expect(r.detail).toMatch(/day/i);
    expect(r.auto_fix_hint).toBeTruthy();
  });

  test('passes once the rate sentence is re-derived per worker-day', () => {
    const r = checkPaymentUnitMatchesEntityGrain(WO_PER_DAY_RATE, {
      pddText: PDD_DAY_GRAIN,
    });
    expect(r.pass).toBe(true);
  });

  test('passes a per-visit rate when the grain really is per-visit', () => {
    const r = checkPaymentUnitMatchesEntityGrain(WO_PER_VISIT_RATE, {
      pddText: PDD_VISIT_GRAIN,
    });
    expect(r.pass).toBe(true);
  });

  test('accepts an explicit ctx.entityIdGrain without a PDD body', () => {
    const r = checkPaymentUnitMatchesEntityGrain(WO_PER_VISIT_RATE, {
      entityIdGrain: 'worker username + encounter date',
    });
    expect(r.pass).toBe(false);
  });

  test('catches the contradiction from the work order alone, with no PDD context', () => {
    // The rendered § 6.2 carried BOTH statements. No --pdd needed to see it.
    const selfContradicting = `${WO_PER_VISIT_RATE}
For the avoidance of doubt, the payable unit under this Work Order is a
worker-day, not an individual visit.
`;
    const r = checkPaymentUnitMatchesEntityGrain(selfContradicting);
    expect(r.pass).toBe(false);
  });

  test('skips silently when no grain is available anywhere', () => {
    const r = checkPaymentUnitMatchesEntityGrain(WO_PER_VISIT_RATE);
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/not applicable|no entity_id_grain/i);
  });

  test('does not read an invoice payment window as a day-scoped grain', () => {
    const wo = `${WO_PER_VISIT_RATE}
Dimagi will settle each approved payable unit within 30 days of invoice receipt.
`;
    const r = checkPaymentUnitMatchesEntityGrain(wo);
    expect(r.pass).toBe(true);
  });

  test('passes the good fixture (no rate-unit/grain conflict)', () => {
    const r = checkPaymentUnitMatchesEntityGrain(GOOD_WO, { pddText: PDD_VISIT_GRAIN });
    expect(r.pass).toBe(true);
  });

  test('passes the real gdoc plain-text export', () => {
    const r = checkPaymentUnitMatchesEntityGrain(GDOC_WO_PLAIN, { pddText: PDD_VISIT_GRAIN });
    expect(r.pass).toBe(true);
  });
});
