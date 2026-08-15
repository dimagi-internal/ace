/**
 * ace#1434 — `connectify_wiring` (b) ("entity ID matches the PDD formula") and
 * (b2) ("the key MUST carry the payability discriminator") gave directly
 * opposed instructions and neither named a precedence. A build cannot satisfy
 * both: (b2) mandates a third component, (b) mandates exactly two.
 *
 * The SAME opportunity resolved it two different ways on consecutive runs —
 * 20260814-0856 rewrote the PDD to match the build; 20260814-2019 deviated from
 * the PDD and disclosed it as D-9. The regression property this file holds is
 * the one the issue asks for: one deterministic verdict, not two.
 */
import { describe, it, expect } from 'vitest';
import { resolveEntityIdGrain } from '../../lib/entity-id-precedence';

/** The live case: worker + follow-up visit date, consent_confirmed='no' non-payable. */
const live = {
  pinnedComponents: ['#user/username', '#form/visit_date'],
  payabilityDiscriminator: '#form/consent_confirmed',
  hasNonPayableBranch: true,
  sourcePinned: true,
};

describe('the conflict now has one answer', () => {
  it('the discriminator wins', () => {
    const r = resolveEntityIdGrain(live);
    expect(r.components).toEqual([
      '#user/username',
      '#form/visit_date',
      '#form/consent_confirmed',
    ]);
  });

  it('and the override must be disclosed, not silent', () => {
    const r = resolveEntityIdGrain(live);
    expect(r.deviates).toBe(true);
    expect(r.discloseAs).toContain('consent_confirmed');
  });

  it('is deterministic — the property two runs violated', () => {
    expect(resolveEntityIdGrain(live)).toEqual(resolveEntityIdGrain({ ...live }));
  });

  it('explains WHY the pin loses, since both resolutions were defensible', () => {
    const r = resolveEntityIdGrain(live);
    // Not symmetric: one ships a build that is wrong in the field, the other
    // leaves a document out of date.
    expect(r.reason).toContain('#969');
    expect(r.reason).toMatch(/disclosure problem, not a payment problem/);
  });

  it('says source-pinned does not shield a correctness preventer', () => {
    expect(resolveEntityIdGrain(live).reason).toMatch(/taste/);
    expect(resolveEntityIdGrain({ ...live, sourcePinned: false }).reason).not.toMatch(/taste/);
  });
});

describe('it does not fire when it should not', () => {
  it('no non-payable branch → the pinned grain stands, no deviation', () => {
    const r = resolveEntityIdGrain({ ...live, hasNonPayableBranch: false });
    expect(r.components).toEqual(['#user/username', '#form/visit_date']);
    expect(r.deviates).toBe(false);
  });

  it('the PDD already pins the discriminator → (b) and (b2) agree', () => {
    const r = resolveEntityIdGrain({
      ...live,
      pinnedComponents: ['#user/username', '#form/visit_date', '#form/consent_confirmed'],
    });
    expect(r.deviates).toBe(false);
    expect(r.components).toHaveLength(3);
    expect(r.reason).toContain('agree');
  });
});

describe('no field expresses payability', () => {
  const r = resolveEntityIdGrain({ ...live, payabilityDiscriminator: undefined });

  it('ships the pinned grain rather than inventing a component', () => {
    expect(r.components).toEqual(['#user/username', '#form/visit_date']);
    expect(r.deviates).toBe(false);
  });

  it('but flags it — the component forbids shipping this silently', () => {
    expect(r.unresolvable).toBe(true);
    expect(r.reason).toMatch(/Do not ship this silently/);
    expect(r.reason).toMatch(/build memo/);
  });
});

describe('the ruling is written where builds and judges read it', () => {
  it('the component states the precedence and the Phase-4 requirement', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const lib = readFileSync(
      join(__dirname, '../../skills/_app-component-library.md'), 'utf8',
    );
    // The rule is a wrapped blockquote, so normalise before matching.
    const flat = lib.replace(/[>*\n]+/g, ' ').replace(/\s+/g, ' ');
    expect(flat).toMatch(/PRECEDENCE \(ace#1434\)/);
    expect(flat).toMatch(/the discriminator wins/i);
    expect(flat).toMatch(/REQUIRED WHEN THIS SHIPS/);
    expect(lib).toContain('resolveEntityIdGrain');
  });

  it('the eval resolves (b) against (b2) so a conforming build is not marked down', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const rubric = readFileSync(
      join(__dirname, '../../skills/pdd-to-deliver-app-eval/SKILL.md'), 'utf8',
    );
    expect(rubric).toMatch(/\(b\) YIELDS TO \(b2\)/);
    expect(rubric).toMatch(/NO deduction under \(b\)/);
    expect(rubric).toMatch(/CONTINGENT \(ace#1434\)/);
  });
});
