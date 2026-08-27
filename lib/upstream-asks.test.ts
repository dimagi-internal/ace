import { describe, it, expect } from 'vitest';
import {
  classifyLine,
  extractRefs,
  findStaleAsks,
  uniqueSlugs,
  type IssueStatus,
} from './upstream-asks.js';

const NOVA8 = 'voidcraft-labs/nova-plugin#8';

describe('extractRefs', () => {
  it('finds a tracked upstream reference with its file and line', () => {
    const refs = extractRefs('skills/x/SKILL.md', `line one\ntracked at ${NOVA8} for now`);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      owner: 'voidcraft-labs',
      repo: 'nova-plugin',
      number: 8,
      slug: NOVA8,
      file: 'skills/x/SKILL.md',
      line: 2,
    });
  });

  it('ignores ACE self-references — the docs are full of them', () => {
    expect(extractRefs('f.md', 'see ace#1234 and #567 and dimagi-internal/ace#1466')).toEqual([]);
  });

  it('ignores repos ACE does not file against', () => {
    expect(extractRefs('f.md', 'compare facebook/react#42')).toEqual([]);
  });

  it('finds several references on one line', () => {
    const refs = extractRefs('f.md', `blocked on ${NOVA8} and dimagi/commcare-hq#99`);
    expect(uniqueSlugs(refs)).toEqual(['dimagi/commcare-hq#99', NOVA8]);
  });
});

describe('classifyLine — live constraint vs history', () => {
  it.each([
    'Nova has no schema for it',
    'blocked on voidcraft-labs/nova-plugin#8',
    'this is the workaround until Nova ships it',
    'not yet supported upstream',
    'tracked at voidcraft-labs/nova-plugin#8',
    'See § Removal criteria below',
    'CommCare cannot ingest .m4a',
    "Nova doesn't expose a media property",
  ])('reads %s as a live constraint', (line) => {
    expect(classifyLine(line)).toBe(true);
  });

  it.each([
    'voidcraft-labs/nova-plugin#8 closed 2026-06-03 — media shipped',
    'long-fixed and NOT bugs: update_form clears nullable properties',
    'this workaround is retired; Nova ships it natively now',
    'the English-only decision is SUPERSEDED',
    'Do not cite #458 as a live constraint',
    'DISPROVED: this was never a Nova bug',
    'ACE used to patch form XML here; no longer',
  ])('reads %s as history, not a live constraint', (line) => {
    expect(classifyLine(line)).toBe(false);
  });

  it('lets history win when both markers appear — ACE describes a past gap to say it is over', () => {
    expect(classifyLine('Nova had no schema for this; SHIPPED 2026-06-03')).toBe(false);
  });

  it('treats an unremarkable mention as neither', () => {
    expect(classifyLine('see voidcraft-labs/nova-plugin#8 for background')).toBe(false);
  });
});

describe('classifyLine — acknowledgement window', () => {
  it('suppresses a stale line when the next lines acknowledge the close', () => {
    const line = 'Removal criteria: drop when voidcraft-labs/nova-plugin#7 ships';
    expect(classifyLine(line)).toBe(true);
    expect(classifyLine(line, `${line}\n**#7 closed COMPLETED 2026-05-22.**`)).toBe(false);
  });

  it('still fires when the nearby text does not acknowledge anything', () => {
    const line = 'blocked on voidcraft-labs/nova-plugin#8';
    expect(classifyLine(line, `${line}\nsee the table below for details`)).toBe(true);
  });
});

describe('extractRefs — acknowledgement suppression in context', () => {
  it('does not flag a stale citation that the doc already annotates', () => {
    const doc = [
      'Removal criteria: drop when voidcraft-labs/nova-plugin#7 ships.',
      '**#7 closed COMPLETED 2026-05-22 — retirement candidate.** Needs a live',
      'build to confirm before deleting.',
    ].join('\n');
    expect(extractRefs('f.md', doc)[0].claimsLiveConstraint).toBe(false);
  });

  it('flags the same citation when the annotation is absent', () => {
    const doc = 'Removal criteria: drop when voidcraft-labs/nova-plugin#7 ships.';
    expect(extractRefs('f.md', doc)[0].claimsLiveConstraint).toBe(true);
  });

  it('does not let an acknowledgement far below suppress a later claim', () => {
    const doc = [
      'blocked on voidcraft-labs/nova-plugin#8',
      '', '', '', '', '', '',
      'unrelated: that was fixed long ago',
    ].join('\n');
    expect(extractRefs('f.md', doc)[0].claimsLiveConstraint).toBe(true);
  });
});

describe('findStaleAsks', () => {
  const closed: IssueStatus = {
    slug: NOVA8,
    state: 'CLOSED',
    closedAt: '2026-06-03T18:45:08Z',
    reason: 'completed',
    title: 'Field-level multimedia',
  };

  it('reports a CLOSED issue still cited as a live constraint — the nova#8 case', () => {
    const refs = extractRefs('skills/a/SKILL.md', `Nova has no schema for it. Tracked at ${NOVA8}.`);
    const stale = findStaleAsks(refs, [closed]);
    expect(stale).toHaveLength(1);
    expect(stale[0].slug).toBe(NOVA8);
    expect(stale[0].closedAt).toBe('2026-06-03T18:45:08Z');
    expect(stale[0].citations[0].file).toBe('skills/a/SKILL.md');
  });

  it('stays silent on a closed issue cited only as history', () => {
    const refs = extractRefs('CHANGELOG.md', `${NOVA8} shipped and is closed`);
    expect(findStaleAsks(refs, [closed])).toEqual([]);
  });

  it('stays silent while the issue is still OPEN — that citation is correct', () => {
    const refs = extractRefs('f.md', `blocked on ${NOVA8}`);
    expect(findStaleAsks(refs, [{ slug: NOVA8, state: 'OPEN' }])).toEqual([]);
  });

  it('reports a NOT PLANNED close too — "blocked on it" is wrong either way', () => {
    const refs = extractRefs('f.md', `blocked on ${NOVA8}`);
    const stale = findStaleAsks(refs, [{ ...closed, reason: 'not planned' }]);
    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toBe('not planned');
  });

  it('stays silent when the issue state could not be resolved', () => {
    const refs = extractRefs('f.md', `blocked on ${NOVA8}`);
    expect(findStaleAsks(refs, [{ slug: NOVA8, state: 'UNKNOWN' }])).toEqual([]);
  });

  it('groups every citation of one issue under a single finding, file-ordered', () => {
    const refs = [
      ...extractRefs('z.md', `blocked on ${NOVA8}`),
      ...extractRefs('a.md', `has no support — ${NOVA8}`),
      ...extractRefs('a.md', `line one\nwaiting for ${NOVA8}`),
    ];
    const stale = findStaleAsks(refs, [closed]);
    expect(stale).toHaveLength(1);
    expect(stale[0].citations.map((c) => c.file)).toEqual(['a.md', 'a.md', 'z.md']);
  });

  it('returns nothing for an empty repo scan rather than throwing', () => {
    expect(findStaleAsks([], [])).toEqual([]);
  });
});
