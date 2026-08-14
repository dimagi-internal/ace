import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1256 (surfaced while triaging #972)
//
// selector-map-heal shipped 2026-08-12/13 with its detect, tier-2 and fork
// tiers all wired — but `grep -rn selector-map-heal` outside its own directory
// returned ZERO hits. Nothing told an operator or the phase agent to run it
// when the classification said `unmapped-surface`, so the repair pipeline
// built to close #972 / #1007 / #1081 had no on-ramp and read as a dead end.
//
// This pins the on-ramp at both places the classification is handled.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

describe('unmapped-surface routes to selector-map-heal (#1256)', () => {
  it.each([
    ['agents/qa-and-training.md', 'the phase-summary rule'],
    ['skills/app-screenshot-capture/SKILL.md', 'the verdict-note rule'],
  ])('%s names the remedy where it handles the classification', (path) => {
    const md = read(path);
    expect(md).toMatch(/unmapped-surface/);
    expect(
      md,
      `${path} handles the unmapped-surface classification but never names ` +
        'skills/selector-map-heal, so the repair pipeline has no on-ramp from it.',
    ).toMatch(/selector-map-heal/);
  });

  it('does NOT route matcher-miss to the heal skill', () => {
    // A matcher-miss means the row exists and the recipe reached wrong — the
    // fix is the recipe, and authoring a selector for it is the documented
    // way to get this backwards.
    const md = read('skills/app-screenshot-capture/SKILL.md');
    expect(md).toMatch(/matcher-miss[\s\S]{0,400}must NOT be authored/);
  });
});
