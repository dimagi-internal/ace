/**
 * demo-narrative's video shape: explainer by default, canopy's recorded
 * walkthrough (`style: recorded` + `cuts:`) only on an explicit request (ace#2789).
 *
 * The chlorine-dispenser demo (Sagar Atre's brief, 2026-10-07: no music,
 * separate cuts under 40 s) had to be hand-authored outside the skill, because
 * the skill could only write the explainer. Operator decision (2026-10-16):
 * explainer stays the default; the recorded shape is opt-in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('demo-narrative recorded-walkthrough branch (ace#2789)', () => {
  const skill = read('skills/demo-narrative/SKILL.md');

  it('names explainer as the default and recorded as opt-in only', () => {
    expect(skill).toMatch(/`style` — `explainer` \(\*\*default\*\*\) or `recorded`/);
    expect(skill).toMatch(/Explainer is the default and stays the default/);
    expect(skill).toMatch(/Author `recorded` ONLY when it was explicitly requested/);
  });

  it('has the recorded authoring step, built on canopy’s contract and its lint + gate', () => {
    const step = skill.slice(skill.indexOf('3r. **The recorded-walkthrough variant'), skill.indexOf('4. **Validate'));
    expect(step.length).toBeGreaterThan(0);
    for (const needle of [
      'skills/ddd-recorded-walkthrough/SKILL.md',
      'style: recorded',
      'cuts:',
      'This is a quick overview of',
      'scripts.ddd.recorded lint',
      'scripts.ddd.recorded gate',
    ]) expect(step).toContain(needle);
  });

  it('every entry point threads `style`, defaulting to explainer', () => {
    const cmd = read('commands/demo.md');
    expect(cmd).toContain('[--style explainer|recorded]');
    expect(cmd).toMatch(/\*\*Default `explainer`\*\*/);
    expect(cmd).toMatch(/Thread through: .*`style`/);
    expect(read('agents/demo.md')).toMatch(/\{brief, realizedRef: 7-synthetic\/realized\.json, runId, style\}/);
    expect(read('agents/synthetic-data-and-workflows.md')).toMatch(/`style: explainer`, the default/);
  });
});
