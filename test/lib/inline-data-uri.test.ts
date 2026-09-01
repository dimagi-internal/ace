import { describe, expect, it } from 'vitest';
import { hasResidualDataUri, stripInlineDataUris } from '../../lib/inline-data-uri.js';

/**
 * The REAL shape emitted by `drive_read_file(exportAs: 'text/markdown')` on a
 * native Google Doc containing screenshots, captured 2026-09-01 from
 * `bednet-check-2-visit/20260828-0629`'s FLW training guide
 * (Drive `144lQyBGZ1LCh1JRMWqNfl9hl3I4mIFUXrZ2LeyhbdVU`, revision 14,
 * 264,460 characters, 16 payloads).
 *
 * Note what it is NOT: there is no `![alt](data:image/png;base64,…)` anywhere
 * in that document. Drive emits a link-reference pair with an EMPTY alt, and
 * dimagi-internal/ace#1827's suggested inline regex matches zero of the 16.
 * That is why this fixture is transcribed rather than invented.
 */
const DRIVE_EXPORT = [
  '## Before you start (one-time setup)',
  '',
  '1. **Open CommCare and start PersonalID.** Tap **GO TO CONNECT MENU** on the welcome screen — [PersonalID start](https://drive.google.com/file/d/1up1FIYAbx059EqiflRoKUTWGEKU7uJoW/view).',
  '',
  '![][image1]',
  '',
  '2. **Enter your phone number** and tap Continue — [phone entry](https://drive.google.com/file/d/1bBJM2FjPG8E2RVFEtLABkRUr3rTwZQEx/view).',
  '',
  '![][image2] ![][image3]',
  '',
  '[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(4000) + '=>',
  '',
  '[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' + 'B'.repeat(4000) + '=>',
  '',
  '[image3]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' + 'C'.repeat(4000) + '=>',
  '',
].join('\n');

describe('stripInlineDataUris — Drive reference-definition export (the real shape)', () => {
  const result = stripInlineDataUris(DRIVE_EXPORT);

  it('removes every base64 payload', () => {
    expect(result.text).not.toContain('base64,');
    expect(hasResidualDataUri(result.text)).toBe(false);
    expect(result.stripped).toHaveLength(3);
    expect(result.stripped.every((p) => p.form === 'reference-definition')).toBe(true);
    expect(result.stripped[0].mimeType).toBe('image/png');
  });

  it('collapses the document to its prose', () => {
    expect(result.bytesBefore).toBeGreaterThan(12_000);
    expect(result.bytesAfter).toBeLessThan(700);
    // The measured ratio on the live specimen was 264,460 -> 9,412 (28x).
    expect(result.bytesBefore / result.bytesAfter).toBeGreaterThan(8);
  });

  it('preserves the prose and the captions the images sit next to', () => {
    expect(result.text).toContain('**Open CommCare and start PersonalID.**');
    expect(result.text).toContain(
      '[PersonalID start](https://drive.google.com/file/d/1up1FIYAbx059EqiflRoKUTWGEKU7uJoW/view)'
    );
    expect(result.text).toContain('[phone entry](https://drive.google.com');
    expect(result.text).toContain('## Before you start (one-time setup)');
  });

  it('leaves a placeholder where each picture was, not a hole', () => {
    expect(result.text).toContain('[screenshot]');
    expect(result.text).not.toContain('![]');
    expect(result.text).not.toContain('[image1]');
  });
});

describe('stripInlineDataUris — inline form (hand-written markdown in inputs/)', () => {
  it('keeps the alt text as the placeholder label', () => {
    const md = 'Tap Continue.\n\n![Sign-in screen](data:image/png;base64,AAAA)\n\nThen wait.';
    const { text, stripped } = stripInlineDataUris(md);
    expect(text).toContain('[screenshot: Sign-in screen]');
    expect(text).toContain('Tap Continue.');
    expect(text).toContain('Then wait.');
    expect(text).not.toContain('base64,');
    expect(stripped).toHaveLength(1);
    expect(stripped[0].form).toBe('inline');
  });

  it('keeps the link label when a data: URI is a link rather than an image', () => {
    const { text } = stripInlineDataUris('See the [attached roster](data:text/csv;base64,QUJD).');
    expect(text).toBe('See the attached roster.');
  });

  it('labels a non-image payload as an embedded file', () => {
    const { text } = stripInlineDataUris('![roster](data:application/pdf;base64,QUJD)');
    expect(text).toBe('[embedded application/pdf: roster]');
  });
});

describe('stripInlineDataUris — leaves everything else alone', () => {
  it('is a no-op on a document with no embedded payloads', () => {
    const md = '# Guide\n\n![Home screen](screens/home.png)\n\nSee [the doc](https://example.com).\n';
    const result = stripInlineDataUris(md);
    expect(result.text).toBe(md);
    expect(result.stripped).toHaveLength(0);
    expect(result.bytesBefore).toBe(result.bytesAfter);
  });

  it('leaves a reference image whose definition is an ordinary URL', () => {
    const md = '![Home][home]\n\n[home]: <https://example.com/home.png>\n';
    expect(stripInlineDataUris(md).text).toBe(md);
  });

  it('does not mistake prose mentioning base64 for a payload', () => {
    const md = 'The export inlines each image as a base64 data URI.\n';
    expect(stripInlineDataUris(md).text).toBe(md);
    expect(hasResidualDataUri(md)).toBe(false);
  });

  it('handles a collapsed reference (![alt][])', () => {
    const md = '![shot][]\n\n[shot]: <data:image/png;base64,AAAA>\n';
    expect(stripInlineDataUris(md).text.trim()).toBe('[screenshot: shot]');
  });
});

describe('hasResidualDataUri', () => {
  it('is the post-condition the upload gate asserts', () => {
    expect(hasResidualDataUri('[x]: <data:image/png;base64,AAAA>')).toBe(true);
    expect(hasResidualDataUri('![a](data:image/gif;base64,AA)')).toBe(true);
    expect(hasResidualDataUri('no payloads here')).toBe(false);
  });
});
