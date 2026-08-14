import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

describe('selector-map-heal — the three guards are stated in the skill', () => {
  // cwd-relative was fragile — the sibling recipe-splitter.test.ts
  // deliberately switched to an import.meta.url-relative path in this
  // same branch for exactly that reason (a test runner invoked from a
  // different working directory would otherwise silently skip the
  // file-existence assertions). Mirror that fix here.
  const P = new URL('../../skills/selector-map-heal/SKILL.md', import.meta.url);

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

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1256 — the heal pipeline shipped complete (detect →
// classify → surface) but had NO on-ramp: nothing routed an unmapped-surface
// classification to skills/selector-map-heal, so the repair tier was
// unreachable by construction. These assert the routing sentence exists at
// both places the classification is recorded, and that it stays scoped to
// unmapped-surface only (matcher-miss / drift have different remedies —
// routing them here recreates the #811/#893 inversion).
// ---------------------------------------------------------------------------

describe('selector-map-heal — the on-ramp exists (#1256)', () => {
  const QA = new URL('../../agents/qa-and-training.md', import.meta.url);
  const CAP = new URL('../../skills/app-screenshot-capture/SKILL.md', import.meta.url);

  it('agents/qa-and-training.md routes unmapped-surface to selector-map-heal', () => {
    const body = readFileSync(QA, 'utf8');
    expect(body).toMatch(/unmapped-surface[\s\S]{0,900}?selector-map-heal/);
  });

  it('app-screenshot-capture routes unmapped-surface to selector-map-heal', () => {
    const body = readFileSync(CAP, 'utf8');
    expect(body).toMatch(/unmapped-surface[\s\S]{0,900}?selector-map-heal/);
  });

  it('both routings are explicitly scoped to unmapped-surface only', () => {
    for (const u of [QA, CAP]) {
      const body = readFileSync(u, 'utf8');
      // Every mention of the heal skill must sit inside a sentence that also
      // names the exclusion (matcher-miss / drift are NOT routed here).
      for (const m of body.matchAll(/selector-map-heal/g)) {
        // Symmetric window: the scoping sentence may sit on either side of
        // the mention (the agent doc's remedy-per-classification pointer
        // follows its scope statement).
        const window = body.slice(Math.max(0, m.index! - 400), m.index! + 400);
        expect(window).toMatch(/unmapped-surface.{0,40}(only|ONLY)|only.{0,40}unmapped-surface|matcher-miss/i);
      }
    }
  });
});
