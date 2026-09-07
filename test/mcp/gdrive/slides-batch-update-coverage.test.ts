/**
 * ace#2126, the DECK half of the wiring.
 *
 * `test/mcp/gdrive/copy-template-coverage.test.ts` covers `docs_copy_template`.
 * That atom is not the path ACE's decks take: `training-deck-render` and
 * `partnership-deck-build` both call `slides_copy_template` with NO
 * `replacements`, so its coverage block never runs, and every token is
 * substituted afterwards through `slides_batch_update` via the `replaceAllText`
 * requests `buildSlidesRequestsV2` emits. Wiring only the copy atoms would have
 * been a no-op on both deck producers while looking like a fix.
 *
 * These drive the atom with an injected client that answers batchUpdate the way
 * Google does: positionally, one reply per request across a HETEROGENEOUS batch,
 * with `occurrencesChanged` ELIDED rather than sent as 0 when nothing matched.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleSlidesBatchUpdate } from '../../../mcp/google-drive-server.js';

/**
 * Answer each request positionally. Non-replaceAllText requests get the empty
 * replies Slides returns for them, so the indices only line up if the atom
 * walks the request list rather than the reply list.
 */
function makeSlides(deckTokens: string[]) {
  return {
    presentations: {
      batchUpdate: vi.fn(async (req: any) => ({
        data: {
          presentationId: req.presentationId,
          replies: (req.requestBody?.requests ?? []).map((r: any) => {
            if (!r.replaceAllText) return {};
            return deckTokens.includes(r.replaceAllText.containsText.text)
              ? { replaceAllText: { occurrencesChanged: 1 } }
              : { replaceAllText: {} };
          }),
        },
      })),
    },
  };
}

const parse = (res: any) => JSON.parse(res.content[0].text);

const rat = (token: string, pageIds: string[] = ['p1']) => ({
  replaceAllText: {
    containsText: { text: token, matchCase: true },
    replaceText: 'v',
    pageObjectIds: pageIds,
  },
});

describe('slides_batch_update surfaces replacement coverage (ace#2126)', () => {
  it('names the unmatched token, and only that token', async () => {
    const slides = makeSlides(['{{TITLE}}']);

    const out = parse(
      await handleSlidesBatchUpdate(
        {
          presentationId: 'deck-1',
          requests: [rat('{{TITLE}}'), rat('{{NOTES}}')],
        },
        slides as any,
      ),
    );

    expect(out.unmatchedReplacements).toEqual(['{{NOTES}}']);
    expect(out.replacementOccurrences).toEqual({ '{{TITLE}}': 1, '{{NOTES}}': 0 });
    expect(out.warning).toContain('{{NOTES}}');
    expect(out.warning).toContain('silently dropped');
  });

  it('keeps request/reply alignment across a heterogeneous batch', async () => {
    // The real builder interleaves duplicateObject / createImage /
    // updateSlidesPosition / deleteObject with the replaceAllText requests. A
    // naive implementation that indexed the FILTERED list against the full
    // reply array would read the wrong reply for every token after the first
    // non-replaceAllText request.
    const slides = makeSlides(['{{BODY}}']);

    const out = parse(
      await handleSlidesBatchUpdate(
        {
          presentationId: 'deck-1',
          requests: [
            { duplicateObject: { objectId: 'stencil_content' } },
            rat('{{MISSING_A}}'),
            { createImage: { url: 'https://example.test/a.png' } },
            rat('{{BODY}}'),
            { deleteObject: { objectId: 'stencil_content' } },
            rat('{{MISSING_B}}'),
          ],
        },
        slides as any,
      ),
    );

    expect(out.unmatchedReplacements).toEqual(['{{MISSING_A}}', '{{MISSING_B}}']);
    expect(out.replacementOccurrences['{{BODY}}']).toBe(1);
  });

  it('does not report a per-slide token as unmatched when it landed on some slides', async () => {
    // buildSlidesRequestsV2 scopes every request by pageObjectIds, so
    // {{TITLE}} is sent once PER SLIDE. Judging each request on its own would
    // call {{TITLE}} unmatched for every slide whose layout omits it.
    const slides = {
      presentations: {
        batchUpdate: vi.fn(async (req: any) => ({
          data: {
            presentationId: req.presentationId,
            replies: (req.requestBody?.requests ?? []).map((_r: any, i: number) =>
              i === 0 ? { replaceAllText: { occurrencesChanged: 1 } } : { replaceAllText: {} },
            ),
          },
        })),
      },
    };

    const out = parse(
      await handleSlidesBatchUpdate(
        {
          presentationId: 'deck-1',
          requests: [rat('{{TITLE}}', ['p1']), rat('{{TITLE}}', ['p2'])],
        },
        slides as any,
      ),
    );

    expect(out.unmatchedReplacements).toEqual([]);
    expect(out.replacementOccurrences).toEqual({ '{{TITLE}}': 1 });
  });

  it('omits the coverage fields entirely for a batch with no replaceAllText', async () => {
    const slides = makeSlides([]);

    const out = parse(
      await handleSlidesBatchUpdate(
        {
          presentationId: 'deck-1',
          requests: [{ createSlide: { objectId: 's1' } }],
        },
        slides as any,
      ),
    );

    expect(out).not.toHaveProperty('unmatchedReplacements');
    expect(out).not.toHaveProperty('warning');
    expect(out.presentationId).toBe('deck-1');
  });

  it('stays clean when every token matched', async () => {
    const slides = makeSlides(['{{TITLE}}', '{{BODY}}']);

    const out = parse(
      await handleSlidesBatchUpdate(
        {
          presentationId: 'deck-1',
          requests: [rat('{{TITLE}}'), rat('{{BODY}}')],
        },
        slides as any,
      ),
    );

    expect(out.unmatchedReplacements).toEqual([]);
    expect(out).not.toHaveProperty('warning');
  });
});
