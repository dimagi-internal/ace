import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';

/**
 * Ratchet (ace#2213): every `-eval` whose producer PUBLISHES a Google Doc
 * (`rendered: true` in the manifest) must run the deterministic
 * published-render gate in its `## Process`, before it grades anything.
 *
 * Why a test: on poverty-graduation/20260905-1345 all five Phase 6 training
 * evals passed at 8.4-8.8 on docs that published as raw markdown, two with 0 of
 * 157 screenshots, while the guides' rubrics already told the judge, in prose,
 * to count the published images. Prose to an LLM judge is not a gate.
 *
 * The set is DERIVED from the manifest, so a new published-Doc artifact with
 * an eval partner fails CI until its eval carries the gate.
 */

const ROOT = join(__dirname, '..', '..');
const SKILLS = join(ROOT, 'skills');
const SCRIPT = 'check-published-doc-render';
const POINTER = '§ Published-render gate (stock)';

/** The `## Process` section of a SKILL.md, or '' when there is none. */
export function processSection(body: string): string {
  const after = body.split(/^## Process\s*$/m)[1];
  return after ? after.split(/^## /m)[0] : '';
}

export function processRunsRenderGate(body: string, expectImages: boolean): boolean {
  const proc = processSection(body);
  if (!proc.includes(SCRIPT) || !proc.includes(POINTER)) return false;
  return !expectImages || proc.includes('--expect-images');
}

const gated = ARTIFACT_MANIFEST
  .filter((a) => a.rendered)
  .map((a) => ({ eval: `${a.producedBy}-eval`, illustrated: a.illustrated === true, path: a.path }))
  .filter((e) => existsSync(join(SKILLS, e.eval, 'SKILL.md')));

describe('evals of published Docs run the published-render gate (ace#2213)', () => {
  it('the derived set covers the five training docs the incident hit', () => {
    // Guards the derivation: if `rendered` were dropped from these entries the
    // per-eval assertions below would go vacuously green.
    const names = gated.map((g) => g.eval);
    for (const n of [
      'training-llo-guide-eval', 'training-flw-guide-eval', 'training-quick-reference-eval',
      'training-faq-eval', 'training-onboarding-email-eval',
    ]) expect(names).toContain(n);
  });

  it('the stock section exists in the eval template and names the script', () => {
    const tpl = readFileSync(join(SKILLS, '_eval-template.md'), 'utf-8');
    const section = tpl.split('## Published-render gate (stock)')[1]?.split(/^## /m)[0] ?? '';
    expect(section).toContain(SCRIPT);
    expect(section).toMatch(/--expect-images/);
    expect(section).toMatch(/verdict `fail`/);
  });

  it('the training template runs the gate before hand-off', () => {
    const tpl = readFileSync(join(SKILLS, '_training-template.md'), 'utf-8');
    expect(processSection(tpl)).toContain(SCRIPT);
  });

  for (const g of gated) {
    it(`${g.eval} runs the gate${g.illustrated ? ' with --expect-images' : ''} (${g.path})`, () => {
      const body = readFileSync(join(SKILLS, g.eval, 'SKILL.md'), 'utf-8');
      expect(processRunsRenderGate(body, g.illustrated)).toBe(true);
    });
  }

  it('the script the skills name exists', () => {
    expect(existsSync(join(ROOT, 'scripts', `${SCRIPT}.ts`))).toBe(true);
  });

  it('negative control: a gate mentioned outside ## Process does not count', () => {
    const body = `## Inputs\n\nRun ${SCRIPT} — ${POINTER}.\n\n## Process\n\n1. Read inputs.\n2. Grade.\n`;
    expect(processRunsRenderGate(body, false)).toBe(false);
  });

  it('negative control: an illustrated eval without --expect-images is caught', () => {
    const body = `## Process\n\n1b. Run \`scripts/${SCRIPT}.ts <url>\` — ${POINTER}.\n`;
    expect(processRunsRenderGate(body, true)).toBe(false);
    expect(processRunsRenderGate(body, false)).toBe(true);
  });
});
