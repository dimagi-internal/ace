import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

describe('selector-map-heal — the three guards are stated in the skill', () => {
  const P = 'skills/selector-map-heal/SKILL.md';

  it('exists and declares its name', () => {
    expect(existsSync(P)).toBe(true);
    expect(readFileSync(P, 'utf8')).toMatch(/^name:\s*selector-map-heal$/m);
  });

  it('forbids mutating a Live-verified row AND names its mechanical enforcer', () => {
    const body = readFileSync(P, 'utf8');
    expect(body).toMatch(/Live-verified/);
    expect(body).toMatch(/additive|never mutate|only add/i);
    // Guard 1 is enforced by Task 6's pre-commit check, not by this prose.
    // If the skill stops naming it, an implementer may believe the rule is
    // advisory — which is how it got written as advisory the first time.
    expect(body).toMatch(/check-selector-map-diff/);
  });

  it('branches correctly on matcher-miss — the #811/#893 inversion', () => {
    const body = readFileSync(P, 'utf8');
    expect(body).toMatch(/matcher-miss/);
    // Must tell the implementer to STOP, not to author a new anchor.
    expect(body).toMatch(/matcher-miss[\s\S]{0,400}?(STOP|do NOT add|Fix the recipe)/i);
  });

  it('requires a green on-device re-run before any merge', () => {
    const body = readFileSync(P, 'utf8');
    expect(body).toMatch(/re-run/i);
    expect(body).toMatch(/green|pass/i);
    expect(body).toMatch(/never ship an unproven|stop and file/i);
  });

  it('does not claim to run selector-map-calibrate autonomously', () => {
    expect(readFileSync(P, 'utf8')).not.toMatch(/disable-model-invocation:\s*false/);
  });
});
