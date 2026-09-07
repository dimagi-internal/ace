/**
 * A zero-match `replaceAllText` must be visible in the tool result
 * (dimagi-internal/ace#2126).
 *
 * Google returns 200 for a replacement whose placeholder is not in the
 * template, and — the part that made this expensive — OMITS
 * `occurrencesChanged` entirely rather than sending `0`. So the naive read
 * (`reply.replaceAllText.occurrencesChanged > 0`) is undefined-vs-number, and
 * the naive fix (only report keys whose reply says 0) reports nothing at all
 * for exactly the case it exists to catch. Both shapes are pinned below.
 */
import { describe, it, expect } from 'vitest';

import { summarizeReplacementCoverage } from '../../lib/replacement-coverage.js';

describe('replacement coverage (#2126)', () => {
  it('reports nothing unmatched when every key hit at least once', () => {
    const cov = summarizeReplacementCoverage(
      ['{{a}}', '{{b}}'],
      [{ replaceAllText: { occurrencesChanged: 1 } }, { replaceAllText: { occurrencesChanged: 3 } }],
    );
    expect(cov.unmatchedReplacements).toEqual([]);
    expect(cov.warning).toBeUndefined();
    expect(cov.occurrences).toEqual({ '{{a}}': 1, '{{b}}': 3 });
  });

  it('flags a key whose reply OMITS occurrencesChanged — the real zero shape', () => {
    // This is what the live API sent for {{partner_first_reference}}: an empty
    // replaceAllText reply, not `occurrencesChanged: 0`.
    const cov = summarizeReplacementCoverage(
      ['{{present}}', '{{partner_first_reference}}'],
      [{ replaceAllText: { occurrencesChanged: 2 } }, { replaceAllText: {} }],
    );
    expect(cov.unmatchedReplacements).toEqual(['{{partner_first_reference}}']);
    expect(cov.occurrences['{{partner_first_reference}}']).toBe(0);
  });

  it('flags an explicit occurrencesChanged: 0 too', () => {
    const cov = summarizeReplacementCoverage(
      ['{{gone}}'],
      [{ replaceAllText: { occurrencesChanged: 0 } }],
    );
    expect(cov.unmatchedReplacements).toEqual(['{{gone}}']);
  });

  it('treats a missing or short replies array as all-unmatched, never as success', () => {
    // Failing OPEN here would reproduce the bug: silence must not read as
    // "everything matched".
    expect(summarizeReplacementCoverage(['{{a}}', '{{b}}'], []).unmatchedReplacements).toEqual([
      '{{a}}',
      '{{b}}',
    ]);
    expect(summarizeReplacementCoverage(['{{a}}'], undefined).unmatchedReplacements).toEqual([
      '{{a}}',
    ]);
    expect(
      summarizeReplacementCoverage(
        ['{{a}}', '{{b}}'],
        [{ replaceAllText: { occurrencesChanged: 1 } }],
      ).unmatchedReplacements,
    ).toEqual(['{{b}}']);
  });

  it('pairs keys to replies POSITIONALLY, matching how the requests were sent', () => {
    const cov = summarizeReplacementCoverage(
      ['{{first}}', '{{second}}', '{{third}}'],
      [
        { replaceAllText: {} },
        { replaceAllText: { occurrencesChanged: 5 } },
        { replaceAllText: {} },
      ],
    );
    expect(cov.unmatchedReplacements).toEqual(['{{first}}', '{{third}}']);
    expect(cov.occurrences).toEqual({ '{{first}}': 0, '{{second}}': 5, '{{third}}': 0 });
  });

  it('names the dropped keys and the drift probe in the warning', () => {
    // The warning is what an agent reads mid-run; "some replacements failed"
    // is not actionable, the key name and the next command are.
    const cov = summarizeReplacementCoverage(
      ['{{partner_first_reference}}'],
      [{ replaceAllText: {} }],
    );
    expect(cov.warning).toContain('{{partner_first_reference}}');
    expect(cov.warning).toMatch(/silently dropped/i);
    expect(cov.warning).toContain('probe-work-order-template-drift');
  });

  it('handles an empty key list without inventing a warning', () => {
    const cov = summarizeReplacementCoverage([], []);
    expect(cov).toEqual({ occurrences: {}, unmatchedReplacements: [] });
  });
});
