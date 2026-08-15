/**
 * Unit tests for the screenshot-embedding logic.
 *
 * Everything here is deterministic document arithmetic, so it is tested
 * hermetically — no Drive, no Docs API. The one thing these tests exist to
 * pin down is the index math: inserting into a Google Doc shifts every index
 * after the insertion point, and getting the order wrong does NOT error — it
 * silently files images under the wrong paragraphs, which is the same class
 * of quiet wrongness this whole feature is fixing.
 */

import { describe, it, expect } from 'vitest';
import {
  buildEmbedRequests,
  collectImageAnchors,
  countInlineImages,
  driveFileIdFromUrl,
  driveImageUri,
  filenameCandidates,
  type DocLike,
} from '../../lib/doc-image-embed.js';

/** Build a paragraph element with runs `[text, linkUrl|null]`. */
function para(
  endIndex: number,
  runs: Array<[string, string | null]>,
  opts: { image?: boolean } = {},
) {
  const elements: any[] = runs.map(([content, url]) => ({
    textRun: { content, textStyle: url ? { link: { url } } : {} },
  }));
  if (opts.image) elements.push({ inlineObjectElement: { inlineObjectId: 'kix.1' } });
  return { endIndex, paragraph: { elements } };
}

const FILE_A = '1Nrw6a88JZVnLn4zdaeFT3d2ZeIYrVfbn';
const FILE_B = '19Y2yelRWKRM9b2x5rRBHbwi-zHXpAnT9';

describe('driveFileIdFromUrl', () => {
  it('reads the id out of every Drive URL shape ACE emits', () => {
    expect(driveFileIdFromUrl(`https://drive.google.com/file/d/${FILE_A}/view`)).toBe(FILE_A);
    expect(driveFileIdFromUrl(`https://drive.google.com/uc?export=view&id=${FILE_A}`)).toBe(FILE_A);
    expect(driveFileIdFromUrl(`https://lh3.googleusercontent.com/d/${FILE_A}`)).toBe(FILE_A);
  });

  it('refuses links that are not Drive files', () => {
    // A guide links its Connect opportunity, its HQ apps and a mailto:. None
    // of those are screenshots, and embedding one would be nonsense.
    expect(driveFileIdFromUrl('https://connect.dimagi.com/a/x/opportunity/abc/')).toBeNull();
    expect(driveFileIdFromUrl('https://www.commcarehq.org/a/d/apps/view/f794e836048345288f418a431f934408/')).toBeNull();
    expect(driveFileIdFromUrl('mailto:ace@dimagi-ai.com')).toBeNull();
  });
});

describe('filenameCandidates', () => {
  it('offers left-trimmed prefixes longest-first', () => {
    const text = 'Tumbuka. See learn-launch-home-tiles.png';
    const cands = filenameCandidates(text, text.length);
    expect(cands[0]).toBe('Tumbuka. See learn-launch-home-tiles.png');
    expect(cands).toContain('learn-launch-home-tiles.png');
  });

  it('keeps a filename that legitimately contains spaces reachable', () => {
    // app-screenshot-capture names frames after the tapped row, so spaces are
    // real: "deliver-form-walk-module-row-CBF Registration.x.png".
    const text = 'see deliver-form-walk-module-row-CBF Registration.x.png here';
    const end = text.indexOf('.png') + 4;
    expect(filenameCandidates(text, end)).toContain(
      'deliver-form-walk-module-row-CBF Registration.x.png',
    );
  });
});

describe('collectImageAnchors', () => {
  const noNames = () => null;

  it('anchors on Drive links, in citation order, deduped', () => {
    const doc: DocLike = {
      body: {
        content: [
          para(50, [
            ['Tap the tile. ', null],
            ['Opportunity list', `https://drive.google.com/file/d/${FILE_B}/view`],
            [' ', null],
            ['Connect home', `https://drive.google.com/file/d/${FILE_A}/view`],
            [' again ', null],
            ['Connect home', `https://drive.google.com/file/d/${FILE_A}/view`],
            ['\n', null],
          ]),
        ],
      },
    };
    const { anchors } = collectImageAnchors(doc, noNames);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].fileIds).toEqual([FILE_B, FILE_A]);
  });

  it('anchors on a filename citation resolved against the capture pool', () => {
    const doc: DocLike = {
      body: { content: [para(40, [['See `learn-launch-home-tiles.png`.\n', null]])] },
    };
    const { anchors, unresolvedCitations } = collectImageAnchors(doc, (n) =>
      n === 'learn-launch-home-tiles.png' ? FILE_A : null,
    );
    expect(anchors[0].fileIds).toEqual([FILE_A]);
    expect(unresolvedCitations).toEqual([]);
  });

  it('reports a citation that names a frame the run never captured', () => {
    const doc: DocLike = {
      body: { content: [para(40, [['See `never-captured.png`.\n', null]])] },
    };
    const { anchors, unresolvedCitations } = collectImageAnchors(doc, noNames);
    expect(anchors).toEqual([]);
    expect(unresolvedCitations).toEqual(['never-captured.png']);
  });

  it('skips a paragraph that already renders an image (re-runs are safe)', () => {
    const doc: DocLike = {
      body: {
        content: [
          para(50, [['Connect home', `https://drive.google.com/file/d/${FILE_A}/view`]], {
            image: true,
          }),
        ],
      },
    };
    const { anchors } = collectImageAnchors(doc, noNames);
    expect(anchors[0].alreadyIllustrated).toBe(true);
    expect(buildEmbedRequests(anchors)).toEqual([]);
  });

  it('reaches paragraphs inside tables', () => {
    const doc: DocLike = {
      body: {
        content: [
          {
            endIndex: 100,
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        para(60, [['Home', `https://drive.google.com/file/d/${FILE_A}/view`]]),
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const { anchors } = collectImageAnchors(doc, noNames);
    expect(anchors.map((a) => a.endIndex)).toEqual([60]);
  });
});

describe('buildEmbedRequests', () => {
  it('inserts a new paragraph after the citing one and fills it with the frames', () => {
    const reqs = buildEmbedRequests(
      [{ endIndex: 100, fileIds: [FILE_A], alreadyIllustrated: false, excerpt: 'x' }],
      { widthPt: 140, naturalSize: () => ({ width: 1080, height: 2400 }) },
    );
    expect(reqs[0]).toEqual({ insertText: { location: { index: 99 }, text: '\n' } });
    const img = reqs[1] as any;
    expect(img.insertInlineImage.location.index).toBe(100);
    expect(img.insertInlineImage.uri).toBe(driveImageUri(FILE_A));
    // Aspect preserved from the natural pixel size: 140 * 2400/1080.
    expect(img.insertInlineImage.objectSize.width.magnitude).toBe(140);
    expect(img.insertInlineImage.objectSize.height.magnitude).toBeCloseTo(311.11, 1);
    // The citing paragraph is often a numbered step; the image paragraph must
    // not inherit its bullet or it renumbers the whole list.
    expect(reqs.some((r) => 'deleteParagraphBullets' in r)).toBe(true);
  });

  it('advances the index by one per inserted element, spacing multiple frames', () => {
    const reqs = buildEmbedRequests(
      [{ endIndex: 100, fileIds: [FILE_A, FILE_B], alreadyIllustrated: false, excerpt: 'x' }],
      {},
    );
    const indices = reqs
      .filter((r) => 'insertInlineImage' in r || (r as any).insertText?.text === ' ')
      .map((r) => ((r as any).insertInlineImage ?? (r as any).insertText).location.index);
    expect(indices).toEqual([100, 101, 102]); // image, space, image
  });

  it('emits anchors in DESCENDING document order', () => {
    // Every insertion shifts the indices after it. Working backwards is what
    // keeps the later (earlier-in-document) indices valid against the
    // document as it was read; ascending order silently misfiles images.
    const reqs = buildEmbedRequests(
      [
        { endIndex: 100, fileIds: [FILE_A], alreadyIllustrated: false, excerpt: 'a' },
        { endIndex: 500, fileIds: [FILE_B], alreadyIllustrated: false, excerpt: 'b' },
        { endIndex: 300, fileIds: [FILE_A], alreadyIllustrated: false, excerpt: 'c' },
      ],
      {},
    );
    const splits = reqs
      .filter((r) => (r as any).insertText?.text === '\n')
      .map((r) => (r as any).insertText.location.index);
    expect(splits).toEqual([499, 299, 99]);
  });

  it('renders square when the natural size is unknown rather than throwing', () => {
    const reqs = buildEmbedRequests(
      [{ endIndex: 10, fileIds: [FILE_A], alreadyIllustrated: false, excerpt: 'x' }],
      { widthPt: 140 },
    );
    const size = (reqs[1] as any).insertInlineImage.objectSize;
    expect(size.height.magnitude).toBe(140);
  });
});

describe('countInlineImages', () => {
  it('counts inline objects across paragraphs and tables', () => {
    const doc: DocLike = {
      body: {
        content: [
          para(10, [['a', null]], { image: true }),
          {
            endIndex: 40,
            table: {
              tableRows: [{ tableCells: [{ content: [para(30, [['b', null]], { image: true })] }] }],
            },
          },
        ],
      },
    };
    expect(countInlineImages(doc)).toBe(2);
  });
});
