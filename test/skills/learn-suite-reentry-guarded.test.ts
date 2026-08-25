/**
 * Class-level preventer for dimagi-internal/ace#1633.
 *
 * `learn-suite-reentry-from-module.yaml` is an unconditional `back` followed
 * by a 15s wait on the menu container. That is correct only when the finalize
 * actually landed one level INSIDE the suite — on the module's own form list.
 *
 * `post_submit: previous` (Nova's default) means "the screen you came from",
 * and that is a property of the FORM's owning module, not of the app:
 * CommCare auto-skips a module's one-row form list when the module holds
 * exactly one form whose display name differs from the module name, so
 * `previous` lands on the suite ROOT for that module and on the form LIST for
 * a module holding two or more. One app can be both shapes at once — live on
 * bednet-check-2-visit/20260825-1310 — and an unconditional `back` fired from
 * the suite root exits the suite entirely, hanging the Learn walk (the #1071
 * signature; Learn never hits 100% and Deliver stays locked, #897).
 *
 * The rail: every composition of the from-module re-entry in `app-test-cases`
 * is GUARDED, and the skill states the per-form rule. A guard is correct
 * under either landing, which is why it — not a third unconditional variant —
 * is the fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL_PATH = fileURLToPath(
  new URL('../../skills/app-test-cases/SKILL.md', import.meta.url),
);
const skill = readFileSync(SKILL_PATH, 'utf8');

const REENTRY = 'learn-suite-reentry-from-module.yaml';

/** Every fenced yaml block in the skill. */
const yamlBlocks = [...skill.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);

describe('the from-module Learn re-entry is composed guarded (ace#1633)', () => {
  it('the skill still composes the from-module re-entry somewhere (sanity)', () => {
    const composing = yamlBlocks.filter((b) => b.includes(`file: ${REENTRY}`));
    expect(
      composing.length,
      `no yaml block composes ${REENTRY} — the per-module Learn loop template ` +
        'has moved or been deleted; re-point this rail',
    ).toBeGreaterThan(0);
  });

  it('every yaml block composing it wraps the call in a `when:` guard', () => {
    for (const block of yamlBlocks) {
      if (!block.includes(`file: ${REENTRY}`)) continue;
      expect(
        block,
        `a yaml block calls ${REENTRY} unguarded. It is an unconditional \`back\`: ` +
          'fired from the suite root — where `post_submit: previous` lands for a ' +
          'module CommCare auto-skipped — it walks back OUT of the suite and the ' +
          'following wait expires (ace#1633). Guard it POSITIVELY on the next ' +
          "module's suite row (`when: notVisible: text: <next row>`).",
      ).toMatch(/when:\s*\n\s*notVisible:/);
    }
  });

  it('the re-entry section states the per-FORM rule, not a per-app one', () => {
    const section = skill
      .split(/\n(?=#{2,6} )/)
      .find((s) => s.startsWith('##### Suite re-entry between modules'));
    expect(section, 'the § Suite re-entry between modules section has moved').toBeDefined();
    expect(
      section,
      'the section must say the choice is per FORM — a per-app reading cannot ' +
        'express an app whose modules land on different surfaces (ace#1633)',
    ).toMatch(/per FORM, not per APP/i);
    expect(
      section,
      'the section must name the discriminator: the owning module auto-skips its ' +
        'one-row form list when it holds exactly one differently-named form',
    ).toMatch(/auto-skip/i);
    expect(section, 'cite the issue').toMatch(/ace#1633/);
  });
});
