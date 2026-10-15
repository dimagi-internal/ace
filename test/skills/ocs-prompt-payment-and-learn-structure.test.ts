import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * dimagi-internal/ace#2968: on `dimagi-team/noora-health/20261015-1129`
 * (OCS experiment 14288) the Step 7 composed prompt made three mistakes:
 * it dropped the consent gate from the payable rule, listed Connect review
 * flags as "not paid", and counted the final assessment as a sixth Learn
 * module. The prompt is composed at run time, so this test pins only that
 * Step 7 gives the composer all three instructions, before the Step 7.5 gate.
 */
const md = readFileSync(
  join(__dirname, '..', '..', 'skills/ocs-agent-setup/SKILL.md'),
  'utf8',
);

function step7(): string {
  const start = md.indexOf('7. **Compose the system prompt**');
  const end = md.indexOf('7.5. **Composed-prompt gate');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return md.slice(start, end);
}

function bullet(): string {
  const s = step7();
  const start = s.indexOf('State the payment rule and the Learn structure from the BUILT apps');
  expect(start).toBeGreaterThan(-1);
  const end = s.indexOf('In `## Rules people commonly get wrong`', start);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

describe('ocs-agent-setup Step 7: payment rule + Learn structure from the built apps (ace#2968)', () => {
  it('takes the payable predicate from the Deliver summary, gating conditions included', () => {
    const b = bullet();
    expect(b).toContain('pdd-to-deliver-app_summary.md');
    expect(b).toMatch(/computed\s+payable\s+field/);
    expect(b).toMatch(/gating\s+conditions/i);
    expect(b).toMatch(/consent/);
    expect(b).toMatch(/check\s+it\s+against\s+the\s+PDD/);
  });

  it('describes Connect verification flags as review flags, never payment rules', () => {
    const b = bullet();
    expect(b).toMatch(/review\s+flags,\s+NOT\s+payment\s+rules/);
    expect(b).toMatch(/[Dd]uration/);
    expect(b).toMatch(/submission-hour/);
    expect(b).toMatch(/never list a flag under "what is not\s+paid"/);
  });

  it('counts Learn modules from the Learn summary and names the assessment separately', () => {
    const b = bullet();
    expect(b).toContain('pdd-to-learn-app_summary.md');
    expect(b).toMatch(/learn_module/);
    expect(b).toMatch(/Never\s+fold\s+the\s+assessment\s+into\s+the\s+module\s+count/);
  });
});
