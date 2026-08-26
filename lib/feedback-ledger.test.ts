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
  isPubliclyRepublishable,
  EDIT_RECORD_SLUG,
  buildEngagements,
  deriveEditEntries,
  DEFAULT_STALE_AFTER_COMPLETED_RUNS,
  identityOfEditRow,
  identityOfRecord,
  isEditPubliclyRepublishable,
  renderEngagementMarkdown,
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

/**
 * dimagi-internal/ace#1362 — a partner reacting on the PUBLIC per-run summary
 * had nowhere in the schema to say so.
 *
 * ace-web now writes each reaction from the public summary page as a
 * `FeedbackRecordSchema` record into `ACE/<opp>/feedback/`, so this skill picks
 * it up with no new consumer. But the channel enum was
 * `['gdoc-comments','email','meeting','board','other']` and the record is
 * `.strict()`, so an anonymous public page with a SELF-REPORTED name recorded
 * as `channel: other` — materially different provenance from a gdoc comment by
 * a named colleague, and an agent reading the folder should not have to infer
 * it.
 *
 * The shipped workaround smuggled the marker into the SLUG
 * (`<YYYYMMDD>-public-<reviewer-slug>`), and ace-web filters on that marker so
 * a privately-captured review (Sophie's `20260727-sophie-feintuch`,
 * `channel: gdoc-comments`) sitting in the same folder is never republished on
 * a page anyone can open. It works — but it makes a FILENAME CONVENTION
 * load-bearing for a CONFIDENTIALITY BOUNDARY, which is exactly the thing that
 * should be a schema field.
 *
 * #1335 is the same root shape from the other direction: the schema models one
 * channel and co-creation produced more. Its `revisions` value lands here so a
 * record can be written; the derivation (Drive `revisions.list`, a diff-derived
 * body, an "accepted as-is" disposition) is deliberately NOT designed here and
 * #1335 stays open for it.
 */
describe('feedback channels (#1362, #1335)', () => {
  const base = {
    schema_version: 1 as const,
    slug: '20260813-a-partner',
    reviewer: 'A Partner',
    received_at: '2026-08-13T10:00:00Z',
    items: [{ id: 'a', verbatim: 'This row is wrong.' }],
  };

  it('accepts public-summary as a first-class channel', () => {
    const r = FeedbackRecordSchema.parse({ ...base, channel: 'public-summary' });
    expect(r.channel).toBe('public-summary');
  });

  it('accepts revisions, so a partner EDIT can be recorded at all (#1335)', () => {
    expect(FeedbackRecordSchema.parse({ ...base, channel: 'revisions' }).channel).toBe('revisions');
  });

  it('keeps every pre-existing channel parsing — the change is additive', () => {
    for (const c of ['gdoc-comments', 'email', 'meeting', 'board', 'other']) {
      expect(FeedbackRecordSchema.parse({ ...base, channel: c }).channel).toBe(c);
    }
  });

  it('still defaults to other when the channel is absent', () => {
    expect(FeedbackRecordSchema.parse(base).channel).toBe('other');
  });

  it('exposes the confidentiality boundary as a field, not a filename', () => {
    expect(isPubliclyRepublishable({ ...base, channel: 'public-summary' } as any)).toBe(true);
    expect(isPubliclyRepublishable({ ...base, channel: 'gdoc-comments' } as any)).toBe(false);
    expect(isPubliclyRepublishable({ ...base, channel: 'email' } as any)).toBe(false);
    // The pre-#1362 slug convention must NOT be what decides it.
    expect(
      isPubliclyRepublishable({ ...base, slug: '20260813-public-a-partner', channel: 'email' } as any),
    ).toBe(false);
  });

  it('renders self-reported provenance so a reader can weigh the item', () => {
    const md = renderLedgerMarkdown(
      buildLedger({ ...base, channel: 'public-summary', artifact: 'Decisions' } as any, []),
    );
    expect(md).toMatch(/self-reported/i);
  });

  it('does not label a gdoc comment as self-reported', () => {
    const md = renderLedgerMarkdown(
      buildLedger({ ...base, channel: 'gdoc-comments' } as any, []),
    );
    expect(md).not.toMatch(/self-reported/i);
  });
});

/**
 * dimagi-internal/ace#1335, decision-edit half — the ledger recorded what a
 * reviewer SAID and not what they CHANGED, so a reviewer who edited decisions
 * instead of commenting opened the "where did my comment go?" view and found
 * it empty.
 *
 * Operator ruling (Jonathan, 2026-08-14): comment or edit, the experience and
 * the visibility should be the same. Solved by DERIVING the ledger from
 * `inputs/decision-overrides.yaml` as well as from feedback records — never by
 * double-writing a feedback record on edit, which would put the same fact in
 * two stores that then drift.
 */
describe('decision edits as ledger entries (#1335)', () => {
  const editRow = {
    id: 'photo-required',
    override: 'yes',
    override_reasoning: 'A supervisor cannot verify a visit without one.',
    phase: 'idea-to-design',
    question: 'Should a delivery visit require a photo?',
    ai_default: 'no',
    decided_by: 'sfeintuch@dimagi-associate.com',
    decided_by_name: 'Sophie Feintuch',
    decided_by_verified: true,
    decided_at: '2026-07-28T09:00:00Z',
    source_run_id: '20260722-1341',
  };

  it('derives one stampable entry per saved override row', () => {
    const [e] = deriveEditEntries([editRow]);
    expect(e.ref).toBe('decision-edits/photo-required');
    expect(e.from).toBe('no');
    expect(e.to).toBe('yes');
    expect(e.reasoning).toContain('supervisor');
  });

  it('reserves the edit slug so a record can never shadow an edit ref', () => {
    expect(() =>
      FeedbackRecordSchema.parse({
        schema_version: 1,
        slug: EDIT_RECORD_SLUG,
        reviewer: 'Impostor',
        received_at: '2026-08-14',
        items: [{ id: 'photo-required', verbatim: 'x' }],
      }),
    ).toThrow();
  });

  // An edit is not a comment: it already changed the next run's input, so it
  // is self-routing for its own value. Calling it UNROUTED would accuse ACE of
  // dropping something that already landed.
  it('never marks an edit UNROUTED, even with no disposition at all', () => {
    const edits = deriveEditEntries([editRow]);
    const { engagements } = buildEngagements({ edits });
    const out = renderEngagementMarkdown(engagements[0]);
    expect(out).not.toContain('UNROUTED');
    expect(out).toContain('PENDING NEXT RUN');
  });

  // ...but "the value landed" and "the work that follows from it landed" are
  // different questions, so an edit still carries downstream dispositions.
  it('shows APPLIED once a run recorded the value, and still takes a stamp', () => {
    const edits = deriveEditEntries([editRow], {
      boundValues: new Map([['photo-required', 'yes']]),
      dispositions: [
        {
          feedbackRef: 'decision-edits/photo-required',
          kind: 'skill-fix',
          summary: 'Deliver form now captures a photo',
          link: 'https://github.com/dimagi-internal/ace/issues/1',
          status: 'shipped',
        },
      ],
    });
    expect(edits[0].binding).toBe('applied');
    const out = renderEngagementMarkdown(buildEngagements({ edits }).engagements[0]);
    expect(out).toContain('**APPLIED**');
    expect(out).toContain('Deliver form now captures a photo');
  });

  it('does not claim an edit landed without evidence that it did', () => {
    expect(deriveEditEntries([editRow])[0].binding).toBe('pending');
    expect(
      deriveEditEntries([editRow], {
        boundValues: new Map([['photo-required', 'no']]),
      })[0].binding,
    ).toBe('pending');
  });

  it('renders a revert as the act it is, not as a missing row', () => {
    const [e] = deriveEditEntries([
      { id: 'gps-radius', override: '50m', ai_default: '50m' },
    ]);
    expect(e.revert).toBe(true);
    const out = renderEngagementMarkdown(buildEngagements({ edits: [e] }).engagements[0]);
    expect(out).toContain('You put it back');
  });

  it('counts buried values so a superseded edit is visibly recoverable', () => {
    const [e] = deriveEditEntries([
      { ...editRow, history: [{ override: 'no' }, { override: 'maybe' }] },
    ]);
    expect(e.supersedes).toBe(2);
    const out = renderEngagementMarkdown(buildEngagements({ edits: [e] }).engagements[0]);
    expect(out).toContain('Replaced 2 earlier values');
  });

  it('reads one person\'s comments and edits as ONE ordered list', () => {
    const edits = deriveEditEntries([editRow]);
    const { engagements } = buildEngagements({
      records: [record],
      edits,
      dispositions,
    });
    // record is `channel: gdoc-comments` with reviewer_email == decided_by,
    // and both sides are verified — so they are one person, one bucket.
    expect(engagements).toHaveLength(1);
    const kinds = engagements[0].entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'comment')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'edit')).toHaveLength(1);
    // 2026-07-27 comments precede the 2026-07-28 edit.
    expect(kinds[kinds.length - 1]).toBe('edit');
    expect(engagements[0].coverage).toMatchObject({ comments: 3, edits: 1 });
  });

  it('gives an edits-only reviewer a view instead of nothing', () => {
    const { engagements } = buildEngagements({
      edits: deriveEditEntries([
        { ...editRow, decided_by: 'new@dimagi.com', decided_by_name: 'New Person' },
      ]),
    });
    expect(engagements).toHaveLength(1);
    expect(engagements[0].identity.name).toBe('New Person');
    expect(renderEngagementMarkdown(engagements[0])).toContain(
      'Where your input went — New Person',
    );
  });

  /**
   * The state machine, pinned (ace#1549).
   *
   * `binding` had exactly two states, so an override whose decision id no
   * run will ever raise again rendered identically to one that binds
   * tomorrow: `PENDING NEXT RUN`, forever. Overrides match on `id` alone and
   * an unmatched id is dropped by design, so a design change that retires a
   * decision silently retires the reviewer's answer — and the one view built
   * to say where their input went asserted the opposite.
   *
   * Every case below is about the DISCRIMINATOR, because getting it wrong in
   * the other direction (calling a live override dead) would make this view
   * more misleading than the fall-through it replaces.
   */
  describe('stale overrides — the id stopped being raised (#1549)', () => {
    const run = (
      runId: string,
      completedAt: string,
      raisedIds: string[] = [],
    ) => ({ runId, completedAt, raisedIds });

    // The defect itself, stated as the property that must hold.
    it('does NOT render a never-raised-again override as PENDING', () => {
      const edits = deriveEditEntries([editRow], {
        completedRuns: [
          run('20260812-0900', '2026-08-12T11:00:00Z', ['gps-radius']),
          run('20260805-0900', '2026-08-05T11:00:00Z', ['gps-radius']),
        ],
      });
      expect(edits[0].binding).toBe('stale');
      const out = renderEngagementMarkdown(
        buildEngagements({ edits }).engagements[0],
      );
      expect(out).not.toContain('PENDING NEXT RUN');
      expect(out).toContain('STALE — NOT BINDING');
      // The evidence is named, so the reviewer can check it themselves.
      expect(out).toContain('20260812-0900');
      expect(out).toContain('20260805-0900');
    });

    it('needs the full threshold of misses — one is not evidence', () => {
      expect(DEFAULT_STALE_AFTER_COMPLETED_RUNS).toBe(2);
      const [e] = deriveEditEntries([editRow], {
        completedRuns: [run('20260812-0900', '2026-08-12T11:00:00Z')],
      });
      expect(e.binding).toBe('pending');
      expect(e.missedRuns).toEqual(['20260812-0900']);
    });

    it('lets a caller set its own bar without touching the code', () => {
      const [e] = deriveEditEntries([editRow], {
        completedRuns: [run('20260812-0900', '2026-08-12T11:00:00Z')],
        staleAfterCompletedRuns: 1,
      });
      expect(e.binding).toBe('stale');
    });

    // A run that HALTED raises none of the ids downstream of where it
    // stopped. It is not admissible evidence, and the caller keeps it out of
    // `completedRuns` — with none supplied, nothing may ever read stale.
    it('stays PENDING when no completed-run evidence is supplied at all', () => {
      const [e] = deriveEditEntries([editRow]);
      expect(e.binding).toBe('pending');
      expect(e.missedRuns).toEqual([]);
    });

    // Ordering is the other half of the discriminator: runs that finished
    // BEFORE the edit was saved never had a chance to bind it.
    it('ignores runs that completed before the edit was saved', () => {
      const [e] = deriveEditEntries([editRow], {
        completedRuns: [
          run('20260710-0900', '2026-07-10T11:00:00Z'),
          run('20260715-0900', '2026-07-15T11:00:00Z'),
        ],
      });
      expect(e.binding).toBe('pending');
      expect(e.missedRuns).toEqual([]);
    });

    it('ignores a run it cannot order against the edit', () => {
      expect(
        deriveEditEntries([editRow], {
          completedRuns: [
            { runId: 'a', raisedIds: [] },
            { runId: 'b', raisedIds: [], completedAt: 'not-a-date' },
          ],
        })[0].binding,
      ).toBe('pending');
      // ...and an undated EDIT cannot be ordered either, so it never goes stale.
      const { decided_at: _omitted, ...undated } = editRow;
      expect(
        deriveEditEntries([undated], {
          completedRuns: [
            run('20260812-0900', '2026-08-12T11:00:00Z'),
            run('20260805-0900', '2026-08-05T11:00:00Z'),
          ],
        })[0].binding,
      ).toBe('pending');
    });

    it('a run that DID raise the id is not a miss', () => {
      const [e] = deriveEditEntries([editRow], {
        completedRuns: [
          run('20260812-0900', '2026-08-12T11:00:00Z', ['photo-required']),
          run('20260805-0900', '2026-08-05T11:00:00Z', ['photo-required']),
        ],
      });
      expect(e.binding).toBe('pending');
      expect(e.missedRuns).toEqual([]);
    });

    // A value a run recorded is a fact; later silence does not unmake it.
    it('never downgrades an APPLIED edit to stale', () => {
      const [e] = deriveEditEntries([editRow], {
        boundValues: new Map([['photo-required', 'yes']]),
        completedRuns: [
          run('20260812-0900', '2026-08-12T11:00:00Z'),
          run('20260805-0900', '2026-08-05T11:00:00Z'),
        ],
      });
      expect(e.binding).toBe('applied');
      expect(e.missedRuns).toEqual([]);
    });

    // The coverage line is what the reply email leads with (SKILL § 4), so a
    // dead override has to be visible there — not only in the entry body.
    it('counts a stale edit in the coverage line and as needing a human', () => {
      const edits = deriveEditEntries([editRow], {
        completedRuns: [
          run('20260812-0900', '2026-08-12T11:00:00Z'),
          run('20260805-0900', '2026-08-05T11:00:00Z'),
        ],
      });
      const [engagement] = buildEngagements({ edits }).engagements;
      expect(engagement.coverage).toMatchObject({
        edits: 1,
        editsApplied: 0,
        editsStale: 1,
        awaitingHuman: 1,
      });
      const out = renderEngagementMarkdown(engagement);
      expect(out).toContain('1 edit — 0 applied, 1 stale');
      expect(out).toContain('1 need a human');
    });

    // It is a third state, not a rebranded UNROUTED: nothing was dropped by
    // ACE, the reviewer's value is still saved and still recoverable.
    it('is not UNROUTED, and still takes downstream stamps', () => {
      const edits = deriveEditEntries([editRow], {
        completedRuns: [
          run('20260812-0900', '2026-08-12T11:00:00Z'),
          run('20260805-0900', '2026-08-05T11:00:00Z'),
        ],
        dispositions: [
          {
            feedbackRef: 'decision-edits/photo-required',
            kind: 'skill-fix',
            summary: 'Deliver form captures a photo regardless',
            status: 'shipped',
          },
        ],
      });
      const out = renderEngagementMarkdown(
        buildEngagements({ edits }).engagements[0],
      );
      expect(out).not.toContain('UNROUTED');
      expect(out).toContain('Deliver form captures a photo regardless');
    });
  });

  it('surfaces a stamp pointing at a nonexistent edit as a broken stamp', () => {
    const { orphans } = buildEngagements({
      edits: deriveEditEntries([editRow]),
      dispositions: [
        {
          feedbackRef: 'decision-edits/no-such-row',
          kind: 'skill-fix',
          summary: 'typo',
          status: 'shipped',
        },
      ],
    });
    expect(orphans).toHaveLength(1);
  });
});

/**
 * Identity reconciliation. A ledger record spells a reviewer as `reviewer` +
 * `reviewer_email`; an override row spells them as `decided_by_name` +
 * `decided_by_verified`. Joining them must never let a SELF-REPORTED name be
 * treated as a verified identity — anyone can type a real person's name into
 * the public run summary's name box.
 */
describe('identity join', () => {
  it('joins a verified edit to a review by authenticated email', () => {
    expect(
      identityOfEditRow({
        id: 'x',
        override: 'y',
        decided_by: 'SFeintuch@dimagi-associate.com',
        decided_by_name: 'Sophie Feintuch',
        decided_by_verified: true,
      }).key,
    ).toBe(identityOfRecord(record).key);
  });

  it('does NOT let a self-reported name join a verified reviewer', () => {
    const impostor = identityOfEditRow({
      id: 'x',
      override: 'y',
      decided_by: 'sfeintuch@dimagi-associate.com',
      decided_by_name: 'Sophie Feintuch',
      decided_by_verified: false,
    });
    expect(impostor.verified).toBe(false);
    expect(impostor.key).not.toBe(identityOfRecord(record).key);
    // Not even the email is a join key when the actor was never authenticated.
    expect(impostor.key).toBe('self-reported:sophie-feintuch');
    expect(impostor.email).toBeUndefined();
  });

  it('treats a public-summary record as self-reported, an email as not', () => {
    const pub = identityOfRecord(
      FeedbackRecordSchema.parse({
        schema_version: 1,
        slug: '20260814-public-anne',
        reviewer: 'Sophie Feintuch',
        reviewer_email: 'sfeintuch@dimagi-associate.com',
        received_at: '2026-08-14',
        channel: 'public-summary',
        items: [{ id: 'a', verbatim: 'hi' }],
      }),
    );
    expect(pub.verified).toBe(false);
    expect(pub.key).not.toBe(identityOfRecord(record).key);
  });

  it('says self-reported on the rendered page, every time', () => {
    const { engagements } = buildEngagements({
      edits: deriveEditEntries([
        { id: 'x', override: 'y', decided_by_name: 'Anne', decided_by_verified: false },
      ]),
    });
    expect(renderEngagementMarkdown(engagements[0])).toContain(
      'Identity **self-reported**',
    );
  });

  it('keeps two unverified people apart, and two acts by one together', () => {
    const { engagements } = buildEngagements({
      edits: deriveEditEntries([
        { id: 'a', override: '1', decided_by_name: 'Anne K', decided_by_verified: false },
        { id: 'b', override: '2', decided_by_name: 'anne k', decided_by_verified: false },
        { id: 'c', override: '3', decided_by_name: 'Bo T', decided_by_verified: false },
      ]),
    });
    expect(engagements).toHaveLength(2);
    expect(engagements[0].coverage.edits).toBe(2);
  });
});

/**
 * The confidentiality boundary, applied AT THE JOIN.
 *
 * Each source already filters itself — ace-web republishes only
 * `public-summary` feedback, and serves every override row by policy. But a
 * view whose job is to MERGE the two can reintroduce the leak both sources
 * avoid: merging a private gdoc review with public edits and publishing the
 * result republishes the private review. Merged output is publishable only if
 * EVERY entry in it is.
 */
describe('public audience filter', () => {
  const publicRecord = FeedbackRecordSchema.parse({
    schema_version: 1,
    slug: '20260814-public-anne',
    reviewer: 'Anne',
    received_at: '2026-08-14',
    channel: 'public-summary',
    items: [{ id: 'loud-one', verbatim: 'This row is wrong.' }],
  });

  it('drops a privately-captured review from a public-audience build', () => {
    const { engagements } = buildEngagements({
      records: [record, publicRecord],
      audience: 'public',
    });
    const rendered = engagements.map((e) => renderEngagementMarkdown(e)).join('\n');
    expect(rendered).not.toContain('visit_outcome is the first question');
    expect(rendered).toContain('This row is wrong.');
  });

  it('keeps everything for the default internal audience', () => {
    const { engagements } = buildEngagements({ records: [record, publicRecord] });
    expect(engagements).toHaveLength(2);
  });

  it('keeps edits public — ace-web already serves every override row', () => {
    const edits = deriveEditEntries([
      { id: 'x', override: 'y', decided_by_name: 'M', decided_by_verified: true },
    ]);
    expect(isEditPubliclyRepublishable(edits[0])).toBe(true);
    expect(
      buildEngagements({ edits, audience: 'public' }).engagements,
    ).toHaveLength(1);
  });

  it('never carries a private comment into public output via an edit bucket', () => {
    // Same human, both acts: the verified edit survives the public filter,
    // the private gdoc comment does not — the bucket is not a loophole.
    const edits = deriveEditEntries([
      {
        id: 'photo-required',
        override: 'yes',
        decided_by: 'sfeintuch@dimagi-associate.com',
        decided_by_name: 'Sophie Feintuch',
        decided_by_verified: true,
      },
    ]);
    const { engagements } = buildEngagements({
      records: [record],
      edits,
      audience: 'public',
    });
    expect(engagements).toHaveLength(1);
    expect(engagements[0].coverage).toMatchObject({ comments: 0, edits: 1 });
  });
});
