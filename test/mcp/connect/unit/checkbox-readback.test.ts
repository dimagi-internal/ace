/**
 * Boolean-checkbox read-back (dimagi-internal/ace#1491).
 *
 * Django renders a boolean checkbox with NO `value` attribute:
 *
 *   <input type="checkbox" name="is_test" class="simple-toggle …" id="id_is_test" checked>
 *
 * `extractFormFieldValues` reads `value="…"`, so a checked box and an
 * unchecked box both extract to `''`. The state lives only in the raw tag.
 * Reading the map alone therefore mis-answers every boolean on Connect's
 * opportunity edit form — and it did, in BOTH directions:
 *
 *   is_test: v['is_test'] === 'on' || v['is_test'] === 'true'   → always FALSE
 *   active:  … || v['active'] === ''                            → always TRUE
 *
 * The first made `connect-opp-setup`'s mandated verify-after-create `is_test`
 * comparison unpassable (it is an `[INFO]`, so it corroded rather than
 * blocked); the second silently re-broke the single-active-opp WARN.
 *
 * The WRITE path had the correct predicate inline the whole time. It is now
 * `isCheckboxChecked`, shared by both reads and the write, so a read and a
 * write of the same checkbox cannot disagree again.
 *
 * These assertions run against the LIVE-CAPTURED edit form already committed
 * at test/fixtures/connect-html/ — not a hand-written approximation of what
 * Django emits, which is precisely the assumption that failed here. The old
 * guard (`registration-signature-drift.test.ts`) matched the SOURCE TEXT of
 * the parse expression and passed happily while the parse was wrong; matching
 * behavior is the point.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFormFieldValues,
  isCheckboxChecked,
} from '../../../../mcp/connect/backends/html-scrape.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE = path.join(
  REPO_ROOT,
  'test/fixtures/connect-html/opportunity-dea88661-1cd6-486b-ab25-48584bf61a8e-edit.html',
);

const html = fs.readFileSync(FIXTURE, 'utf8');
const values = extractFormFieldValues(html);

describe('boolean checkbox read-back on the live opportunity edit form', () => {
  it('the fixture really does render a valueless checked checkbox (the whole premise)', () => {
    expect(html).toMatch(/name="is_test"[^>]*\bchecked\b/);
    expect(html).not.toMatch(/name="is_test"[^>]*\bvalue=/);
    // …and that is why the extracted map cannot answer the question alone.
    expect(values['is_test']).toBe('');
  });

  it('reads a CHECKED valueless checkbox as true', () => {
    expect(isCheckboxChecked(values, html, 'is_test')).toBe(true);
  });

  it('reads an UNCHECKED checkbox as false', () => {
    const unchecked = html.replace(/(name="is_test"[^>]*?)\s+checked/, '$1');
    expect(unchecked).not.toMatch(/name="is_test"[^>]*\bchecked\b/);
    expect(isCheckboxChecked(extractFormFieldValues(unchecked), unchecked, 'is_test')).toBe(false);
  });

  it('does not report `active` as true just because it is valueless (the opposite-sign bug)', () => {
    const unchecked = html.replace(/(name="active"[^>]*?)\s+checked/, '$1');
    expect(isCheckboxChecked(extractFormFieldValues(unchecked), unchecked, 'active')).toBe(false);
  });

  it('honours an explicit submitted value where a surface renders one', () => {
    expect(isCheckboxChecked({ x: 'on' }, '', 'x')).toBe(true);
    expect(isCheckboxChecked({ x: 'true' }, '', 'x')).toBe(true);
    expect(isCheckboxChecked({ x: 'off' }, '<input name="x" checked>', 'x')).toBe(false);
  });

  it('is name-exact — a checkbox does not answer for a differently-named sibling', () => {
    const only = '<input type="checkbox" name="is_test_mode" checked>';
    expect(isCheckboxChecked({}, only, 'is_test')).toBe(false);
  });
});
