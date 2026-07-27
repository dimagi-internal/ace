import { describe, it, expect } from 'vitest';
import {
  buildLedger,
  buildLedgerWithOrphans,
  extractFeedbackRefs,
  formatFeedbackRef,
  parseFeedbackRecord,
  parseFeedbackRef,
  renderLedgerMarkdown,
  FeedbackRecordSchema,
  type Disposition,
  type FeedbackRecord,
} from './feedback-ledger';

// A trimmed slice of the REAL 2026-07-27 Sophie Feintuch review of
// hh-poverty-targeting — one item of each kind that review produced.
const RECORD_YAML = `
schema_version: 1
slug: 20260727-sophie-feintuch
reviewer: Sophie Feintuch
reviewer_email: sfeintuch@dimagi-associate.com
received_at: 2026-07-27
channel: gdoc-comments
artifact: "PDD — Household Poverty Targeting Survey"
artifact_url: https://docs.google.com/document/d/1u-QzTn1G82n5U5J5txjUFjoNOnlQzGEnmU3B57AcYNs/edit
against_run: 20260722-1341
items:
  - id: d
    anchor: "§5 Visit definition"
    verbatim: >-
      visit_outcome is the first question in the form, which is impossible for
      an FLW to answer at that point.
  - id: c
    anchor: "§5 non-payable outcomes"
    verbatim: These still need to capture GPS
  - id: f
    anchor: "§6 duplicates"
    verbatim: I think this doesn't work when the accuracy tolerance is 50m
`;

const record: FeedbackRecord = parseFeedbackRecord(RECORD_YAML);

const dispositions: Disposition[] = [
  {
    feedbackRef: '20260727-sophie-feintuch/d',
    kind: 'skill-fix',
    summary: 'Ask observations, compute the outcome',
    link: 'https://github.com/dimagi-internal/ace/issues/979',
    status: 'shipped',
    landedInRun: '20260728-1030',
  },
  {
    feedbackRef: '20260727-sophie-feintuch/c',
    kind: 'decision',
    summary: 'GPS now captured on vacant/refused visits',
    link: 'decisions.yaml#gps-on-non-payable',
    status: 'shipped',
    landedInRun: '20260728-1030',
  },
  {
    feedbackRef: '20260727-sophie-feintuch/f',
    kind: 'open-question',
    summary: 'Dedup radius must clear the 50m accuracy floor — value is a PM call',
    link: 'open-questions.md#dedup-radius',
    status: 'awaiting-human',
  },
];

describe('FeedbackRecordSchema', () => {
  it('parses a real review record', () => {
    expect(record.items).toHaveLength(3);
    expect(record.reviewer).toBe('Sophie Feintuch');
  });

  it('keeps the reviewer\'s words verbatim, not paraphrased', () => {
    expect(record.items[2].verbatim).toBe(
      "I think this doesn't work when the accuracy tolerance is 50m",
    );
  });

  it('rejects an unknown field rather than silently dropping it', () => {
    expect(() =>
      FeedbackRecordSchema.parse({ ...record, disposition: 'fixed' }),
    ).toThrow();
  });

  it('rejects a record with no items', () => {
    expect(() => FeedbackRecordSchema.parse({ ...record, items: [] })).toThrow();
  });
});

describe('feedback refs', () => {
  it('round-trips', () => {
    const ref = formatFeedbackRef('20260727-sophie-feintuch', 'd');
    expect(ref).toBe('20260727-sophie-feintuch/d');
    expect(parseFeedbackRef(ref)).toEqual({
      slug: '20260727-sophie-feintuch',
      itemId: 'd',
    });
  });

  it('rejects a malformed ref', () => {
    expect(parseFeedbackRef('not a ref')).toBeNull();
    expect(parseFeedbackRef('too/many/parts')).toBeNull();
  });

  it('extracts trailers from an issue body, deduped', () => {
    const body = [
      'Root cause: the form asks a derived value first.',
      '',
      'Feedback-Ref: 20260727-sophie-feintuch/d',
      'Feedback-Ref: 20260727-sophie-feintuch/d',
      'Feedback-Ref: 20260727-sophie-feintuch/b',
    ].join('\n');
    expect(extractFeedbackRefs(body)).toEqual([
      '20260727-sophie-feintuch/d',
      '20260727-sophie-feintuch/b',
    ]);
  });

  it('finds no trailer in an unstamped body', () => {
    expect(extractFeedbackRefs('A normal issue with no provenance.')).toEqual([]);
  });
});

describe('buildLedger', () => {
  it('joins each disposition onto its item', () => {
    const ledger = buildLedger(record, dispositions);
    const d = ledger.rows.find((r) => r.item.id === 'd')!;
    expect(d.dispositions[0].link).toContain('issues/979');
    expect(d.unrouted).toBe(false);
  });

  it('marks an item nobody claimed as UNROUTED — the completeness check', () => {
    const ledger = buildLedger(record, dispositions.slice(0, 2));
    const f = ledger.rows.find((r) => r.item.id === 'f')!;
    expect(f.unrouted).toBe(true);
    expect(ledger.coverage.unrouted).toBe(1);
  });

  it('lists every item even when nothing was routed at all', () => {
    const ledger = buildLedger(record, []);
    expect(ledger.rows).toHaveLength(3);
    expect(ledger.coverage.routed).toBe(0);
    expect(ledger.coverage.unrouted).toBe(3);
  });

  it('counts an item shipped only when EVERY disposition on it shipped', () => {
    const partly: Disposition[] = [
      dispositions[0],
      {
        feedbackRef: '20260727-sophie-feintuch/d',
        kind: 'decision',
        summary: 'Consent copy still pending',
        status: 'pending',
      },
    ];
    const ledger = buildLedger(record, partly);
    expect(ledger.coverage.routed).toBe(1);
    expect(ledger.coverage.shipped).toBe(0); // half-fixed is not fixed
  });

  it('reports items still awaiting a human', () => {
    expect(buildLedger(record, dispositions).coverage.awaitingHuman).toBe(1);
  });

  it('surfaces a stamp pointing at a nonexistent item as an orphan', () => {
    const { ledger, orphans } = buildLedgerWithOrphans(record, [
      ...dispositions,
      {
        feedbackRef: '20260727-sophie-feintuch/typo',
        kind: 'skill-fix',
        summary: 'Stamped with a bad id',
        status: 'shipped',
      },
    ]);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].feedbackRef).toBe('20260727-sophie-feintuch/typo');
    // The real items are unaffected.
    expect(ledger.coverage.unrouted).toBe(0);
  });
});

describe('renderLedgerMarkdown', () => {
  it("leads with the reviewer's own words so they recognise the comment", () => {
    const out = renderLedgerMarkdown(buildLedger(record, dispositions));
    const quoteIdx = out.indexOf('> visit_outcome is the first question');
    const dispIdx = out.indexOf('issues/979');
    expect(quoteIdx).toBeGreaterThan(-1);
    expect(quoteIdx).toBeLessThan(dispIdx);
  });

  it('summarises coverage up top', () => {
    const out = renderLedgerMarkdown(buildLedger(record, dispositions));
    expect(out).toContain('3 comments — 2 shipped, 1 need a human, 0 unrouted');
  });

  it('renders NEEDS YOU for an item awaiting a human', () => {
    const out = renderLedgerMarkdown(buildLedger(record, dispositions));
    expect(out).toMatch(/\*\*NEEDS YOU\*\* · open question/);
  });

  it('renders an UNROUTED item loudly rather than omitting it', () => {
    const out = renderLedgerMarkdown(buildLedger(record, []));
    expect(out).toContain('**UNROUTED**');
    // All three still appear — a silent omission is the failure we are avoiding.
    expect(out).toContain('[d]');
    expect(out).toContain('[c]');
    expect(out).toContain('[f]');
  });

  it('renders a broken-stamps section when a ref points nowhere', () => {
    const { ledger, orphans } = buildLedgerWithOrphans(record, [
      {
        feedbackRef: '20260727-sophie-feintuch/nope',
        kind: 'skill-fix',
        summary: 'bad stamp',
        status: 'shipped',
      },
    ]);
    const out = renderLedgerMarkdown(ledger, orphans);
    expect(out).toContain('## Broken stamps');
    expect(out).toContain('20260727-sophie-feintuch/nope');
  });

  it('omits the broken-stamps section when there are none', () => {
    const out = renderLedgerMarkdown(buildLedger(record, dispositions), []);
    expect(out).not.toContain('Broken stamps');
  });

  it('quotes a multi-line comment without breaking the blockquote', () => {
    const multi = parseFeedbackRecord(`
schema_version: 1
slug: t
reviewer: R
received_at: 2026-07-27
items:
  - id: a
    verbatim: |-
      line one
      line two
`);
    const out = renderLedgerMarkdown(buildLedger(multi, []));
    expect(out).toContain('> line one\n> line two');
  });
});
