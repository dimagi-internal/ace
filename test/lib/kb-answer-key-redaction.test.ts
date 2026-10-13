import { describe, expect, it } from 'vitest';
import {
  REDACTED_CELL,
  REDACTED_LINE,
  hasResidualAnswerKey,
  redactAnswerKeys,
} from '../../lib/kb-answer-key-redaction.js';

/**
 * dimagi-internal/ace#2869 — the Learn summary's assessment answer keys must
 * not reach the FLW chatbot's RAG collection.
 *
 * The fixture is shaped on `pdd-to-learn-app_summary.md` from
 * `smallholder-seasonal/20261012-1549` (Drive 11cm_4GTzpXXD0SPfdcjIzS7UUWuc4vkbCVXNVKOPpHI,
 * exported as text/markdown). Line 129 of that export is quoted in the issue
 * and reproduced below, with the elided middle banks filled in.
 */
const SPECIMEN_KEY_LINE =
  'Discriminating-assessment self-check: every bank checked with checkAnswerKeyPattern (pass mark 80) on the BUILT keys: all 13 banks status checked, ok true. Built keys (unchanged by the repairs): m01 a,a,d,a,b; m02 d,b,b,b,c; m03 c,a,d,b,a; m12 a,b,c,b,b; final d,a,d,b,c,a,a,c,d,c,b,c.';

const LEARN_SUMMARY = [
  '---',
  'nova_app_id: 7f3c-learn',
  'nova_app_url: https://commcare.app/build/7f3c-learn',
  'archetype: longitudinal-visits',
  'nova_uuids:',
  '  modules:',
  '    - name: Final certification',
  '      uuid: m-final',
  '      forms:',
  '        - name: Certification quiz',
  '          uuid: f-final',
  '          fields:',
  '            user_score: fld-123',
  '---',
  '',
  '# Smallholder Seasonal — Learn app',
  '',
  '## Modules',
  '',
  '1. **Planting calendar** — when to plant after the first rains; how to record a planting date.',
  '2. **Final certification** — 12 questions; pass mark 80. Passing opens Deliver work in Connect.',
  '',
  '## Assessment items',
  '',
  '| Item | Module | Question | Correct option |',
  '|---|---|---|---|',
  '| q1 | m01 | When should the farmer plant? | After 20 mm of rain |',
  '| q2 | m01 | What is recorded on the planting form? | The planting date |',
  '',
  '- Which seed rate applies to maize? Options: 10 kg, **25 kg** (correct), 40 kg.',
  '',
  '## Connect configuration',
  '',
  'Assessment score field `user_score`; passing score 80.',
  '',
  '## Build notes',
  '',
  '### Language layer',
  '',
  'Chichewa: 412/412 strings translated, origin: ai, needs-review.',
  '',
  '### Repairs applied',
  '',
  '| Item | Change |',
  '|---|---|',
  "| q7 | re-keyed: calculate now `if(/data/q7 = 'b', 1, 0)` |",
  '',
  '### Assessment self-check',
  '',
  SPECIMEN_KEY_LINE,
  '',
].join('\n');

describe('redactAnswerKeys on the smallholder-seasonal Learn summary (ace#2869)', () => {
  const before = LEARN_SUMMARY;
  const { text, redactions } = redactAnswerKeys(before);

  it('the specimen DOES carry the keys before redaction (guards the fixture)', () => {
    expect(hasResidualAnswerKey(before)).toBe(true);
    expect(before).toContain('final d,a,d,b,c,a,a,c,d,c,b,c');
  });

  it('removes every key: no letter run, no Built keys label, no score literal', () => {
    expect(hasResidualAnswerKey(text)).toBe(false);
    expect(text).not.toMatch(/Built keys/i);
    expect(text).not.toContain('d,a,d,b,c');
    expect(text).not.toContain('a,a,d,a,b');
    expect(text).not.toContain("= 'b'");
  });

  it('drops the internal ## Build notes section whole', () => {
    expect(text).not.toContain('## Build notes');
    expect(text).not.toContain('Assessment self-check');
    expect(text).not.toContain('Chichewa: 412/412');
    expect(redactions.filter((r) => r.kind === 'section').map((r) => r.detail)).toEqual([
      'Build notes',
    ]);
  });

  it('blanks the correct-option column but keeps the table and its questions', () => {
    expect(text).toContain('| Item | Module | Question | Correct option |');
    expect(text).toContain('When should the farmer plant?');
    expect(text).not.toContain('After 20 mm of rain');
    expect(text).toContain(REDACTED_CELL);
  });

  it('strips an inline (correct) marker and keeps the option text', () => {
    expect(text).toContain('**25 kg**, 40 kg');
    expect(text).not.toMatch(/\(correct\)/i);
  });

  it('keeps what the chatbot needs: modules, pass mark, frontmatter', () => {
    expect(text).toContain('**Planting calendar** — when to plant after the first rains');
    expect(text).toContain('Passing opens Deliver work in Connect.');
    expect(text).toContain('passing score 80');
    expect(text.startsWith('---\nnova_app_id: 7f3c-learn')).toBe(true);
    expect(text).toContain('user_score: fld-123');
  });

  it('is idempotent', () => {
    expect(redactAnswerKeys(text).text).toBe(text);
  });
});

/**
 * The shape Drive actually returns. The summary is a Doc rendered FROM
 * markdown, so `exportAs: 'text/markdown'` escapes the hashes, the frontmatter
 * fence and underscores, and leaves two trailing spaces on soft-broken lines.
 * Copied from the real export of `smallholder-seasonal/20261012-1549`'s
 * `pdd-to-learn-app_summary.md` (lines 82-129), key line from the issue.
 */
const ESCAPED_EXPORT = [
  '\\---  ',
  'nova\\_app\\_id: f218bb4a-59e1-4d8d-922a-78f411efd671  ',
  '\\---',
  '',
  '\\#\\# What was built',
  '',
  '\\- Exactly one form, the Final certification, carries connect.assessment (id final\\_cert, user\\_score \\= \\#form/user\\_score). Pass mark 80.  ',
  '',
  '\\#\\# Build notes',
  '',
  '\\#\\#\\# Repairs applied  ',
  '',
  '| Repair | Item | Before | After |  ',
  '|---|---|---|---|  ',
  '| 1\\. 25 paid surveys a day untested | M3 check q4 | the hidden score | "28 surveys at about 8 minutes each: how many are paid?" (25) |',
  '| 2\\. 7-day home-visit window untested | M8 check q5 | harvest-complete tick | "flagged on Monday: by when is the visit due?" (within 7 days) |',
  '',
  '\\#\\#\\# Assessment self-check  ',
  SPECIMEN_KEY_LINE,
  '',
].join('\n');

describe('the escaped Drive export shape (what the live upload path sees)', () => {
  const { text, redactions } = redactAnswerKeys(ESCAPED_EXPORT);

  it('recognises an escaped \\#\\# Build notes heading and drops the section', () => {
    expect(redactions.filter((r) => r.kind === 'section').map((r) => r.detail)).toEqual([
      'Build notes',
    ]);
    expect(text).not.toContain('Build notes');
    // The repair table's "After" column carries correct answers too.
    expect(text).not.toContain('(within 7 days)');
    expect(hasResidualAnswerKey(text)).toBe(false);
  });

  it('keeps the structure section above it', () => {
    expect(text).toContain('\\#\\# What was built');
    expect(text).toContain('Pass mark 80.');
  });
});

describe('tables that are NOT answer keys keep their content', () => {
  it('a PDD Key | Value parameters table is untouched', () => {
    const src = [
      '| Key | Value |',
      '|---|---|',
      '| learn\\_passing\\_score | 80 |',
      '| currency | NGN |',
      '',
    ].join('\n');
    expect(redactAnswerKeys(src).text).toBe(src);
  });

  it('a FAQ Question | Answer table is untouched', () => {
    const src = [
      '| Question | Answer |',
      '|---|---|',
      '| How many surveys are paid a day? | 25 |',
      '',
    ].join('\n');
    expect(redactAnswerKeys(src).text).toBe(src);
  });
});

describe('the key line outside a Build notes section', () => {
  it('is replaced by the placeholder, keeping its list marker', () => {
    const { text } = redactAnswerKeys(`## Assessment\n\n- ${SPECIMEN_KEY_LINE}\n- Pass mark is 80.\n`);
    expect(text).toContain(`- ${REDACTED_LINE}`);
    expect(text).toContain('- Pass mark is 80.');
    expect(hasResidualAnswerKey(text)).toBe(false);
  });

  it('catches per-question pairs and a score calculate against a literal', () => {
    const src = [
      'Key: q1 = b, q2 = d',
      "q4_score = if(/data/q4 = 'plant_after_rains', 1, 0)",
      'Workers answer twelve questions.',
    ].join('\n');
    const { text } = redactAnswerKeys(src);
    expect(text).not.toContain('q1 = b');
    expect(text).not.toContain('plant_after_rains');
    expect(text).toContain('Workers answer twelve questions.');
  });
});

describe('a Deliver summary with no assessment is left alone', () => {
  const deliver = [
    '# Deliver app',
    '',
    '## Forms',
    '',
    '| Field | Type | Notes |',
    '|---|---|---|',
    '| meeting_conducted | select | yes / no; Connect pays on yes |',
    '| planting_date | date | required |',
    '',
    'Register a farmer from the case list, then open **Seasonal visit**.',
    '',
  ].join('\n');

  it('changes nothing outside Build notes', () => {
    const { text, redactions } = redactAnswerKeys(deliver);
    expect(text).toBe(deliver);
    expect(redactions).toEqual([]);
  });

  it('still drops a Deliver ## Build notes section (build-team bookkeeping)', () => {
    const { text } = redactAnswerKeys(`${deliver}\n## Build notes\n\nDerived-chain guard: 0 findings.\n`);
    expect(text).not.toContain('Derived-chain guard');
    expect(text).toContain('Register a farmer');
  });
});
