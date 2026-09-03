/**
 * The fence that reads the PUBLISHED artifact.
 *
 * `framesCitedWithoutShows` (lib/capture-manifest.ts) was the first attempt and
 * had the defect it was written to prevent: it took a caller-supplied list of
 * cited steps, so a producer had to remember to call it AND to hand it an
 * honest list. Its only callers were its own tests. This one takes the
 * published document and derives the citations, so there is nothing to curate.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCaptionBacking,
  extractCitedFileIds,
  flattenManifestFrames,
} from '../../lib/caption-backing.js';

const link = (id: string) => `https://drive.google.com/file/d/${id}/view`;

describe('extractCitedFileIds', () => {
  it('finds the markdown LINK form ace#1338 mandates', () => {
    const md = `See [the home screen](${link('AAAAAAAAAAA')}) then tap.`;
    expect(extractCitedFileIds(md)).toEqual(['AAAAAAAAAAA']);
  });

  it('finds the uc?export=view form deck specs use for Slides imports', () => {
    const spec = 'image: "https://drive.google.com/uc?export=view&id=BBBBBBBBBBB"';
    expect(extractCitedFileIds(spec)).toEqual(['BBBBBBBBBBB']);
  });

  it('keeps repeats so re-use is visible', () => {
    const md = `${link('CCCCCCCCCCC')} and again ${link('CCCCCCCCCCC')}`;
    expect(extractCitedFileIds(md)).toHaveLength(2);
  });

  it('finds nothing in a text-only artifact', () => {
    expect(extractCitedFileIds('No pictures here at all.')).toEqual([]);
  });
});

describe('flattenManifestFrames — both shapes in the wild', () => {
  it('reads the documented `captures:` shape', () => {
    const f = flattenManifestFrames({
      captures: [{ step: 'a', file_id: '1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', shows: 'the home screen' }],
    });
    expect(f).toEqual([{ step: 'a', file_id: '1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', shows: 'the home screen', duplicate_of: undefined }]);
  });

  it('reads the `journeys[].screenshots[]` shape producers actually write', () => {
    // A fence that only understood the documented shape would find ZERO frames
    // on every real manifest and pass everything — the exact failure mode this
    // class of check exists to catch.
    const f = flattenManifestFrames({
      journeys: [
        {
          journey_id: 'journey-learn-pass',
          screenshots: [{ step_name: 'learn-home', file_id: '1LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL', shows: 'lesson menu' }],
          duplicates: [{ step_name: 'alias', file_id: '1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', duplicate_of: 'learn-home' }],
        },
      ],
    });
    expect(f.map((x) => x.step)).toEqual(['learn-home', 'alias']);
    expect(f[1].duplicate_of).toBe('learn-home');
  });

  it('is inert on junk rather than throwing mid-phase', () => {
    expect(flattenManifestFrames(null)).toEqual([]);
    expect(flattenManifestFrames({})).toEqual([]);
    expect(flattenManifestFrames({ journeys: [{ screenshots: [{ nope: 1 }] }] })).toEqual([]);
  });
});

describe('classifyCaptionBacking', () => {
  const manifest = {
    journeys: [
      {
        screenshots: [
          { step_name: 'looked-at', file_id: '1ICjkUfAL2OWy92R3C2R6PJ8ma5RmWRv7', shows: 'Deliver home, Daily Visits 1/200.' },
          { step_name: 'never-opened', file_id: '1f0yIM_3NltXDca_weNzp5BCCp4nw2uI5' },
          { step_name: 'blank', file_id: '1Sclk_paGc8_02D58iJ1oXt3ns_vP_xhM', shows: '   ' },
        ],
        duplicates: [{ step_name: 'alias', file_id: '1MATzM3c37YlA5mtoFaoPQh5s4xG8Y51g', duplicate_of: 'looked-at' }],
      },
    ],
  };

  it('passes when every cited frame carries a shows', () => {
    const r = classifyCaptionBacking({ published: link('1ICjkUfAL2OWy92R3C2R6PJ8ma5RmWRv7'), manifest });
    expect(r.ok).toBe(true);
    expect(r.backed).toBe(1);
  });

  it('THE INCIDENT: fails a frame that resolves and is distinct but undescribed', () => {
    const r = classifyCaptionBacking({ published: link('1f0yIM_3NltXDca_weNzp5BCCp4nw2uI5'), manifest });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([
      { file_id: '1f0yIM_3NltXDca_weNzp5BCCp4nw2uI5', step: 'never-opened', reason: 'no-shows' },
    ]);
  });

  it('treats a whitespace-only shows as no look at all', () => {
    const r = classifyCaptionBacking({ published: link('1Sclk_paGc8_02D58iJ1oXt3ns_vP_xhM'), manifest });
    expect(r.findings[0].reason).toBe('no-shows');
  });

  it('catches an alias cited as its own moment', () => {
    const r = classifyCaptionBacking({ published: link('1MATzM3c37YlA5mtoFaoPQh5s4xG8Y51g'), manifest });
    expect(r.findings[0].reason).toBe('duplicate-cited');
  });

  it('catches an id the manifest has never heard of', () => {
    const r = classifyCaptionBacking({ published: link('1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), manifest });
    expect(r.findings[0].reason).toBe('unknown-id');
  });

  it('accepts shared-pool ids, which are not this run’s work product', () => {
    // `_common/connect-screenshots` frames and committed deck artwork have no
    // per-run `shows` and never will; failing them would make the fence fire on
    // every run forever, which is how a good check gets switched off.
    const r = classifyCaptionBacking({
      published: link('1bBJM2FjPG8E2RVFEtLABkRUr3rTwZQEx'),
      manifest,
      poolFileIds: ['1bBJM2FjPG8E2RVFEtLABkRUr3rTwZQEx'],
    });
    expect(r.ok).toBe(true);
    expect(r.backed).toBe(1);
  });

  it('passes a text-only artifact rather than pushing it to cite decoratively', () => {
    const r = classifyCaptionBacking({ published: 'All prose, no frames.', manifest });
    expect(r.ok).toBe(true);
    expect(r.cited_distinct).toBe(0);
  });

  it('reports one finding per distinct id even when cited repeatedly', () => {
    const r = classifyCaptionBacking({
      published: `${link('1f0yIM_3NltXDca_weNzp5BCCp4nw2uI5')} ... ${link('1f0yIM_3NltXDca_weNzp5BCCp4nw2uI5')}`,
      manifest,
    });
    expect(r.cited_total).toBe(2);
    expect(r.cited_distinct).toBe(1);
    expect(r.findings).toHaveLength(1);
  });
});
