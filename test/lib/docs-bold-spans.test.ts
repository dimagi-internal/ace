import { describe, it, expect } from 'vitest';
import {
  findBoldSpans,
  boldSpanRequests,
  type DocsStructuralElement,
} from '../../lib/docs-bold-spans';

/**
 * Synthetic-document builders. The Docs API's own shape is verbose and the
 * arithmetic is the whole point of the module, so these keep the indices
 * explicit and checkable by hand.
 */

/** A paragraph whose runs are contiguous from `start`. */
function para(start: number, ...runs: string[]): DocsStructuralElement {
  const elements = [];
  let idx = start;
  for (const content of runs) {
    elements.push({ startIndex: idx, endIndex: idx + content.length, textRun: { content } });
    idx += content.length;
  }
  return { startIndex: start, endIndex: idx, paragraph: { elements } };
}

/** A paragraph whose runs sit at explicitly-given, possibly non-contiguous indices. */
function paraAt(...runs: Array<[number, string]>): DocsStructuralElement {
  return {
    paragraph: {
      elements: runs.map(([startIndex, content]) => ({
        startIndex,
        endIndex: startIndex + content.length,
        textRun: { content },
      })),
    },
  };
}

function table(...cells: DocsStructuralElement[][]): DocsStructuralElement {
  return {
    table: { tableRows: [{ tableCells: cells.map((content) => ({ content })) }] },
  };
}

describe('findBoldSpans', () => {
  it('maps a single span to exact absolute indices', () => {
    // index: 1'a' 2' ' 3'*' 4'*' 5'b' 6'*' 7'*' 8' ' 9'c'
    const spans = findBoldSpans([para(1, 'a **b** c')]);
    expect(spans).toEqual([
      { openStart: 3, innerStart: 5, innerEnd: 6, closeEnd: 8, text: 'b' },
    ]);
  });

  it('finds a span split across text runs', () => {
    // replaceAllText routinely leaves a substituted value as its own run, so a
    // marker and its text can land in different runs.
    const spans = findBoldSpans([para(1, 'see **the', ' partner**', ' now')]);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('the partner');
    expect(spans[0].openStart).toBe(5);
    expect(spans[0].innerStart).toBe(7);
  });

  it('derives indices from each run\'s own startIndex, not by accumulating lengths', () => {
    // Runs are not guaranteed contiguous — an inline object or footnote
    // reference sits between them. Accumulating lengths would drift by the gap
    // and bold the wrong characters.
    const spans = findBoldSpans([paraAt([10, '**x**'], [40, ' **y**'])]);
    expect(spans.map((s) => s.text)).toEqual(['y', 'x']);
    const x = spans.find((s) => s.text === 'x')!;
    const y = spans.find((s) => s.text === 'y')!;
    expect(x).toMatchObject({ openStart: 10, innerStart: 12, innerEnd: 13, closeEnd: 15 });
    expect(y).toMatchObject({ openStart: 41, innerStart: 43, innerEnd: 44, closeEnd: 46 });
  });

  it('returns spans last-to-first so a caller can mutate safely', () => {
    const spans = findBoldSpans([para(1, '**one** mid **two** end **three**')]);
    expect(spans.map((s) => s.text)).toEqual(['three', 'two', 'one']);
    // Strictly descending — the property the caller relies on.
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].openStart).toBeLessThan(spans[i - 1].openStart);
    }
  });

  it('orders across paragraphs too', () => {
    const spans = findBoldSpans([para(1, '**first**\n'), para(11, '**second**\n')]);
    expect(spans.map((s) => s.text)).toEqual(['second', 'first']);
  });

  it('walks table cells, including nested tables', () => {
    // The Work Order's §2 scope blocks, §4.2 criteria and §8.1 permissions are
    // all inside table cells. docs_finalize_bullets walks top level only; a
    // bold finalizer that copied that would miss most of the prose.
    const spans = findBoldSpans([
      para(1, 'top **A**\n'),
      table([para(20, 'cell **B**\n')], [table([para(40, 'deep **C**\n')])]),
    ]);
    expect(spans.map((s) => s.text)).toEqual(['C', 'B', 'A']);
  });

  it('leaves an unmatched marker alone', () => {
    expect(findBoldSpans([para(1, 'a ** dangling marker')])).toEqual([]);
  });

  it('does not pair markers across a paragraph boundary', () => {
    // Two paragraphs each holding ONE marker. Pairing them would bold
    // everything between and delete characters in both.
    const spans = findBoldSpans([para(1, 'open ** here\n'), para(20, 'close ** there\n')]);
    expect(spans).toEqual([]);
  });

  it('ignores empty and all-asterisk emphasis', () => {
    expect(findBoldSpans([para(1, 'a **** b')])).toEqual([]);
    expect(findBoldSpans([para(1, 'a ***** b')])).toEqual([]);
  });

  it('does not let emphasis straddle a line break inside a paragraph', () => {
    expect(findBoldSpans([para(1, 'a **b\nc** d')])).toEqual([]);
  });

  it('treats a Docs SOFT line break (U+000B) as a break too', () => {
    // Shift+Enter inside a paragraph is U+000B, not \n. A \n-only check would
    // pair across it and bold both lines plus the break.
    expect(findBoldSpans([para(1, 'a **b\u000bc** d')])).toEqual([]);
    // ...and the surrounding text still works, so the guard is not over-broad.
    expect(findBoldSpans([para(1, 'a\u000b**b** c')]).map((s) => s.text)).toEqual(['b']);
  });

  it('handles adjacent spans without swallowing the gap', () => {
    const spans = findBoldSpans([para(1, '**a****b**')]);
    expect(spans.map((s) => s.text)).toEqual(['b', 'a']);
  });

  it('is a no-op on an already-finalized document (idempotence)', () => {
    // What a re-run sees: real bold, no markers left.
    expect(findBoldSpans([para(1, 'the partner will deliver\n')])).toEqual([]);
  });

  it('ignores paragraphs with no text runs', () => {
    expect(findBoldSpans([{ paragraph: { elements: [] } }, { paragraph: {} }, {}])).toEqual([]);
  });
});

describe('boldSpanRequests', () => {
  const span = { openStart: 3, innerStart: 5, innerEnd: 6, closeEnd: 8, text: 'b' };

  it('styles first, then deletes the closing marker, then the opening one', () => {
    // Order is load-bearing: Docs applies a batch sequentially. Deleting the
    // opening marker before the closing one would leave the closing range
    // pointing two characters past the end of the text.
    const reqs = boldSpanRequests(span) as any[];
    expect(reqs).toHaveLength(3);
    expect(reqs[0].updateTextStyle).toEqual({
      range: { startIndex: 5, endIndex: 6 },
      textStyle: { bold: true },
      fields: 'bold',
    });
    expect(reqs[1].deleteContentRange.range).toEqual({ startIndex: 6, endIndex: 8 });
    expect(reqs[2].deleteContentRange.range).toEqual({ startIndex: 3, endIndex: 5 });
  });

  it('sets only the bold field, so template styling survives', () => {
    // A contractual template carries fonts, colours and sizes. A wide `fields`
    // mask would reset them to defaults while adding bold.
    const reqs = boldSpanRequests(span) as any[];
    expect(reqs[0].updateTextStyle.fields).toBe('bold');
    expect(Object.keys(reqs[0].updateTextStyle.textStyle)).toEqual(['bold']);
  });

  it('deletes exactly the four marker characters and nothing else', () => {
    const reqs = boldSpanRequests(span) as any[];
    const deleted =
      reqs[1].deleteContentRange.range.endIndex -
      reqs[1].deleteContentRange.range.startIndex +
      (reqs[2].deleteContentRange.range.endIndex - reqs[2].deleteContentRange.range.startIndex);
    expect(deleted).toBe(4);
  });
});
