/**
 * Unit tests for `lib/xform-acquire.ts` — the on-disk camera-only patcher that
 * makes `commcare_get_form_source`'s `write_to_path` mode USABLE (ace#1795).
 *
 * Classification: UNIT-TEST TRUTH. Nothing here is sent to, or matched
 * against, a device or a live server — it is a pure string transformation
 * whose ground truth is the XForm the CommCare widget reads. The one external
 * fact it depends on (the widget hides the gallery button when the appearance
 * hint CONTAINS `acquire`) was verified against commcare-android
 * `QuestionWidget.ACQUIREFIELD` on 2026-07-13 and is recorded in
 * `skills/app-hq-settings/SKILL.md` § Step 3; this file only encodes it.
 */
import { describe, it, expect } from 'vitest';
import { addAcquireAppearance } from '../../lib/xform-acquire.js';

/**
 * A form shaped like the one that actually bit: entity-bearing read-aloud
 * text, a regex with literal whitespace classes, and a photo control with no
 * appearance hint. Every byte outside the `<upload>` start tag must survive.
 */
const FORM = [
  '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa">',
  '  <h:head>',
  '    <itext>',
  '      <translation lang="en">',
  '        <text id="q1-label"><value>Read aloud &#x2014; don&apos;t paraphrase</value></text>',
  '      </translation>',
  '    </itext>',
  "    <bind nodeset=\"/data/name\" constraint=\"regex(., '^[ \\t\\r\\n]+$')\"/>",
  '  </h:head>',
  '  <h:body>',
  '    <upload ref="/data/photo_screen/dwelling_photo" mediatype="image/*">',
  '      <label ref="jr:itext(\'dwelling_photo-label\')"/>',
  '    </upload>',
  '  </h:body>',
  '</h:html>',
].join('\n');

describe('addAcquireAppearance — POSITIVE control (the reported defect)', () => {
  it('adds appearance="acquire" to an image upload that has none', () => {
    const res = addAcquireAppearance(FORM);

    expect(res.patched).toBe(true);
    expect(res.applied).toEqual(['/data/photo_screen/dwelling_photo']);
    expect(res.alreadyAcquire).toEqual([]);
    expect(res.conflicts).toEqual([]);
    expect(res.xml).toContain(
      '<upload ref="/data/photo_screen/dwelling_photo" mediatype="image/*" appearance="acquire">',
    );
  });

  it('changes ONLY the upload start tag — every other byte is preserved', () => {
    const res = addAcquireAppearance(FORM);

    // The exact defect the model-as-transport path risks: re-encoded entities,
    // normalized quoting, a mangled regex. Assert byte-equality on the rest.
    const before = FORM.split('\n').filter((l) => !l.includes('<upload '));
    const after = res.xml.split('\n').filter((l) => !l.includes('<upload '));
    expect(after).toEqual(before);
    expect(res.xml).toContain('&#x2014;');
    expect(res.xml).toContain('&apos;');
    expect(res.xml).toContain("regex(., '^[ \\t\\r\\n]+$')");

    // And the diff really is one attribute, nothing else.
    expect(res.xml.length - FORM.length).toBe(' appearance="acquire"'.length);
  });

  it('handles a self-closing image upload', () => {
    const res = addAcquireAppearance('<upload ref="/data/p" mediatype="image/jpeg"/>');
    expect(res.applied).toEqual(['/data/p']);
    expect(res.xml).toBe('<upload ref="/data/p" mediatype="image/jpeg" appearance="acquire"/>');
  });

  it('patches every image upload in a multi-photo form', () => {
    const two =
      '<upload ref="/data/a" mediatype="image/*"/>\n<upload ref="/data/b" mediatype="image/*"/>';
    const res = addAcquireAppearance(two);
    expect(res.applied).toEqual(['/data/a', '/data/b']);
    expect(res.xml.match(/appearance="acquire"/g)).toHaveLength(2);
  });
});

describe('addAcquireAppearance — NEGATIVE controls (must NOT be rewritten)', () => {
  it('is idempotent on a form that already carries acquire', () => {
    const once = addAcquireAppearance(FORM).xml;
    const twice = addAcquireAppearance(once);

    expect(twice.patched).toBe(false);
    expect(twice.applied).toEqual([]);
    expect(twice.alreadyAcquire).toEqual(['/data/photo_screen/dwelling_photo']);
    expect(twice.xml).toBe(once); // byte-identical: a re-run cannot drift the form
  });

  it('treats a compound hint containing acquire as already satisfied', () => {
    // The commcare-android contract is CONTAINS, not equals.
    const res = addAcquireAppearance(
      '<upload ref="/data/p" mediatype="image/*" appearance="acquire blocked"/>',
    );
    expect(res.alreadyAcquire).toEqual(['/data/p']);
    expect(res.patched).toBe(false);
  });

  it('reports a conflicting appearance instead of clobbering it', () => {
    const res = addAcquireAppearance(
      '<upload ref="/data/p" mediatype="image/*" appearance="signature"/>',
    );
    expect(res.patched).toBe(false);
    expect(res.applied).toEqual([]);
    expect(res.conflicts).toEqual([{ ref: '/data/p', appearance: 'signature' }]);
    expect(res.xml).toContain('appearance="signature"');
    expect(res.xml).not.toContain('acquire');
  });

  it('leaves non-image uploads alone', () => {
    const res = addAcquireAppearance(
      '<upload ref="/data/rec" mediatype="audio/*"/>\n<upload ref="/data/vid" mediatype="video/*"/>',
    );
    expect(res.patched).toBe(false);
    expect(res.applied).toEqual([]);
    expect(res.nonImageUploads).toEqual(['/data/rec', '/data/vid']);
  });

  it('leaves an upload with NO mediatype alone', () => {
    const res = addAcquireAppearance('<upload ref="/data/x"/>');
    expect(res.patched).toBe(false);
    expect(res.nonImageUploads).toEqual(['/data/x']);
  });

  it('does not touch a form with no uploads at all', () => {
    const plain = '<h:body><input ref="/data/name"/></h:body>';
    const res = addAcquireAppearance(plain);
    expect(res.patched).toBe(false);
    expect(res.xml).toBe(plain);
  });

  it("reads single-quoted attributes too, and doesn't re-quote the tag", () => {
    const res = addAcquireAppearance("<upload ref='/data/p' mediatype='image/*'/>");
    expect(res.applied).toEqual(['/data/p']);
    expect(res.xml).toBe("<upload ref='/data/p' mediatype='image/*' appearance=\"acquire\"/>");
  });
});

describe('addAcquireAppearance — MUTATION checks', () => {
  it('a patcher that ignored mediatype would fail the audio control', () => {
    // Guards against "patch every <upload>" — the obvious wrong simplification.
    const res = addAcquireAppearance('<upload ref="/data/rec" mediatype="audio/*"/>');
    expect(res.xml).not.toContain('acquire');
  });

  it('a patcher that used equality instead of CONTAINS would re-patch a compound hint', () => {
    const res = addAcquireAppearance(
      '<upload ref="/data/p" mediatype="image/*" appearance="acquire blocked"/>',
    );
    expect(res.xml.match(/appearance=/g)).toHaveLength(1);
  });

  it('a patcher that clobbered a conflict would drop the original hint', () => {
    const res = addAcquireAppearance(
      '<upload ref="/data/p" mediatype="image/*" appearance="signature"/>',
    );
    expect(res.xml).toContain('appearance="signature"');
  });
});
