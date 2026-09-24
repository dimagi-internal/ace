import { describe, it, expect } from 'vitest';
import {
  findEmailAnchors,
  planEmailBlocks,
  emailBlockStyleRequests,
  emailBlockFillRequests,
  insertEmailBlocks,
  type EmailBlockDocsClient,
} from '../../lib/docs-email-block';
import type { DocsStructuralElement } from '../../lib/docs-bold-spans';

function para(start: number, text: string, style = 'NORMAL_TEXT'): DocsStructuralElement {
  return {
    startIndex: start,
    endIndex: start + text.length,
    paragraph: {
      elements: [{ startIndex: start, endIndex: start + text.length, textRun: { content: text } }],
      paragraphStyle: { namedStyleType: style },
    } as any,
  };
}

/** A 5x2 email table whose cell (r,c) paragraph starts at base + r*10 + c*5, 1 char long (empty). */
function emailTable(base: number): DocsStructuralElement {
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const cells = [];
    for (let c = 0; c < 2; c++) {
      const s = base + r * 10 + c * 5;
      cells.push({ content: [{ startIndex: s, endIndex: s + 1 }] });
    }
    rows.push({ tableCells: cells });
  }
  return { startIndex: base, endIndex: base + 60, table: { tableRows: rows } as any };
}

describe('findEmailAnchors', () => {
  it('finds anchor paragraphs last-to-first and ignores anchors embedded in prose', () => {
    const body = [
      para(1, 'Intro\n'),
      para(7, '@@EMAIL_a@@\n'),
      para(20, 'see @@EMAIL_x@@ inline\n'),
      para(45, '@@EMAIL_b-2@@\n'),
    ];
    const anchors = findEmailAnchors(body);
    expect(anchors.map((a) => a.key)).toEqual(['b-2', 'a']);
    expect(anchors[1]).toMatchObject({ token: '@@EMAIL_a@@', startIndex: 7 });
  });
});

describe('planEmailBlocks', () => {
  const anchors = findEmailAnchors([para(1, '@@EMAIL_a@@\n'), para(20, '@@EMAIL_b@@\n')]);

  it('orders the plan last-to-first and reports anchors nobody asked for', () => {
    const { plan, unusedAnchors } = planEmailBlocks(anchors, [{ anchor: 'a', subject: 'A' }]);
    expect(plan.map((p) => p.anchor.key)).toEqual(['a']);
    expect(unusedAnchors).toEqual(['@@EMAIL_b@@']);
    const both = planEmailBlocks(anchors, [{ anchor: 'a' }, { anchor: 'b' }]);
    expect(both.plan.map((p) => p.anchor.key)).toEqual(['b', 'a']);
  });

  it('refuses a missing anchor, a duplicate request, and a malformed key — all at once', () => {
    expect(() =>
      planEmailBlocks(anchors, [{ anchor: 'zzz' }, { anchor: 'a' }, { anchor: 'a' }, { anchor: 'bad key' }]),
    ).toThrow(/@@EMAIL_zzz@@[\s\S]*requested twice[\s\S]*must match/);
  });

  it('refuses an anchor on a heading line, because the block would inherit the heading font', () => {
    const h = findEmailAnchors([para(1, '@@EMAIL_h@@\n', 'HEADING_2')]);
    expect(() => planEmailBlocks(h, [{ anchor: 'h' }])).toThrow(/HEADING_2/);
  });

  it('refuses an anchor that appears twice in the document', () => {
    const dup = findEmailAnchors([para(1, '@@EMAIL_a@@\n'), para(20, '@@EMAIL_a@@\n')]);
    expect(() => planEmailBlocks(dup, [{ anchor: 'a' }])).toThrow(/appears 2 times/);
  });
});

describe('request builders', () => {
  const t = emailTable(100).table as any;

  it('inserts the four labels last, in reverse row order', () => {
    const reqs = emailBlockStyleRequests(100, t);
    const inserts = reqs.filter((r) => 'insertText' in r).map((r: any) => [r.insertText.location.index, r.insertText.text]);
    expect(inserts).toEqual([[130, 'Subject'], [120, 'Bcc'], [110, 'Cc'], [100, 'To']]);
    expect(reqs.findIndex((r) => 'insertText' in r)).toBe(reqs.length - 4);
  });

  it('fills values from the highest index down and skips empty fields', () => {
    const reqs = emailBlockFillRequests(t, { to: 'x@y.org', subject: 'S', body: 'B' });
    const inserts = reqs.filter((r) => 'insertText' in r).map((r: any) => [r.insertText.location.index, r.insertText.text]);
    expect(inserts).toEqual([[140, 'B'], [135, 'S'], [105, 'x@y.org']]);
  });
});

describe('insertEmailBlocks', () => {
  it('validates before writing: a bad request makes zero batchUpdate calls', async () => {
    const calls: unknown[] = [];
    const client: EmailBlockDocsClient = {
      get: async () => ({ body: { content: [para(1, '@@EMAIL_a@@\n')] } }),
      batchUpdate: async (_id, r) => void calls.push(r),
    };
    await expect(insertEmailBlocks(client, 'doc', [{ anchor: 'missing' }])).rejects.toThrow(/missing/);
    expect(calls).toHaveLength(0);
  });

  it('runs insert → style → fill per block, then deletes the consumed tokens', async () => {
    const calls: Record<string, unknown>[][] = [];
    let reads = 0;
    const client: EmailBlockDocsClient = {
      get: async () => {
        reads++;
        return reads === 1
          ? { body: { content: [para(1, '@@EMAIL_a@@\n')] } }
          : { body: { content: [para(1, '\n'), emailTable(2)] } };
      },
      batchUpdate: async (_id, r) => void calls.push(r),
    };
    const res = await insertEmailBlocks(client, 'doc', [{ anchor: 'a', subject: 'Hi' }]);
    expect(res).toEqual({ documentId: 'doc', inserted: ['@@EMAIL_a@@'], unusedAnchors: [] });
    expect(Object.keys(calls[0][0])).toEqual(['insertTable']);
    expect(calls.at(-1)).toEqual([
      { replaceAllText: { containsText: { text: '@@EMAIL_a@@', matchCase: true }, replaceText: '' } },
    ]);
    expect(calls).toHaveLength(4);
  });
});
