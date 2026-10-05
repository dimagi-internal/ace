/**
 * ace#2660 — the training deck must not show trainees the Phase 4 dogfood
 * opportunity's run-id-prefixed name ("20261004-1706 · Spark Facilitator — …").
 *
 * Rule (orchestrator decision): prefer a sibling frame of the same screen with
 * no title; else bind a crop that starts below the title, computed
 * deterministically; never alter pixels other than cropping; never fabricate
 * a frame.
 *
 * Grounded on the real deck + manifest of spark-facilitator/20260926-1800
 * (fixtures shared with training-deck-frames.test.ts) and the committed real
 * frame `frames/claim-opp-handoff-learn-home.png` (Connect's Learn home: the
 * job card reading "20260925-1536 · Spark Facilitator — FCAP …").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { bindDeckFrames, buildFramePool, sameScreenFamily, type PoolFrame } from '../../lib/training-deck-frames';
import { TrainingDeckSpecSchema, type TrainingDeckSpec } from '../../lib/training-deck-spec';
import { decodePng, type FrameStats } from '../../lib/frame-pixels';
import {
  belowTitleAlias,
  belowTitleCropTop,
  cropRasterTop,
  encodePng,
  oppTitleExposure,
  RUN_ID_TITLE_PREFIX,
} from '../../lib/opp-title-frames';

const FIX = join(__dirname, '../fixtures/training-deck/spark-20260926-1800');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const SPEC: TrainingDeckSpec = TrainingDeckSpecSchema.parse(yaml.load(read('training-deck-spec.yaml')));
const MANIFEST = yaml.load(read('app-screenshot-capture_manifest.yaml')) as Record<string, unknown>;
const STATS = new Map(Object.entries(JSON.parse(read('frame-stats.json')) as Record<string, FrameStats>));
const POOL = buildFramePool({ specManifest: SPEC.manifest, sources: [{ run_id: '20260925-1536', manifest: MANIFEST }] });

const slide = (spec: TrainingDeckSpec, id: string) => spec.modules.flatMap((m) => m.slides).find((s) => s.id === id) as { image?: string } | undefined;
const fileIdOf = (alias: string) => POOL.find((f) => f.alias === alias)!.file_id;

describe('which frames show the dogfood opportunity title', () => {
  it('the frames the issue names', () => {
    for (const step of ['claim-opp', 'claim-opp-detail', 'claim-opp-handoff-learn-home', 'learn-launch-home-tiles']) {
      expect(oppTitleExposure({ step }), step).toBe('top');
    }
    for (const step of ['claim-opp-list', 'claim-opp-list-synced', 'claim-opp-new-tile', 'connect-resume-opp-tile', 'connect-resume-opp-landed']) {
      expect(oppTitleExposure({ step }), step).toBe('repeated');
    }
  });

  it('a frame of any other step is caught by a run-id prefix quoted in its shows:', () => {
    const shows = "Connect opp detail: title '20260925-1536 · Spark Facilitator — FCAP Community Meeting Facilitation'";
    expect(RUN_ID_TITLE_PREFIX.test(shows)).toBe(true);
    expect(oppTitleExposure({ step: 'some-new-step', shows })).toBe('repeated');
  });

  it('frames without the title are clean', () => {
    for (const step of ['learn-launch-suite-root', 'commcare-welcome', 'deliver-launch-home', 'personal-id-phone']) {
      expect(oppTitleExposure({ step }), step).toBe('none');
    }
  });

  it('a sibling of the same screen is a variant of the same step, not a word match', () => {
    expect(sameScreenFamily('claim-opp-detail', 'claim-opp-detail-scrolled')).toBe(true);
    expect(sameScreenFamily('claim-opp-detail', 'connect-login-first-start')).toBe(false);
    expect(sameScreenFamily('claim-opp-detail', 'claim-opp-detail')).toBe(false);
  });
});

describe('the crop — pixels from the real frame', () => {
  const png = new Uint8Array(readFileSync(join(FIX, 'frames/claim-opp-handoff-learn-home.png')));
  const r = decodePng(png);

  it('cuts below the job card that carries the run id, above the CommCare logo', () => {
    // 270x600 fixture: app bar ends ~y=59, job card ~y=67-134, logo from ~y=148.
    // Same cut, in proportion, on the full-size 1080x2400 frame from Drive: 692.
    const top = belowTitleCropTop(r);
    expect(top).not.toBeNull();
    expect(top! / r.height).toBeGreaterThan(0.24);
    expect(top! / r.height).toBeLessThan(0.3);
  });

  it('is deterministic', () => {
    expect(belowTitleCropTop(r)).toBe(belowTitleCropTop(decodePng(png)));
  });

  it('only crops: every kept row is the source row, byte for byte, through a PNG round-trip', () => {
    const top = belowTitleCropTop(r)!;
    const cropped = decodePng(encodePng(cropRasterTop(r, top)));
    expect(cropped.width).toBe(r.width);
    expect(cropped.height).toBe(r.height - top);
    expect(Buffer.from(cropped.rgb).equals(Buffer.from(r.rgb.subarray(top * r.width * 3)))).toBe(true);
  });

  it('refuses a frame with no title block in its top half (a flat field)', () => {
    const flat = { width: 100, height: 200, rgb: new Uint8Array(100 * 200 * 3).fill(240) };
    expect(belowTitleCropTop(flat)).toBeNull();
  });
});

describe('bindDeckFrames on the real deck (ace#2660)', () => {
  // On the real deck: `claim-opportunity` cites @claim-opp-detail,
  // `install-learn` is bound to learn-launch-home-tiles, `connect-home`
  // cites @claim-opp-new-tile — all three show "20260925-1536 · …".
  const cropTops = new Map<string, number | null>([
    [fileIdOf('claim-opp-detail'), 541],
    [fileIdOf('learn-launch-home-tiles'), 692],
  ]);

  it('the raw frames ship today: without a crop or sibling, the binder says so instead of passing silently', () => {
    const { spec, report } = bindDeckFrames(SPEC, { pool: POOL, stats: STATS });
    expect(slide(spec, 'claim-opportunity')?.image).toBe('@claim-opp-detail');
    expect(report.opp_title_visible).toEqual(['connect-home', 'claim-opportunity', 'install-learn']);
  });

  it('PREFERS a clean sibling of the same screen when the pool has one', () => {
    const sibling: PoolFrame = {
      alias: 'claim-opp-detail-scrolled', step: 'claim-opp-detail-scrolled', file_id: 'SIBLING_ID',
      shows: 'Connect opp detail scrolled past its title: description, Complete Project by date, Start button.',
      kind: 'opp', surface: 'platform', order: 999,
    };
    const { spec, report } = bindDeckFrames(SPEC, { pool: [...POOL, sibling], stats: STATS, cropTops });
    expect(slide(spec, 'claim-opportunity')?.image).toBe('@claim-opp-detail-scrolled');
    expect(report.actions).toContainEqual({ kind: 'opp-title-sibling', slide: 'claim-opportunity', from: 'claim-opp-detail', to: 'claim-opp-detail-scrolled' });
    expect(spec.manifest.opp?.['claim-opp-detail-scrolled']).toContain('SIBLING_ID');
    expect(report.crops.map((c) => c.from_alias)).not.toContain('claim-opp-detail');
  });

  it('with no sibling, binds a below-the-title CROP of the same frame — never a different screen', () => {
    const { spec, report } = bindDeckFrames(SPEC, { pool: POOL, stats: STATS, cropTops });
    expect(slide(spec, 'claim-opportunity')?.image).toBe(`@${belowTitleAlias('claim-opp-detail')}`);
    expect(slide(spec, 'install-learn')?.image).toBe(`@${belowTitleAlias('learn-launch-home-tiles')}`);
    expect(report.crops).toEqual([
      expect.objectContaining({ alias: 'claim-opp-detail--below-title', from_alias: 'claim-opp-detail', from_file_id: fileIdOf('claim-opp-detail'), top: 541, slides: ['claim-opportunity'] }),
      expect.objectContaining({ alias: 'learn-launch-home-tiles--below-title', from_alias: 'learn-launch-home-tiles', top: 692, slides: ['install-learn'] }),
    ]);
    // A crop is a new frame: it needs its own `shows:` before caption backing passes.
    expect(report.needs_shows).toEqual(expect.arrayContaining(['claim-opp-detail--below-title', 'learn-launch-home-tiles--below-title']));
  });

  it('a list of opportunity cards is never cropped — every card carries a run id', () => {
    const { spec, report } = bindDeckFrames(SPEC, { pool: POOL, stats: STATS, cropTops: new Map([[fileIdOf('claim-opp-new-tile'), 300]]) });
    expect(slide(spec, 'connect-home')?.image).toBe('@claim-opp-new-tile');
    expect(report.opp_title_visible).toContain('connect-home');
    expect(report.actions).toContainEqual(expect.objectContaining({ kind: 'opp-title-visible', slide: 'connect-home', alias: 'claim-opp-new-tile' }));
  });
});
