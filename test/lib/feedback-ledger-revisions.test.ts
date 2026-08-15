/**
 * ace#1335 — the ledger modelled feedback as COMMENTS. Co-creation grants
 * partners EDITOR access by default, so feedback now also arrives as document
 * revisions: no comment anchor, no verbatim quote, nothing to render. A
 * partner who improved a PDD by editing it directly produced ZERO ledger rows,
 * and the completeness property — an item nobody actioned shows up as UNROUTED
 * rather than vanishing — silently did not hold for that channel.
 */
import { describe, it, expect } from 'vitest';
import {
  FeedbackItemSchema,
  FeedbackRecordSchema,
  deriveRevisionItems,
  itemBody,
  buildLedger,
  FEEDBACK_LEDGER_SCHEMA_VERSION,
  type Disposition,
} from '../../lib/feedback-ledger';

const rev = (over = {}) => ({
  id: '1783',
  modifiedTime: '2026-08-14T11:00:00.000Z',
  lastModifyingUser: { displayName: 'Sophie Feintuch', emailAddress: 's@partner.org' },
  ...over,
});

describe('an item carries exactly one body', () => {
  it('accepts a comment (verbatim only)', () => {
    expect(FeedbackItemSchema.safeParse({ id: 'd', verbatim: 'Use 50 m, not 30.' }).success).toBe(true);
  });

  it('accepts an edit (change only)', () => {
    expect(
      FeedbackItemSchema.safeParse({ id: 'rev-1783-1', change: { before: 'a', after: 'b' } }).success,
    ).toBe(true);
  });

  it('rejects BOTH — that would be guessing at words nobody wrote', () => {
    const r = FeedbackItemSchema.safeParse({ id: 'd', verbatim: 'x', change: { before: 'a', after: 'b' } });
    expect(r.success).toBe(false);
  });

  it('rejects NEITHER — there would be nothing to render', () => {
    expect(FeedbackItemSchema.safeParse({ id: 'd' }).success).toBe(false);
  });

  it('rejects a change with no before AND no after', () => {
    expect(
      FeedbackItemSchema.safeParse({ id: 'r', change: { before: '', after: '' } }).success,
    ).toBe(false);
  });
});

describe('deriveRevisionItems', () => {
  it('turns a changed paragraph into one item, not a dozen', () => {
    // A word-level diff would shatter a rewritten paragraph into many rows,
    // each reading as its own ignored piece of feedback.
    const items = deriveRevisionItems({
      revision: rev(),
      before: '# Design\nThe worker visits once.\nEnd.',
      after: '# Design\nThe worker visits twice, seven days apart.\nEnd.',
    });
    expect(items).toHaveLength(1);
    expect(items[0].change!.before).toBe('The worker visits once.');
    expect(items[0].change!.after).toBe('The worker visits twice, seven days apart.');
  });

  it('records who edited it and when', () => {
    const [item] = deriveRevisionItems({
      revision: rev(),
      before: 'a',
      after: 'b',
    });
    expect(item.change!.edited_by).toBe('Sophie Feintuch');
    expect(item.change!.edited_at).toBe('2026-08-14T11:00:00.000Z');
    expect(item.change!.revision_id).toBe('1783');
  });

  it('anchors the row to the nearest preceding heading', () => {
    const [item] = deriveRevisionItems({
      revision: rev(),
      before: '# Design\n## Evidence Model\nold line\n',
      after: '# Design\n## Evidence Model\nnew line\n',
    });
    expect(item.anchor).toBe('Evidence Model');
  });

  it('handles a pure insertion and a pure deletion', () => {
    const ins = deriveRevisionItems({ revision: rev(), before: 'a\nb', after: 'a\nNEW\nb' });
    expect(ins[0].change!.before).toBe('');
    expect(ins[0].change!.after).toBe('NEW');

    const del = deriveRevisionItems({ revision: rev(), before: 'a\nGONE\nb', after: 'a\nb' });
    expect(del[0].change!.before).toBe('GONE');
    expect(del[0].change!.after).toBe('');
  });

  it('returns nothing when the text is unchanged', () => {
    expect(deriveRevisionItems({ revision: rev(), before: 'same', after: 'same' })).toEqual([]);
  });

  it('ignores ACE’s own edits — otherwise ACE files feedback against itself', () => {
    const ours = rev({ lastModifyingUser: { displayName: 'ACE', emailAddress: 'ace@dimagi-ai.com' } });
    expect(
      deriveRevisionItems({ revision: ours, before: 'a', after: 'b', ignoreEditors: ['ace@dimagi-ai.com'] }),
    ).toEqual([]);
  });

  it('matches the ignore list case-insensitively', () => {
    const ours = rev({ lastModifyingUser: { emailAddress: 'ACE@Dimagi-AI.com' } });
    expect(
      deriveRevisionItems({ revision: ours, before: 'a', after: 'b', ignoreEditors: ['ace@dimagi-ai.com'] }),
    ).toEqual([]);
  });

  it('is stable across re-derivation — no new unrouted rows each pass', () => {
    const args = { revision: rev(), before: 'a\nold\nb', after: 'a\nnew\nb' };
    expect(deriveRevisionItems(args)[0].id).toBe(deriveRevisionItems(args)[0].id);
  });

  it('produces a kebab-case id the ref grammar accepts', () => {
    const [item] = deriveRevisionItems({ revision: rev({ id: 'ALSO_1783/x' }), before: 'a', after: 'b' });
    expect(item.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('itemBody renders an edit — a revision row can never be blank', () => {
  it('quotes a comment as-is', () => {
    expect(itemBody({ id: 'd', verbatim: 'Use 50 m.' })).toBe('Use 50 m.');
  });

  it('shows a change as before/after', () => {
    const body = itemBody({ id: 'r', change: { before: 'once', after: 'twice' } });
    expect(body).toContain('They CHANGED');
    expect(body).toContain('once');
    expect(body).toContain('twice');
  });

  it('names an addition and a deletion for what they are', () => {
    expect(itemBody({ id: 'r', change: { before: '', after: 'new' } })).toContain('They ADDED');
    expect(itemBody({ id: 'r', change: { before: 'old', after: '' } })).toContain('They DELETED');
  });
});

describe('the completeness property now holds for edits', () => {
  const record = FeedbackRecordSchema.parse({
    schema_version: FEEDBACK_LEDGER_SCHEMA_VERSION,
    slug: '20260814-sophie-feintuch',
    reviewer: 'Sophie Feintuch',
    received_at: '2026-08-14',
    channel: 'revisions',
    items: deriveRevisionItems({
      revision: rev(),
      before: '# Design\nold line',
      after: '# Design\nnew line',
    }),
  });

  it('an unactioned edit renders UNROUTED rather than vanishing', () => {
    const ledger = buildLedger(record, []);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].unrouted).toBe(true);
    expect(ledger.coverage.unrouted).toBe(1);
  });

  it('accepted-edit routes it — the correct response to a good edit is to do nothing and say so', () => {
    const d: Disposition = {
      feedbackRef: `20260814-sophie-feintuch/${record.items[0].id}`,
      kind: 'accepted-edit',
      summary: 'Kept Sophie’s wording verbatim in the next run’s PDD.',
      status: 'shipped',
    };
    const ledger = buildLedger(record, [d]);
    expect(ledger.rows[0].unrouted).toBe(false);
    expect(ledger.coverage.shipped).toBe(1);
  });
});
