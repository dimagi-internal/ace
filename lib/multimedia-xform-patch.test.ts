import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addImageItext } from './multimedia-xform-patch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE = readFileSync(
  join(__dirname, '../test/fixtures/cchq/multimedia-sample-form.xml'),
  'utf-8',
);

describe('addImageItext', () => {
  it('adds an <image> jr:// value to the matching itext text node', () => {
    const out = addImageItext(FIXTURE, [
      { fieldId: 'kmc_position_demo', cczFilename: 'kmc_position_demo.png' },
    ]);
    expect(out.patched).toBe(true);
    expect(out.xml).toContain('<value form="image">jr://file/commcare/image/kmc_position_demo.png</value>');
    // The original label value must remain intact.
    expect(out.xml).toContain("Show the mother how to support the baby's head and neck.");
  });

  it('is idempotent — re-applying does not duplicate the <image> entry', () => {
    const once = addImageItext(FIXTURE, [
      { fieldId: 'kmc_position_demo', cczFilename: 'kmc_position_demo.png' },
    ]);
    const twice = addImageItext(once.xml, [
      { fieldId: 'kmc_position_demo', cczFilename: 'kmc_position_demo.png' },
    ]);
    const occurrences = (twice.xml.match(/jr:\/\/file\/commcare\/image\/kmc_position_demo\.png/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(twice.patched).toBe(false);
  });

  it('returns patched=false when the field has no matching itext entry', () => {
    const out = addImageItext(FIXTURE, [{ fieldId: 'no_such_field', cczFilename: 'x.png' }]);
    expect(out.patched).toBe(false);
  });

  it('handles multiple fields in one pass', () => {
    // Build a form with two label-text entries
    const twoFieldForm = FIXTURE.replace(
      /<text id="kmc_position_demo-label">[\s\S]*?<\/text>/,
      `<text id="a-label"><value>A</value></text><text id="b-label"><value>B</value></text>`,
    );
    const out = addImageItext(twoFieldForm, [
      { fieldId: 'a', cczFilename: 'a.png' },
      { fieldId: 'b', cczFilename: 'b.png' },
    ]);
    expect(out.xml).toContain('jr://file/commcare/image/a.png');
    expect(out.xml).toContain('jr://file/commcare/image/b.png');
  });

  it('with replaceExisting=true, replaces a prior <image> entry instead of appending', () => {
    // Apply once with filename A, then once with filename B + replaceExisting
    const first = addImageItext(FIXTURE, [
      { fieldId: 'kmc_position_demo', cczFilename: 'A.png' },
    ]);
    const second = addImageItext(
      first.xml,
      [{ fieldId: 'kmc_position_demo', cczFilename: 'B.png' }],
      { replaceExisting: true },
    );

    expect(second.patched).toBe(true);
    // Only the new asset should remain; the old one is gone.
    expect(second.xml).toContain('jr://file/commcare/image/B.png');
    expect(second.xml).not.toContain('jr://file/commcare/image/A.png');
    // The original label text must remain intact.
    expect(second.xml).toContain("Show the mother how to support the baby's head and neck.");
    // applied should reflect the field that was modified.
    expect(second.applied).toContain('kmc_position_demo');
  });

  it('default (replaceExisting unset) preserves the existing append-only behavior', () => {
    // No regression on the case the existing tests already cover —
    // just adding a sentinel test so the change is intentional.
    const out = addImageItext(FIXTURE, [
      { fieldId: 'kmc_position_demo', cczFilename: 'fresh.png' },
    ]);
    expect(out.patched).toBe(true);
    expect(out.xml).toContain('jr://file/commcare/image/fresh.png');
  });
});
