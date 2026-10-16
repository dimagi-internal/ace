/**
 * `app-deploy` Step 2.5's XML-escape lint never rewrites `&`
 * (dimagi-internal/ace#2207, ace#2150).
 *
 * Nova entity-encodes `&` at compile: the blueprint stores a bare `&`, the
 * compiled form XML carries `&amp;` (18 escaped / 0 bare across a compiled
 * `spark-facilitator/20260907-1120` Deliver CCZ; re-observed on
 * `spark-facilitator/20261004-1706` Learn). The lint used to flag `&` and tell
 * the agent to rewrite it to `&amp;` — which double-escapes (the worker sees a
 * literal `&amp;`) and, on a multilingual app, demotes that unit's translations
 * to `out-of-date`. The `<` / `>` half has a real reproducer and stays.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SKILL = readFileSync(join(REPO_ROOT, 'skills/app-deploy/SKILL.md'), 'utf8');

function step25(): string {
  const start = SKILL.indexOf('2.5. **XML-escape lint.**');
  const end = SKILL.indexOf('\n2.9. ', start);
  expect(start, 'app-deploy lost Step 2.5').toBeGreaterThan(0);
  return SKILL.slice(start, end);
}

describe('app-deploy XML-escape lint leaves & alone (ace#2207)', () => {
  it('the scan regex does not match a bare &', () => {
    const fence = step25().match(/```\n\s*(\/.*\/i?)\n\s*```/);
    expect(fence, 'Step 2.5 lost its scan regex').not.toBeNull();
    const src = fence![1];
    const body = src.slice(1, src.lastIndexOf('/'));
    const re = new RegExp(body, 'i');
    expect(re.test('Governance & Leadership'), 'the lint regex flags a bare &').toBe(false);
    expect(re.test('weight (<2kg)'), 'the lint regex must still flag a raw <').toBe(true);
  });

  it('the fix instruction never tells the agent to write &amp;', () => {
    const s = step25().replace(/\s+/g, ' ');
    expect(/`&` \(not in an entity\) with `&amp;`/.test(s)).toBe(false);
    expect(/Never touch `&`/.test(s)).toBe(true);
    expect(s).toMatch(/ace#2207/);
    expect(s).toMatch(/ace#2150/);
  });
});
