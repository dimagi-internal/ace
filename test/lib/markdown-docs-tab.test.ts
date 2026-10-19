import { describe, expect, it } from 'vitest';
import { markdownToTabRequests, parseInline } from '../../lib/markdown-docs-tab.js';

describe('parseInline', () => {
  it('strips bold and link markers and records their ranges', () => {
    const { text, runs } = parseInline('A **bold** and [link](https://x.org/a) end');
    expect(text).toBe('A bold and link end');
    expect(runs).toEqual([
      { start: 2, end: 6, bold: true },
      { start: 11, end: 15, link: 'https://x.org/a' },
    ]);
  });

  it('handles a link inside bold', () => {
    const { text, runs } = parseInline('**see [doc](https://d.x/1)**');
    expect(text).toBe('see doc');
    expect(runs).toContainEqual({ start: 0, end: 7, bold: true });
    expect(runs).toContainEqual({ start: 4, end: 7, link: 'https://d.x/1' });
  });
});

describe('markdownToTabRequests', () => {
  const md = ['# Title', '', 'Intro with **bold**.', '', '- one', '  - nested', '- two', '', '1. first', '2. second'].join('\n');
  const reqs = markdownToTabRequests(md, 't.abc');
  const insert = reqs[0].insertText as { location: { index: number; tabId: string }; text: string };

  it('inserts the whole body once, at index 1 of the tab', () => {
    expect(insert.location).toEqual({ index: 1, tabId: 't.abc' });
    expect(insert.text).toBe('Title\nIntro with bold.\none\n\tnested\ntwo\nfirst\nsecond\n');
  });

  it('styles headings by range in the tab', () => {
    const h = reqs.find((r) => r.updateParagraphStyle) as any;
    expect(h.updateParagraphStyle.range).toEqual({ startIndex: 1, endIndex: 7, tabId: 't.abc' });
    expect(h.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_1');
  });

  it('bolds the right characters', () => {
    const b = reqs.find((r) => r.updateTextStyle) as any;
    const text = insert.text;
    const { startIndex, endIndex } = b.updateTextStyle.range;
    expect(text.slice(startIndex - 1, endIndex - 1)).toBe('bold');
  });

  it('emits bullet groups last, in reverse document order', () => {
    const bullets = reqs.filter((r) => r.createParagraphBullets) as any[];
    expect(bullets).toHaveLength(2);
    expect(reqs.slice(-2)).toEqual(bullets);
    expect(bullets[0].createParagraphBullets.bulletPreset).toBe('NUMBERED_DECIMAL_ALPHA_ROMAN');
    expect(bullets[1].createParagraphBullets.bulletPreset).toBe('BULLET_DISC_CIRCLE_SQUARE');
    const text = insert.text;
    const g = bullets[1].createParagraphBullets.range;
    expect(text.slice(g.startIndex - 1, g.endIndex - 1)).toBe('one\n\tnested\ntwo\n');
  });

  it('refuses pipe tables instead of mangling them', () => {
    expect(() => markdownToTabRequests('| a | b |\n|---|---|', 't')).toThrow(/pipe tables/);
  });
});
