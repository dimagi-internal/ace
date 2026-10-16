/**
 * dimagi-internal/ace#3036 — Connect computes Learn completion over EVERY
 * learn_module, so a role-gated learn_module form makes Learn uncompletable
 * (kaduna-graduation/20261015-1411: an FLW passed and read 9/14 = 64.3%).
 *
 * Pins the three places the rule must live: the producer (never gate, raise
 * the restructuring choice as a required-before decision row, honest pass
 * label), the eval (a hard-gate), and release QA (the CCZ helper).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

describe('role-gated learn_module rule (ace#3036)', () => {
  const learn = read('skills/pdd-to-learn-app/SKILL.md');
  const start = learn.indexOf('2a. **More than one worker role');
  const step = start < 0 ? '' : learn.slice(start, learn.indexOf('3. **Compose a Nova brief', start));

  it('pdd-to-learn-app has a multi-role step that forbids gating marked forms', () => {
    expect(step.length).toBeGreaterThan(0);
    expect(step).toMatch(/ace#3036/);
    expect(step).toMatch(/9\/14/);
    expect(step).toMatch(/No display condition on any `learn_module`-bearing form/);
  });

  it('raises the restructuring choice as a required-before / go-live decision row', () => {
    expect(step).toMatch(/learn-gap-multi-role-learn-completion/);
    expect(step).toMatch(/review_ask: required-before/);
    expect(step).toMatch(/needed_by: go-live/);
    // the three owner options are named, and none is picked as the answer
    expect(step).toMatch(/one opportunity\s+\(and Learn app\) per role/);
    expect(step).toMatch(/every role completes every module/);
    expect(step).toMatch(/shared core/);
    expect(step).toMatch(/Do not pick one as the answer/);
  });

  it('forbids a pass label promising the work app opens', () => {
    expect(step).toMatch(/must never promise the work app\s+opens/);
  });

  it('the brief carries a verbatim REQUIRED paragraph', () => {
    expect(step).toMatch(/> REQUIRED: This programme has more than one worker role/);
  });

  it('pdd-to-learn-app-eval hard-gates a role-gated learn_module form', () => {
    const ev = read('skills/pdd-to-learn-app-eval/SKILL.md');
    expect(ev).toMatch(/\*\*`learn_module_display_gating`\*\*[\s\S]{0,600}`\[BLOCKER\]` → `fail`/);
  });

  it('app-release-qa runs the CCZ helper', () => {
    const qa = read('skills/app-release-qa/SKILL.md');
    expect(qa).toMatch(/checkLearnModuleDisplayGating/);
    expect(qa).toMatch(/learn-module-display-gated/);
  });
});
