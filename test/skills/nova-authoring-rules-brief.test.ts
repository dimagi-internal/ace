import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * ace#3300: the nine instruction-only fixes from the Oct 2026 Nova x ACE build
 * efficiency audit live ONCE, as the `nova-authoring-rules` component in the
 * shared library, and both build skills emit it by name. A copy in either
 * skill would drift from the other.
 */
const REPO = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

const lib = read('skills/_app-component-library.md');
const section = lib.split(/\n(?=### )/).find((s) => s.startsWith('### nova-authoring-rules')) ?? '';
const paragraph = section.slice(section.indexOf('**Brief paragraph (verbatim):**'));

describe('nova-authoring-rules component', () => {
  it('is in the component index and has a brief paragraph', () => {
    expect(lib).toContain('[`nova-authoring-rules`](#nova-authoring-rules)');
    expect(paragraph).toContain('> REQUIRED');
  });

  it.each([
    ['declare before use', /`generate_schema`[\s\S]*BOTH record types exist/],
    ['full paths in groups', /#form\/<group>\/<field>/],
    ['reserved properties', /`opened_on`[\s\S]*`add_case_operations`/],
    ['per-kind slots', /`geopoint` has no `validate`[\s\S]*`repeat` has\s*> no `hint`/],
    ['function names', /`jr:choice-name`[\s\S]*`lookup-table`/],
    ['expression context', /`selected\(\)` and `string-length\(\)`[\s\S]*NOT in record/],
    ['evaluate_form lookup', /`evaluate_form` does not evaluate lookup-table/],
    ['429 handling', /did NOT apply[\s\S]*back-to-back[\s\S]*SAME `request_id`/],
    ['continue_app_test args', /exactly one of\s*> `app_id` or `work_id`/],
    ['targeted reads', /`search_blueprint` or `get_field`[\s\S]*`get_form` only/],
    // ace#3308: Nova refuses configure_connect on an app that also runs in Web Apps.
    ['android only before Connect', /Before the first `configure_connect`,\s*> call `update_app` with `runs_only_on: "android"`/],
  ])('brief paragraph carries: %s', (_n, re) => {
    expect(paragraph).toMatch(re);
  });

  // The architect's tools are ToolSearch + Nova: it has no way to sleep, so a
  // timed back-off is an instruction it cannot follow.
  it('never tells the architect to wait a number of seconds', () => {
    expect(paragraph).not.toMatch(/\bwait\b[^.]*\bseconds?\b/i);
  });

  it.each(['pdd-to-learn-app', 'pdd-to-deliver-app'])('%s emits it by name, without restating it', (skill) => {
    const text = read(`skills/${skill}/SKILL.md`);
    expect(text).toMatch(/`nova-authoring-rules` — always/);
    expect(text).not.toContain('Declare before use');
    expect(text).not.toContain('jr:choice-name');
  });

  it('extends the existing #form/ and search_blueprint rules instead of duplicating them', () => {
    expect(lib.match(/full path/gi)?.length).toBeGreaterThan(0);
    expect(lib).toMatch(/Inside a group or repeat the reference is the FULL path/);
    expect(lib).toMatch(/Prefer it \(or `get_field`\) to `get_form`/);
  });
});
