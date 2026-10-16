/**
 * A key-feeding or duration-feeding timestamp is never a bare `now()`
 * (dimagi-internal/ace#2935).
 *
 * ## The failure class
 *
 * ace#995 made every timestamp after the first depend on an answer node, and
 * left the FIRST one (`visit_start_time`) as a bare `now()` because "form-init
 * IS its intended meaning". True of when it evaluates; false of what it
 * renders. In Nova an unbound hidden field has text semantics, and ordinary
 * text conversion of `now()` keeps only the calendar date. On
 * `tekzal/20261013-2314` the field read `2026-10-15`, and two openings of the
 * form minutes apart produced the identical key
 * `ace@dimagi-ai.com | 2026-10-15 | no` — a day's surveys payable as one.
 * Nova accepts it, `validate_app` passes, the app releases clean; the only
 * symptom is unpaid work.
 *
 * The fix is `format-date(now(), '%Y-%m-%d %H:%M:%S')` (verified on the saved
 * app in that run: `2026-10-15 05:30:25` / `05:30:28`).
 *
 * SCOPE: offline. It pins that the architect-facing prose carries the
 * format-date form and never re-blesses a bare `now()` as a timestamp, and that
 * the `entity_id` example states the grain of a date-only component.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const LIBRARY_REL = 'skills/_app-component-library.md';
const DELIVER_REL = 'skills/pdd-to-deliver-app/SKILL.md';
const FORMAT_DATE_NOW = "format-date(now(), '%Y-%m-%d %H:%M:%S')";

/** The `### section-timestamps` component, up to the next component heading. */
function sectionTimestamps(): string {
  const lib = read(LIBRARY_REL);
  const start = lib.indexOf('### section-timestamps');
  expect(start, `${LIBRARY_REL} lost its section-timestamps component`).toBeGreaterThan(0);
  const end = lib.indexOf('\n### ', start + 1);
  return lib.slice(start, end > 0 ? end : undefined);
}

/** Collapse blockquote markers and line wraps so a wrapped expression matches. */
const flatten = (s: string) => s.replace(/\n\s*>?\s*/g, ' ').replace(/\s+/g, ' ');

describe('no bare now() as a timestamp (ace#2935)', () => {
  it('section-timestamps prescribes format-date(now(), ...) for the first timestamp', () => {
    const body = flatten(sectionTimestamps());
    expect(
      body.includes(FORMAT_DATE_NOW),
      `section-timestamps must prescribe \`${FORMAT_DATE_NOW}\`: a bare now() in an ` +
        'unbound hidden field renders date-only and collapses a key to one per worker per day.',
    ).toBe(true);
  });

  it('section-timestamps no longer blesses a bare now() for any timestamp', () => {
    const body = flatten(sectionTimestamps());
    expect(
      /may be a bare `now\(\)`/.test(body),
      'section-timestamps re-introduced the ace#995 carve-out ("may be a bare `now()`") ' +
        'that ace#2935 retired.',
    ).toBe(false);
    // The chained shape must wrap now() too: `if(x = '', '', now())` is a bare now().
    expect(
      /'',\s*now\(\)\)/.test(body),
      "the chained timestamp recipe `if(<last answer> = '', '', now())` must wrap now() " +
        'in format-date — the same text semantics drop its time.',
    ).toBe(false);
  });

  it('section-timestamps explains WHY (text semantics drop the time)', () => {
    const body = flatten(sectionTimestamps());
    expect(/date-only/i.test(body) && /text semantics/i.test(body)).toBe(true);
  });

  it('the entity_id concat example does not key on a date-only component without saying so', () => {
    const deliver = flatten(read(DELIVER_REL));
    expect(
      deliver.includes("concat(#user/username, ' - ', #form/visit_date)"),
      `${DELIVER_REL}'s entity_id example keyed on #form/visit_date (per worker per day) ` +
        'as if it were the per-submission shape (ace#2935).',
    ).toBe(false);
    expect(
      /date-only component[^.]*per worker per day/i.test(deliver),
      `${DELIVER_REL} § entity_id must state that a date-only component makes the key ` +
        'per worker per day.',
    ).toBe(true);
    expect(deliver.includes(FORMAT_DATE_NOW)).toBe(true);
  });
});
