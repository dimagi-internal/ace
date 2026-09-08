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
import yaml from 'js-yaml';
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

  it('reads the `journeys[].steps[]` shape — the other one producers write (ace#2104)', () => {
    // bednet-check-2-visit/20260902-1555 wrote `steps[]`, not `screenshots[]`,
    // so this flattened to ZERO frames and all 16 per-opp citations came back
    // `unknown-id` — an UNFIXABLE blocker, since the only way to satisfy it is
    // to drop every image, which is the hollow deck ace#856 exists to prevent.
    const f = flattenManifestFrames({
      journeys: [
        {
          journey_id: 'journey-learn-pass',
          steps: [
            { step_name: 'learn-home', file_id: '1LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL', shows: 'lesson menu' },
            { step_name: 'alias', file_id: '1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', duplicate_of: 'learn-home' },
          ],
        },
      ],
    });
    expect(f.map((x) => x.step)).toEqual(['learn-home', 'alias']);
    expect(f[1].duplicate_of).toBe('learn-home');
    expect(f[0].shows).toBe('lesson menu');
  });

  it('does NOT flatten `superseded_artifacts[]` — citing one stays a defect (ace#1571)', () => {
    // Forensics from an EARLIER FAILED dispatch. They are not steps of the walk
    // that shipped, so an artifact citing one must still fail as `unknown-id`.
    const f = flattenManifestFrames({
      journeys: [
        {
          steps: [{ step_name: 'real', file_id: '1RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR', shows: 'the home screen' }],
          superseded_artifacts: [
            { step_name: 'journey-learn-FAILURE', file_id: '1SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS', superseded: true },
          ],
        },
      ],
    });
    expect(f.map((x) => x.step)).toEqual(['real']);
  });

  it('is inert on junk rather than throwing mid-phase', () => {
    expect(flattenManifestFrames(null)).toEqual([]);
    expect(flattenManifestFrames({})).toEqual([]);
    expect(flattenManifestFrames({ journeys: [{ screenshots: [{ nope: 1 }] }] })).toEqual([]);
    expect(flattenManifestFrames({ journeys: [{ steps: [{ nope: 1 }] }] })).toEqual([]);
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

/**
 * A deck spec is not a rendered document: it carries an INVENTORY.
 *
 * `manifest.opp` is the resolution map — every alias the deck COULD place,
 * lifted wholesale from `app-screenshot-capture_manifest.yaml` per
 * `training-deck-generate` § step 5. The slides then place a handful of them
 * by `@alias`. A whole-text scan cannot tell the two apart, so every captured
 * frame read as a citation and the skill's own BLOCKER became unpassable by
 * construction on a correctly-authored spec.
 *
 * Measured on spark-facilitator/20260907-1120 (spec
 * 1ScbRGMTWyE815eL8AmOO-Zv3zNdM2396KPyjqKo-eN0, manifest
 * 1wtEqtASnagoFcDiHQtPtDYLqONlcT1Cfc-gMF6S4FN0): 10 images on slides, and the
 * guard reported `{cited_total: 91, backed: 13, findings: 66 x no-shows +
 * 12 x duplicate-cited}` — every one of them naming a frame no slide cites.
 *
 * The fix is NOT to relax the gate. It is to count the citations: what the
 * SLIDES place, resolved through the map. The negative controls below are what
 * prove the protection survived — a spec that really does assert over an
 * undescribed, aliased or unknown frame still fails.
 */
describe('a deck spec cites what its SLIDES place, not its inventory (ace#2238)', () => {
  const ID = {
    lookedAt: '1ICjkUfAL2OWy92R3C2R6PJ8ma5RmWRv7',
    neverOpened: '1f0yIM_3NltXDca_weNzp5BCCp4nw2uI5',
    aliasFrame: '1MATzM3c37YlA5mtoFaoPQh5s4xG8Y51g',
    pool: '1bBJM2FjPG8E2RVFEtLABkRUr3rTwZQEx',
  };

  const manifest = {
    journeys: [
      {
        screenshots: [
          { step_name: 'looked-at', file_id: ID.lookedAt, shows: 'Deliver home, Daily Visits 1/200.' },
          { step_name: 'never-opened', file_id: ID.neverOpened },
        ],
        duplicates: [{ step_name: 'alias', file_id: ID.aliasFrame, duplicate_of: 'looked-at' }],
      },
    ],
  };

  const uc = (id: string) => `https://drive.google.com/uc?export=view&id=${id}`;

  /** The full pool, exactly as step 5 builds it: every captured alias. */
  const INVENTORY: Record<string, string> = {
    'looked-at': uc(ID.lookedAt),
    'never-opened': uc(ID.neverOpened),
    alias: uc(ID.aliasFrame),
  };

  function deckSpec(slides: unknown[], opp: Record<string, string> = INVENTORY): string {
    return yaml.dump({
      slug: 'demo-opp',
      name: 'Demo',
      program: 'Demo Program',
      archetype: 'atomic-visit',
      template_id: 'connect-training-atomic',
      generated_at: '2026-09-08T00:00:00Z',
      source: { pdd_doc_id: 'pdd', run_id: '20260907-1120' },
      manifest: { common: { 'connect-signin-splash': uc(ID.pool) }, opp, template: {} },
      voice: { audience: 'flw', estimated_duration_minutes: 180, language: 'English' },
      modules: [{ id: 'your-opportunity', title: 'Your Opportunity', slides }],
    });
  }

  const walkthrough = (id: string, image: string) => ({
    id, layout: 'walkthrough', title: 'Form 1', image, body: 'Tap Next.',
  });

  it('THE BUG: an inventory the slides do not place is not cited', () => {
    // One slide, one image. The other two pool entries are available, not asserted over.
    const r = classifyCaptionBacking({
      published: deckSpec([walkthrough('s1', '@looked-at')]),
      manifest,
      poolFileIds: [ID.pool],
    });
    expect(r.cited_total).toBe(1);
    expect(r.cited_distinct).toBe(1);
    expect(r.backed).toBe(1);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('NEGATIVE CONTROL: a slide that really does assert over an undescribed frame still fails', () => {
    const r = classifyCaptionBacking({
      published: deckSpec([
        walkthrough('s1', '@looked-at'),
        walkthrough('s2', '@never-opened'),
      ]),
      manifest,
      poolFileIds: [ID.pool],
    });
    expect(r.ok).toBe(false);
    expect(r.cited_total).toBe(2);
    expect(r.findings).toEqual([
      { file_id: ID.neverOpened, step: 'never-opened', reason: 'no-shows' },
    ]);
  });

  it('NEGATIVE CONTROL: a placed alias frame is still caught as its own moment', () => {
    const r = classifyCaptionBacking({
      published: deckSpec([walkthrough('s1', '@alias')]),
      manifest,
      poolFileIds: [ID.pool],
    });
    expect(r.findings.map((f) => f.reason)).toEqual(['duplicate-cited']);
  });

  it('NEGATIVE CONTROL: a placed id the manifest never heard of is still unknown', () => {
    const r = classifyCaptionBacking({
      published: deckSpec([walkthrough('s1', '@stranger')], {
        ...INVENTORY,
        stranger: uc('1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'),
      }),
      manifest,
      poolFileIds: [ID.pool],
    });
    expect(r.findings).toEqual([
      { file_id: '1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', reason: 'unknown-id' },
    ]);
  });

  it('an @alias the map cannot resolve surfaces rather than vanishing', () => {
    const r = classifyCaptionBacking({
      published: deckSpec([walkthrough('s1', '@invented-by-the-generator')]),
      manifest,
      poolFileIds: [ID.pool],
    });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([
      { file_id: '@invented-by-the-generator', reason: 'unknown-id' },
    ]);
  });

  it('reads every image-bearing layout, not just walkthrough', () => {
    const r = classifyCaptionBacking({
      published: deckSpec([
        { id: 'f', layout: 'mobile_flow', title: 'Flow', steps: [
          { image: '@looked-at', caption: 'a' },
          { image: '@never-opened', caption: 'b' },
        ] },
        { id: 't', layout: 'two_column', title: 'Two',
          left: { heading: 'L', body: 'l', image: '@alias' },
          right: { heading: 'R', body: 'r' } },
      ]),
      manifest,
      poolFileIds: [ID.pool],
    });
    expect(r.cited_total).toBe(3);
    expect(r.findings.map((f) => f.reason).sort()).toEqual(['duplicate-cited', 'no-shows']);
  });

  it('a raw Drive link in a slide body is a citation, inventory or not', () => {
    // The inventory exemption is scoped to the map. Anything else a reader can
    // see in the spec is still read the way a rendered document is read.
    const r = classifyCaptionBacking({
      published: deckSpec([
        { id: 'c', layout: 'content', title: 'See also',
          body: `Full size: https://drive.google.com/file/d/${ID.neverOpened}/view` },
      ]),
      manifest,
      poolFileIds: [ID.pool],
    });
    expect(r.cited_total).toBe(1);
    expect(r.findings.map((f) => f.reason)).toEqual(['no-shows']);
  });

  it('leaves a rendered document alone — the text scan still governs there', () => {
    const guide = `# FLW guide\n\n![home](${link(ID.neverOpened)})\n`;
    const r = classifyCaptionBacking({ published: guide, manifest });
    expect(r.cited_total).toBe(1);
    expect(r.findings.map((f) => f.reason)).toEqual(['no-shows']);
  });

  it('is inert on a YAML document that is not a deck spec', () => {
    const verdict = yaml.dump({ skill: 'x', passed: true, evidence: link(ID.neverOpened) });
    const r = classifyCaptionBacking({ published: verdict, manifest });
    expect(r.cited_total).toBe(1);
    expect(r.findings.map((f) => f.reason)).toEqual(['no-shows']);
  });
});
