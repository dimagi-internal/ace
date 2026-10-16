/**
 * The Deliver build summary carries a `nova_uuids` block sourced from `get_app`
 * (dimagi-internal/ace#2144).
 *
 * ## The failure class
 *
 * `app-deploy` Step 2.5 and `app-connect-coverage` read the build summary's
 * `nova_uuids:` frontmatter as the cheap alternative to a `get_app` call — but
 * `pdd-to-deliver-app` Step 7 never specified the block (Learn's Step 7 did).
 * On `spark-facilitator/20260906-2233` the map that was written anyway had all
 * four module/form uuids pattern-truncated (`11110000-…` where the app holds
 * `11111111-…`), and the lint's `get_form` failed with "No module with UUID …".
 *
 * SCOPE: offline. Pins that (a) the consumers' premise holds — the Deliver
 * Step 7 frontmatter spec declares `nova_uuids` — and (b) the spec sources it
 * from the `get_app` response, never from a pattern, with a read-back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const DELIVER_REL = 'skills/pdd-to-deliver-app/SKILL.md';

/** Step 7's text, from its heading to the next top-level numbered step. */
function deliverStep7(): string {
  const s = read(DELIVER_REL);
  const start = s.indexOf('7. **Write the summary**');
  expect(start, `${DELIVER_REL} lost its Step 7 "Write the summary"`).toBeGreaterThan(0);
  const end = s.indexOf('\n7a. ', start);
  return s.slice(start, end > 0 ? end : start + 20000);
}

/** The fenced YAML frontmatter spec inside Step 7. */
function step7Frontmatter(): string {
  const step = deliverStep7();
  const open = step.indexOf('```yaml');
  const close = step.indexOf('```', open + 7);
  expect(open, 'Step 7 has no ```yaml frontmatter spec').toBeGreaterThan(0);
  return step.slice(open, close);
}

describe('Deliver summary nova_uuids block (ace#2144)', () => {
  it('the Step 7 frontmatter spec declares nova_uuids with module and form uuids', () => {
    const fm = step7Frontmatter();
    expect(fm).toMatch(/^\s*nova_uuids:\s*$/m);
    expect(fm).toMatch(/uuid: <moduleUuid>/);
    expect(fm).toMatch(/uuid: <formUuid>/);
  });

  it('the block is sourced from the get_app response, never a pattern', () => {
    const fm = step7Frontmatter();
    expect(fm).toMatch(/get_app/);
    expect(fm).toMatch(/NEVER typed\s+#?\s*from a pattern/i);
  });

  it('Step 7 prescribes a get_form read-back of the written map', () => {
    const step = deliverStep7().replace(/\s+/g, ' ');
    expect(step).toMatch(/read back/i);
    expect(step).toMatch(/get_form\(\{app_id, moduleUuid, formUuid\}\)/);
  });

  it('every consumer that trusts the block names a skill that writes it', () => {
    // app-deploy and app-connect-coverage read `nova_uuids:` off the build
    // summaries; both producers must declare it, or the consumer's premise is false.
    for (const consumer of ['skills/app-deploy/SKILL.md', 'skills/app-connect-coverage/SKILL.md']) {
      expect(read(consumer)).toMatch(/nova_uuids:/);
    }
    expect(read('skills/pdd-to-learn-app/SKILL.md')).toMatch(/^\s*nova_uuids:\s*$/m);
    expect(read(DELIVER_REL)).toMatch(/^\s*nova_uuids:\s*$/m);
  });
});
