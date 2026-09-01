import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasResidualDataUri, stripInlineDataUris } from '../../lib/inline-data-uri.js';

/**
 * dimagi-internal/ace#1827 — no OCS upload path may push base64 image payloads
 * into an `is_index: true` RAG collection.
 *
 * Two skills download native Google Docs with
 * `drive_read_file(exportAs: 'text/markdown')` and upload the result:
 * `ocs-agent-setup` § Step 5 (PDD + `inputs/*` + app summaries) and
 * `ocs-knowledge-refresh` § Step 1 (the four training documents). The export
 * inlines every embedded image as a `data:` URI, so an illustrated document
 * reaches the index at 8-28x its prose size — measured on
 * `bednet-check-2-visit/20260828-0629`, where the training pack was 91% base64
 * by volume and indexing still reported `ready: true, pending: 0`.
 *
 * Both skills are pinned here rather than only the one the issue was filed
 * against: the second has the identical exposure (an SOP with diagrams under
 * `inputs/` is the same shape as an illustrated guide), and fixing one while
 * leaving its twin is the drift this file exists to prevent.
 */
const ROOT = join(__dirname, '..', '..');
const SCRIPT = 'scripts/strip-inline-data-uris.ts';

const UPLOAD_SKILLS = ['ocs-agent-setup', 'ocs-knowledge-refresh'] as const;

describe('OCS upload paths strip embedded data: payloads (ace#1827)', () => {
  it('ships the runnable stripper and its pure helper', () => {
    expect(existsSync(join(ROOT, SCRIPT))).toBe(true);
    expect(existsSync(join(ROOT, 'lib/inline-data-uri.ts'))).toBe(true);
  });

  for (const skill of UPLOAD_SKILLS) {
    describe(skill, () => {
      const text = readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');

      it('names the stripper script, so the constraint is runnable and not just prose', () => {
        expect(text).toContain(SCRIPT);
      });

      it('cites the issue the constraint came from', () => {
        expect(text).toMatch(/ace#1827/);
      });

      it('states the constraint as an upload rule', () => {
        expect(text.toLowerCase()).toMatch(/base64/);
        expect(text).toMatch(/data:/);
      });
    });
  }
});

/**
 * The behavioural half: the exact export shape from the specimen document,
 * asserted end to end. If a future edit loosens the stripper, this fails on the
 * same bytes that shipped into live collection 569.
 */
describe('the specimen shape from bednet-check-2-visit/20260828-0629', () => {
  const doc = [
    '1. **Open CommCare and start PersonalID.** Tap **GO TO CONNECT MENU** — [PersonalID start](https://drive.google.com/file/d/1up1FIYAbx059EqiflRoKUTWGEKU7uJoW/view).',
    '',
    '![][image1]',
    '',
    '[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(16000) + '=>',
    '',
  ].join('\n');

  it('drops the payload, keeps the step and its caption link', () => {
    const { text, bytesBefore, bytesAfter } = stripInlineDataUris(doc);
    expect(hasResidualDataUri(text)).toBe(false);
    expect(text).toContain('**Open CommCare and start PersonalID.**');
    expect(text).toContain('drive.google.com/file/d/1up1FIYAbx059EqiflRoKUTWGEKU7uJoW');
    expect(text).toContain('[screenshot]');
    expect(bytesBefore).toBeGreaterThan(16_000);
    expect(bytesAfter).toBeLessThan(300);
  });
});
