/**
 * Class-level preventer for dimagi-internal/ace#1667.
 *
 * `app-screenshot-capture` § Step 5's Deliver gate used to assert
 * `approved >= 1` unconditionally, and to justify it with a premise that is
 * false: that this "is the criterion `app-test-cases.yaml` declares (*one
 * payment unit registers*)". No such criterion exists — neither the producer
 * skill nor any emitted artifact contains `approved` or that phrase:
 *
 *   $ grep -rn -i "payment unit registers\|approved" \
 *       skills/app-test-cases/SKILL.md \
 *       test/fixtures/ACE-Test-001/3-commcare/app-test-cases.yaml
 *   (no matches, exit 1)
 *
 * Worse, `approved >= 1` is STRUCTURALLY UNREACHABLE on any opportunity whose
 * `deliver_unit_checks[].duration_minutes` floor exceeds a machine-speed
 * Maestro walk: Connect correctly REJECTS the sub-floor visit. On
 * hh-poverty-targeting/20260824-1404 the walk took 287 s against a 360 s
 * floor, `connect_get_deliver_progress` returned
 * `{delivered: 1, approved: 0, rejected: 1}`, and the SKILL routed that
 * correct behaviour to `delivered-but-rejected` — "a real finding about the
 * opportunity's verification wiring". It is not a finding. And the fix an
 * operator would reach for (relax the duration floor) would break the very
 * PDD control the floor exists to enforce.
 *
 * What must NOT be lost: `delivered >= 1` is the real end-to-end proof that
 * the Deliver→Connect path works (ace#1066), and
 * bednet-check-2-visit/20260825-1310 relied on this gate reading green. So
 * the rail is three-sided: `delivered >= 1` stays HARD, `approved >= 1`
 * becomes CONDITIONAL on the walk being able to clear the floor, and the
 * sub-floor rejection gets its own expected-outcome branch.
 *
 * The assertions are parsed out of the delimited `deliver-gate` block, not
 * the whole file, so a "fix" that only added rationale prose while leaving an
 * unconditional assertion in place would still fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL = fileURLToPath(
  new URL('../../skills/app-screenshot-capture/SKILL.md', import.meta.url),
);
const skill = readFileSync(SKILL, 'utf8');

const BEGIN = '<!-- deliver-gate:begin';
const END = '<!-- deliver-gate:end -->';

/** The `### Step 5: Run the smoke recipes` section (ends at `### Step 5.5`). */
function stepFive(): string {
  const parts = skill.split(/\n(?=### )/);
  const found = parts.find((p) => /^### Step 5:/.test(p));
  if (!found) throw new Error('### Step 5 section not found in app-screenshot-capture');
  return found;
}

/**
 * The normative Deliver-gate block. Guarding all of Step 5 would let a fix
 * that lived only in surrounding prose pass while the assertions stayed
 * unconditional; guarding this block pins the assertions themselves.
 * Normalised to one line so a match tests wording, not line-wrapping.
 */
function deliverGate(): string {
  const section = stepFive();
  const start = section.indexOf(BEGIN);
  const end = section.indexOf(END);
  expect(start, 'Step 5 must carry a delimited deliver-gate block').toBeGreaterThan(-1);
  expect(end, 'the deliver-gate block must be closed').toBeGreaterThan(start);
  return section.slice(start, end).replace(/\s+/g, ' ').trim();
}

/** Step 5 with the normative block removed — no stray assertion may live here. */
function stepFiveOutsideGate(): string {
  const section = stepFive();
  const start = section.indexOf(BEGIN);
  const end = section.indexOf(END);
  return (section.slice(0, start) + section.slice(end + END.length)).replace(/\s+/g, ' ');
}

describe('app-screenshot-capture Deliver gate — duration floor (ace#1667)', () => {
  it('keeps `delivered >= 1` a hard, unconditional assertion', () => {
    const gate = deliverGate();
    expect(gate).toMatch(/`delivered >= 1`[^.]{0,80}(HARD|unconditional)/i);
    // The end-to-end proof it stands for must stay named, so nobody
    // "simplifies" it away alongside the approved relaxation (ace#1066).
    expect(gate).toMatch(/not-delivered-on-connect/);
  });

  it('does not assert `approved >= 1` unconditionally', () => {
    const gate = deliverGate();
    // It must be explicitly marked conditional...
    expect(gate).toMatch(/`approved >= 1`[^.]{0,80}CONDITIONAL/i);
    // ...and the condition must be the floor-vs-elapsed comparison, not prose.
    expect(gate).toMatch(/duration_floor_seconds == 0/);
    expect(gate).toMatch(/walk_elapsed_seconds >= duration_floor_seconds/);
  });

  it('carries the expected-outcome branch for a sub-floor rejection', () => {
    const gate = deliverGate();
    expect(gate).toContain('rejected-by-duration-floor-as-designed');
    expect(gate).toMatch(/PASS-with-note/i);
    // Guarded by the measured comparison, not by vibes.
    expect(gate).toMatch(/walk_elapsed_seconds < duration_floor_seconds/);
    // And it must be distinguished from the genuine finding.
    expect(gate).toMatch(/NOT\s+`?delivered-but-rejected`?/i);
    expect(gate).toContain('delivered-but-rejected');
  });

  it('forbids the "fix" that would break the PDD control', () => {
    expect(deliverGate()).toMatch(/do not relax or remove the duration\s*floor/i);
  });

  it('says exactly where the measured walk elapsed comes from', () => {
    const gate = deliverGate();
    expect(gate).toMatch(/screenshots\[\]\.takenAt/);
    expect(gate).toMatch(/walk_elapsed_seconds\s*=/);
    // The two frames that bound the measurement.
    expect(gate).toMatch(/form-question/);
    expect(gate).toMatch(/post-submit frame/i);
  });

  it('says exactly how the duration floor is read, and does not invent a read-back atom', () => {
    const gate = deliverGate();
    expect(gate).toMatch(/deliver_unit_checks\[\]\.duration_minutes/);
    // Verified against docs/atom-schemas.md: connect_set_verification_flags is
    // write-only and connect_get_opportunity does not carry the field. A future
    // author must not paraphrase one into existence (CLAUDE.md § atom schemas).
    expect(gate).toMatch(/no read-back atom/i);
    expect(gate).toContain('connect_set_verification_flags');
    expect(gate).toContain('connect_get_opportunity');
    // The executable source: what this run itself wrote in Phase 4.
    expect(gate).toContain('cs-verification-flags');
    expect(gate).toMatch(/decisions\.yaml/);
    // And the no-floor default, so the branch is total.
    expect(gate).toMatch(/duration_floor_seconds = 0/);
  });

  it('does not restate the false app-test-cases criterion', () => {
    const gate = deliverGate();
    // The exact sentence that shipped the defect.
    expect(gate).not.toMatch(/This is the criterion `app-test-cases\.yaml` declares/i);
    // Only the corrected, negated form may appear.
    expect(gate).toMatch(/NOT a criterion `app-test-cases\.yaml` declares/i);
    expect(skill).not.toMatch(/criterion `app-test-cases\.yaml` declares \(\*"one payment unit registers"\*\)/i);
  });

  // ------------------------------------------------------------------
  // ace#2427 — the second configuration that makes a count unreachable.
  //
  // The duration floor above is the gate's ONE carve-out for "the
  // opportunity's own configuration makes server credit impossible". It is
  // not the only such configuration: an opportunity whose `start_date` has
  // not arrived credits nothing at all, so `delivered >= 1` is structurally
  // unreachable and no action available to Phase 6 can produce a delivery.
  //
  // Live on poverty-graduation/20260915-1518: Deliver walk `pass` (43
  // screenshots, 0 failures, all 14 screens), then
  // `connect_get_deliver_progress` -> {delivered: 0, approved: 0,
  // rejected: 0} and `connect_get_opportunity` -> start_date "2026-11-01"
  // against a run date of 2026-09-16. By the gate as written that is
  // `not-delivered-on-connect` — i.e. "the Deliver->Connect path is broken"
  // — which is false. Connect is behaving correctly, and the device says so
  // in red on the frame the sync recipe captured.
  //
  // It is NOT the `rejected` shape either (rejected == 0): nothing was
  // submitted-then-refused, so none of the three pre-existing branches
  // describes it.
  it('carries the not-started branch, evaluated before the counts', () => {
    const gate = deliverGate();
    expect(gate).toContain('not-started-as-designed');
    expect(gate).toMatch(/PASS-with-note/i);
    // Guarded on the opportunity's own configuration, not on a zero count.
    expect(gate).toMatch(/start_date/);
    expect(gate).toMatch(/NOT\s+`?not-delivered-on-connect`?/i);
    // Ordering is load-bearing: a zero count must not reach the hard
    // assertion before the start date has been consulted.
    expect(gate).toMatch(/evaluated FIRST/i);
  });

  it('says where start_date is read from, and invents no atom for it', () => {
    const gate = deliverGate();
    // Already stored by Phase 4 ...
    expect(gate).toContain('phases.connect-setup.products.connect.opportunity.start_date');
    // ... or read live from the atom that really does carry it (ace#1550).
    expect(gate).toContain('connect_get_opportunity');
    expect(gate).toMatch(/no new atom/i);
  });

  it('forbids moving the start date to make a walk payable', () => {
    // The sibling of "do not relax the duration floor" — editing the
    // programme's own contract to satisfy a test.
    expect(deliverGate()).toMatch(/do not\*{0,2} move the opportunity's start date/i);
  });

  it('keeps `delivered >= 1` hard while naming its one unreachable case', () => {
    const gate = deliverGate();
    // The hard assertion survives the carve-out ...
    expect(gate).toMatch(/`delivered >= 1`[^.]{0,80}(HARD|unconditional)/i);
    // ... and its reachability claim is no longer unqualified, because the
    // old wording ("reachable on every opportunity, floor or no floor") is
    // exactly what left the not-started case with nowhere to go.
    expect(gate).not.toMatch(/reachable on every opportunity,/i);
    expect(gate).toMatch(/every \*{0,2}started\*{0,2} opportunity/i);
  });

  it('keeps every Deliver-count assertion inside the pinned block', () => {
    const outside = stepFiveOutsideGate();
    expect(outside).not.toMatch(/`approved >= 1`/);
    expect(outside).not.toMatch(/`delivered >= 1`/);
  });
});
