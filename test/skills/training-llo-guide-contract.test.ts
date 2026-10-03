import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * dimagi-internal/ace#2610 — spark/spark-facilitator/20261001-2208's LLO guide
 * scored warn 7.6: a countdown quoted as the window, no procedure for a paid
 * record found false, only worker phone screens, and no partner contact the
 * rubric would accept short of inventing one. These pin the producer and the
 * rubric to the fix so the classes cannot drift back in as prose.
 */

const ROOT = join(__dirname, '..', '..');
const skill = readFileSync(join(ROOT, 'skills/training-llo-guide/SKILL.md'), 'utf-8');
const evalSkill = readFileSync(join(ROOT, 'skills/training-llo-guide-eval/SKILL.md'), 'utf-8');
const playbook = readFileSync(join(ROOT, 'playbook/integrations/connect-api.md'), 'utf-8');

describe('training-llo-guide — window from the opportunity (ace#2610)', () => {
  it('reads start/end dates from connect_get_opportunity and computes the length', () => {
    expect(skill).toContain('connect_get_opportunity');
    expect(skill).toContain('opportunityWindow(');
    expect(skill).toContain('findDayCountDrift');
  });

  it('forbids quoting a day count read off a screenshot', () => {
    expect(skill).toMatch(/Never quote a number of days you read off a screenshot/);
    expect(skill).toContain('getDaysRemaining');
  });
});

describe('training-llo-guide — a paid record found false (ace#2610)', () => {
  it('requires the section in the output skeleton', () => {
    expect(skill).toContain('## When a paid record turns out to be false');
  });

  it('builds it on the source-verified mechanism, not "reject the visit"', () => {
    const sec = (skill.split('## A paid record found false')[1]?.split(/^## /m)[0] ?? '').replace(/\s+/g, ' ');
    expect(sec).toContain('automatic_visit_verification');
    expect(sec).toContain('Payment Verification import');
    expect(sec).toContain('payment_delete');
    expect(sec).toContain('suspend_user');
    expect(sec).toContain('Do NOT tell the LLO to "reject the visit in Connect"');
  });

  it('the playbook carries the durable, source-cited copy', () => {
    expect(playbook).toContain('### A paid visit found false — what the holding org can do');
    expect(playbook).toContain('27223cc5');
  });
});

describe('training-llo-guide — LLO-side grounding (ace#2610)', () => {
  it('names the Phase 4 previews as an input', () => {
    expect(skill).toContain('4-connect/previews/connect-opportunity/_previews.yaml');
  });

  it('the eval caps grounding when no LLO-side screen renders', () => {
    expect(evalSkill).toMatch(/none is an LLO-side Connect view, cap this dimension at 6/);
  });
});

describe('escalation contacts — no inferred backstory (ace#2610)', () => {
  it('the producer prescribes a marked placeholder when the inputs name nobody', () => {
    expect(skill).toContain('## Escalation contacts — no inferred backstory');
    expect(skill).toMatch(/to be named by <Partner> at onboarding/);
  });

  it('the eval scores an honest placeholder as a named contact and penalises an untraceable one', () => {
    expect(evalSkill).toMatch(/clearly marked placeholder scores the same as a named contact/);
    expect(evalSkill).toMatch(/does not trace to the inputs/);
  });
});
