import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every skill that uploads labs `render_code` must send its author to the
 * shared report library, `window.LabsReport`.
 *
 * ## Why
 *
 * labs publishes the house look of its indicator reports (cards, header,
 * tabs, tiles, scorecards, and since VERSION 4 the scenario inputs) on
 * `window.LabsReport`, available to every render at runtime. A page built
 * from it matches every other report and improves on each deploy; a page
 * styled by hand drifts, and also walks into the Tailwind purge trap
 * (ace#1662), because its classes are not in labs' bundle.
 *
 * On 2026-10-03 the KMC cost-effectiveness explorer's first cut was
 * hand-styled Tailwind. Nothing it read mentioned the library: not labs'
 * authoring guide (fixed upstream in dimagi-internal/connect-labs#2178, §4c), and not the
 * ACE skills that write render code (ace#2623). Jon: "use the improved styling the
 * semantic reports have ... we should be building up really strong styles
 * we can re-use, make sure we are doing that."
 *
 * The rule lives once, in `playbook/integrations/connect-labs.md`; each
 * render-writing skill only has to point at it. This test is what keeps a
 * NEW render-writing skill from being added without that pointer.
 */

const ROOT = join(__dirname, '..', '..');
const SKILLS = join(ROOT, 'skills');
const PLAYBOOK = join(ROOT, 'playbook', 'integrations', 'connect-labs.md');

// The atoms that put render code into a labs workflow.
const WRITES_RENDER =
  /\b(workflow_update_render_code|workflow_patch_render_code|workflow_create)\b/;

function renderWritingSkills(): string[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(SKILLS, d.name, 'SKILL.md'))
    .filter((p) => existsSync(p))
    .filter((p) => WRITES_RENDER.test(readFileSync(p, 'utf8')));
}

describe('render_code is styled with window.LabsReport', () => {
  it('the playbook states the rule', () => {
    const pb = readFileSync(PLAYBOOK, 'utf8');
    expect(pb).toMatch(/Style `render_code` with `window\.LabsReport`/);
  });

  it('finds the skills that write render code (guards the detector itself)', () => {
    // If this drops to zero the regex broke, and the test below would pass vacuously.
    expect(renderWritingSkills().length).toBeGreaterThanOrEqual(3);
  });

  it('every render-writing skill points at the shared report library', () => {
    const missing = renderWritingSkills().filter(
      (p) => !readFileSync(p, 'utf8').includes('window.LabsReport'),
    );
    expect(
      missing.map((p) => p.slice(ROOT.length + 1)),
      'These skills upload labs render_code but never mention window.LabsReport. ' +
        'Add the one-line pointer to playbook/integrations/connect-labs.md § ' +
        '"Style `render_code` with `window.LabsReport`".',
    ).toEqual([]);
  });
});
