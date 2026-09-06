import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findCorrectionSignals,
  findCorrectedOpenAsks,
  extractRefs,
  type IssueComment,
  type IssueStatus,
  type UpstreamRef,
} from '../../lib/upstream-asks.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(REPO, 'test', 'fixtures', 'upstream-asks');

/**
 * ace#1792. `probe-upstream-asks` classified on lifecycle state alone, so a
 * mechanism retracted in a COMMENT on an issue that stayed OPEN tripped
 * nothing. Fixtures below are VERBATIM comment bodies fetched from the real
 * threads (`gh issue view <n> -R <repo> --json comments`) — not written for
 * this test — so the controls measure the detector against the prose people
 * actually write, not against prose shaped to pass.
 */
function corpus(name: string): { slug: string; comments: IssueComment[] } {
  return JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'));
}

const POSITIVE = 'nova-plugin-52-comments';
const ACE_1769 = 'ace-1769-comments';
/** Upstream maintainer threads with no retraction in them. */
const NEGATIVE = ['commcare-nova-458-comments', 'commcare-nova-545-comments', 'nova-plugin-25-comments'];

describe('positive control — the real thread that motivated the issue', () => {
  /**
   * `voidcraft-labs/nova-plugin#52`: OPEN to this day, and its own author
   * retracted the mechanism in comments 2 and 3 of 3 on 2026-08-25. ACE had
   * that mechanism in four operator-facing surfaces at the time.
   */
  it('flags both retraction comments on nova-plugin#52 and leaves the report comment alone', () => {
    const { comments } = corpus(POSITIVE);
    expect(comments).toHaveLength(3);
    const counts = comments.map((c) => findCorrectionSignals(c).length);
    // [0] is a fresh third-occurrence REPORT, not a retraction.
    expect(counts).toEqual([0, 2, 1]);
  });

  it('quotes the retraction verbatim rather than paraphrasing it', () => {
    const { comments } = corpus(POSITIVE);
    const excerpts = comments.flatMap((c) => findCorrectionSignals(c).map((s) => s.excerpt));
    expect(excerpts.some((e) => e.startsWith('### Correcting my comment above'))).toBe(true);
    expect(excerpts.some((e) => e.startsWith('### Final correction — I had this wrong twice'))).toBe(
      true,
    );
  });

  it('carries the comment URL so the report links to the thread, not to a summary', () => {
    const { comments } = corpus(POSITIVE);
    const sigs = comments.flatMap(findCorrectionSignals);
    expect(sigs.length).toBeGreaterThan(0);
    for (const s of sigs) expect(s.url).toMatch(/^https:\/\/github\.com\/.+#issuecomment-\d+$/);
  });
});

describe('negative controls — real threads that must stay silent', () => {
  it.each(NEGATIVE)('%s carries no retraction-shaped line', (name) => {
    const { comments } = corpus(name);
    expect(comments.length).toBeGreaterThan(0);
    for (const c of comments) expect(findCorrectionSignals(c)).toEqual([]);
  });

  /**
   * The comment the reviewer's worry is about: a thread where someone is
   * REASONING toward a cause and explicitly refuses to assert one. It is on a
   * correction-heavy issue, adjacent to two comments that DO retract, so it is
   * the hardest real negative available.
   */
  it('ace#1769 comment 3 re-validates without retracting, and is not flagged', () => {
    const { comments } = corpus(ACE_1769);
    expect(comments).toHaveLength(4);
    expect(findCorrectionSignals(comments[1])).toEqual([]);
    expect(findCorrectionSignals(comments[2])).toEqual([]);
  });

  it('ace#1769 comments 1 and 4 do retract, so the corpus is not silent by accident', () => {
    const { comments } = corpus(ACE_1769);
    expect(findCorrectionSignals(comments[0]).length).toBeGreaterThan(0);
    expect(findCorrectionSignals(comments[3]).length).toBeGreaterThan(0);
  });

  /**
   * Corpus-level number, so a marker widened later cannot quietly trade
   * precision for recall: 10 real comments, 4 retract, 6 do not.
   */
  it('across the whole real corpus: 4 of 10 comments carry a signal', () => {
    const all = [POSITIVE, ACE_1769, ...NEGATIVE].flatMap((n) => corpus(n).comments);
    expect(all).toHaveLength(10);
    expect(all.filter((c) => findCorrectionSignals(c).length > 0)).toHaveLength(4);
  });
});

describe('a hedged line is not a retraction', () => {
  /**
   * The guard the report tier lives or dies by. NOTE, honestly: mutating it
   * out changes NOTHING on the 10-comment real corpus above — no real line
   * matches a correction marker while also hedging. So the zero-false-positive
   * result there is earned by marker SHAPE, not by this guard. It is kept, and
   * pinned here, because it is the cheap defence against the one failure mode
   * a prose heuristic has: someone thinking out loud about whether they were
   * wrong. These lines are constructed, and labelled as such.
   */
  it.each([
    'I might have this wrong — it could be the cache rather than the header.',
    'Correcting my earlier comment may be premature; I cannot tell yet.',
    'Perhaps I was wrong about the precedence, but I am not sure.',
    'If that turns out to be right, my earlier correction stands.',
  ])('does not flag: %s', (body) => {
    expect(findCorrectionSignals({ body })).toEqual([]);
  });

  it('still flags the flat version of the same claim', () => {
    expect(findCorrectionSignals({ body: 'I was wrong about the precedence.' })).toHaveLength(1);
  });

  it('a hedge in one paragraph does not launder a retraction in another', () => {
    const body = [
      'I cannot tell whether the cache was populated at bind time.',
      '',
      '### Final correction — I had this wrong twice.',
    ].join('\n');
    expect(findCorrectionSignals({ body })).toHaveLength(1);
  });
});

describe('markers dropped from the filed remedy', () => {
  /**
   * ace#1792 proposed `correction | disproved | I had this wrong | superseded |
   * not the cause`. Run against the very thread it was derived from, `not the
   * cause` matched "The OAuth cascade is a *symptom*, not the cause" — a line
   * of ordinary diagnostic prose. Every debugging thread that eliminates a
   * suspect writes that sentence, and it is a claim ABOUT a mechanism, not a
   * withdrawal of one, so it is not a marker here.
   */
  it('"not the cause" alone is not a retraction', () => {
    expect(
      findCorrectionSignals({ body: 'The OAuth cascade is a symptom, not the cause.' }),
    ).toEqual([]);
  });

  /** And the two the filed list would have MISSED on that same thread. */
  it.each([
    '### Correcting my comment above — it is not stored-credential precedence',
    'The client logs disprove that, so I want to correct the record.',
  ])('is flagged even though the filed word list missed it: %s', (body) => {
    expect(findCorrectionSignals({ body }).length).toBeGreaterThan(0);
  });
});

describe('findCorrectedOpenAsks — the gates around the heuristic', () => {
  const retraction: IssueComment = {
    author: 'jjackson',
    body: '### Final correction — I had this wrong twice.',
    createdAt: '2026-08-25T03:11:37Z',
    url: 'https://github.com/voidcraft-labs/nova-plugin/issues/52#issuecomment-1',
  };
  const slug = 'voidcraft-labs/nova-plugin#52';

  function ref(claimsLiveConstraint: boolean): UpstreamRef {
    return {
      owner: 'voidcraft-labs',
      repo: 'nova-plugin',
      number: 52,
      slug,
      file: 'agents/ace-orchestrator.md',
      line: 331,
      text: `Blocked on ${slug} — no static-header path yet.`,
      claimsLiveConstraint,
    };
  }
  const open = (comments: IssueComment[]): IssueStatus[] => [
    { slug, state: 'OPEN', title: 'Stored OAuth credential takes precedence', comments },
  ];

  it('reports an OPEN, still-cited-as-live issue whose thread retracts', () => {
    const out = findCorrectedOpenAsks([ref(true)], open([retraction]));
    expect(out).toHaveLength(1);
    expect(out[0].signals).toHaveLength(1);
    expect(out[0].citations).toHaveLength(1);
  });

  /**
   * The suppression property the probe's design depends on. Writing the
   * correction into the doc — which is what fixing it looks like — retires the
   * finding, exactly as the CLOSED tier already behaves. Without this, a probe
   * keeps nagging about acknowledged work and people turn it off.
   */
  it('says nothing once the doc cites the issue as history', () => {
    expect(findCorrectedOpenAsks([ref(false)], open([retraction]))).toEqual([]);
  });

  it('says nothing when the thread has no retraction', () => {
    expect(
      findCorrectedOpenAsks([ref(true)], open([{ body: 'Hit this again today, same trace.' }])),
    ).toEqual([]);
  });

  it('says nothing when comments were never fetched', () => {
    expect(findCorrectedOpenAsks([ref(true)], [{ slug, state: 'OPEN' }])).toEqual([]);
  });

  it('leaves CLOSED issues to the exact tier', () => {
    expect(
      findCorrectedOpenAsks([ref(true)], [{ slug, state: 'CLOSED', comments: [retraction] }]),
    ).toEqual([]);
  });

  it('leaves UNKNOWN (404, moved, private) alone rather than guessing OPEN', () => {
    expect(
      findCorrectedOpenAsks([ref(true)], [{ slug, state: 'UNKNOWN', comments: [retraction] }]),
    ).toEqual([]);
  });
});

describe('the suppression is live in the repo today, not just in a fixture', () => {
  /**
   * ACE absorbed nova-plugin#52's correction in #1791. Every surviving
   * citation therefore reads as history, which is why the probe is silent on
   * an OPEN issue whose thread is one long retraction. If someone later
   * re-asserts the disproved mechanism as live, this flips and the probe
   * starts reporting — which is the whole point.
   */
  it('no scanned doc cites nova-plugin#52 as a live constraint', () => {
    const files = [
      'agents/commcare-setup.md',
      'agents/ace-orchestrator.md',
      'playbook/integrations/nova-integration.md',
    ];
    const live = files.flatMap((f) =>
      extractRefs(f, readFileSync(join(REPO, f), 'utf8')).filter(
        (r) => r.slug === 'voidcraft-labs/nova-plugin#52' && r.claimsLiveConstraint,
      ),
    );
    expect(live.map((r) => `${r.file}:${r.line}`)).toEqual([]);
  });
});
