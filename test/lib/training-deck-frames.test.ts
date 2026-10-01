/**
 * `lib/training-deck-frames.ts` — every screen slide gets a real frame, or
 * stops being a screen slide.
 *
 * Grounded on the deck the render eval failed: spark-facilitator/20260926-1800
 * (4.66 / fail, 2026-10-01). Fixtures in
 * `test/fixtures/training-deck/spark-20260926-1800/`, all read from Drive
 * read-only on 2026-10-01:
 *
 *   - `training-deck-spec.yaml` — the run's spec, verbatim (54 slides);
 *   - `app-screenshot-capture_manifest.yaml` — the run's capture manifest,
 *     verbatim. It is the FORK's copy: its `run_id` is 20260925-1536 and its
 *     114 frames live in that run's `screenshots/` folder, not the fork's;
 *   - `run_state.yaml` — the fork's run_state, verbatim (`forked_from`);
 *   - `source-run_state.yaml` — the header of 20260925-1536's run_state
 *     (`lineage.supersedes`, no fork);
 *   - `previews/apps-{learn,deliver}_previews.yaml` — the fork's
 *     `3-commcare/previews/*\/_previews.yaml`, verbatim;
 *   - `frame-stats.json` — `measureFrame` over the 101 full-size frames the
 *     binder considers, written by `scripts/bind-deck-frames.ts --stats-out`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  assessFrame,
  bindDeckFrames,
  buildFramePool,
  checkDeckScreenBacking,
  forkParentRunId,
  walkForkLineage,
  type FrameSource,
  type PoolFrame,
} from '../../lib/training-deck-frames';
import {
  TrainingDeckSpecSchema,
  parseTrainingSpec,
  resolveManifest,
  imageRefsOnSlide,
  extractDriveFileId,
  type TrainingDeckSpec,
} from '../../lib/training-deck-spec';
import type { FrameStats } from '../../lib/frame-pixels';

const FIX = join(__dirname, '../fixtures/training-deck/spark-20260926-1800');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');

const SPEC: TrainingDeckSpec = TrainingDeckSpecSchema.parse(yaml.load(readFileSync(join(FIX, 'training-deck-spec.yaml'), 'utf8')));
const MANIFEST = yaml.load(readFileSync(join(FIX, 'app-screenshot-capture_manifest.yaml'), 'utf8')) as Record<string, unknown>;
const FORK_STATE = yaml.load(read('run_state.yaml'));
const SOURCE_STATE = yaml.load(read('source-run_state.yaml'));
const PREVIEWS = [yaml.load(read('previews/apps-learn_previews.yaml')), yaml.load(read('previews/apps-deliver_previews.yaml'))] as FrameSource['previews'];
const STATS = new Map(Object.entries(JSON.parse(readFileSync(join(FIX, 'frame-stats.json'), 'utf8')) as Record<string, FrameStats>));

const FORK = '20260926-1800';
const SOURCE = '20260925-1536';

const poolFor = (sources: FrameSource[]) => buildFramePool({ specManifest: SPEC.manifest, sources });
const POOL = poolFor([{ run_id: FORK, manifest: MANIFEST, previews: PREVIEWS }]);

const slides = (spec: TrainingDeckSpec) => spec.modules.flatMap((m) => m.slides);
const byId = (spec: TrainingDeckSpec, id: string) => slides(spec).find((s) => s.id === id);

describe('fork lineage', () => {
  it('reads the forker\'s top-level forked_from', () => {
    expect(forkParentRunId(FORK_STATE)).toBe(SOURCE);
  });

  it('does not follow `supersedes` — a superseded run is a different build', () => {
    // 20260925-1536 supersedes 20260910-1624; their Learn apps differ.
    expect(forkParentRunId(SOURCE_STATE)).toBeNull();
  });

  it('reads the run-record spelling, lineage.forked_from, too', () => {
    expect(forkParentRunId({ lineage: { forked_from: SOURCE, forked_at_phase: 'qa-and-training' } })).toBe(SOURCE);
  });

  it('walks fork -> source and stops where the chain does', async () => {
    const states: Record<string, unknown> = { [FORK]: FORK_STATE, [SOURCE]: SOURCE_STATE };
    expect(await walkForkLineage(FORK, async (id) => states[id] ?? null)).toEqual([FORK, SOURCE]);
  });

  it('stops on a cycle instead of looping', async () => {
    const states: Record<string, unknown> = { a: { forked_from: 'b' }, b: { forked_from: 'a' } };
    expect(await walkForkLineage('a', async (id) => states[id] ?? null)).toEqual(['a', 'b']);
  });

  it('a fork whose own manifest is missing binds the SAME frames through its source', () => {
    // The fork copies phase artifacts but not their screenshots (ace-web#758);
    // here the fork has no manifest at all and only the source does.
    const viaSource = poolFor([
      { run_id: FORK, manifest: null },
      { run_id: SOURCE, manifest: MANIFEST, previews: PREVIEWS },
    ]);
    const a = bindDeckFrames(SPEC, { pool: POOL, stats: STATS }).spec;
    const b = bindDeckFrames(SPEC, { pool: viaSource, stats: STATS }).spec;
    expect(b).toEqual(a);
    expect(viaSource.find((f) => f.step === 'learn-launch-suite-root')?.origin_run).toBe(SOURCE);
  });

  it('the fork\'s own row wins over the source\'s for the same step', () => {
    const own = { captures: [{ step: 'deliver-sync-success', file_id: 'FORK_OWN_FRAME_000000001', shows: 'fork capture' }] };
    const pool = poolFor([
      { run_id: FORK, manifest: own },
      { run_id: SOURCE, manifest: MANIFEST },
    ]);
    const f = pool.find((p) => p.step === 'deliver-sync-success')!;
    expect([f.file_id, f.origin_run]).toEqual(['FORK_OWN_FRAME_000000001', FORK]);
  });
});

describe('the pool', () => {
  it('reads every capture with a file id, the shared pool, and the previews indexes', () => {
    expect(POOL.filter((f) => f.kind === 'common').map((f) => f.alias)).toContain('commcare-welcome');
    expect(POOL.find((f) => f.step === 'form-summary')?.kind).toBe('preview');
    expect(POOL.filter((f) => f.kind === 'opp').length).toBeGreaterThan(100);
  });
});

describe('assessFrame', () => {
  const frame = (step: string) => POOL.find((f) => f.step === step) as PoolFrame;
  const d = (step: string) => assessFrame(frame(step), STATS.get(frame(step).file_id));

  it('a loading screen is near-empty', () => {
    expect(d('learn-install')).toContain('near-empty');
  });
  it('a lesson\'s "finished" landing is navigation (its shows says "No lesson content")', () => {
    expect(d('journey-learn-m2-register-finished')).toContain('navigation');
    expect(d('journey-learn-m3-record-finished')).toContain('navigation');
  });
  it('a keyboard-covered form is weak', () => {
    expect(d('journey-deliver-notes-last-item')).toContain('keyboard');
  });
  it('a quiz question and a filled form have no defect', () => {
    expect(d('journey-learn-m0-q1-answered')).toEqual([]);
    expect(d('journey-deliver-who-came')).toEqual([]);
  });
});

describe('checkDeckScreenBacking', () => {
  it('FAILS the deck that shipped — the ten screen slides the eval named, plus the unreadable three-up', () => {
    const r = checkDeckScreenBacking(SPEC, { pool: POOL, stats: STATS });
    expect(r.pass).toBe(false);
    const flagged = r.findings.map((f) => f.slide);
    // Slides 5, 7, 11, 16, 18, 19, 20, 21 (no frame at all) …
    for (const id of [
      'install-commcare',
      'personal-id-details',
      'syncing',
      'learn-your-role-in-this-pilot',
      'learn-recording-a-meeting',
      'learn-counting-attendance-and-participation',
      'learn-steps-and-savings',
      'learn-how-payment-works',
    ]) {
      expect(flagged, id).toContain(id);
    }
    // … slide 10 (loading screen), slide 17 (a form list on a lesson slide) …
    expect(r.findings.find((f) => f.slide === 'install-learn')?.reason).toBe('unusable-frame');
    expect(r.findings.find((f) => f.slide === 'learn-registering-yourself-and-your-community')?.reason).toBe('unusable-frame');
    // … and slide 6, the three phones at ~54% of the height.
    expect(r.findings.find((f) => f.slide === 'personal-id-start')?.reason).toBe('phones-too-small');
    expect(r.auto_fix_hint).toMatch(/bind-deck-frames/);
  });

  it('still sees the spec-only defects with no pool at all (the render-side gate)', () => {
    const r = checkDeckScreenBacking(SPEC);
    expect(r.pass).toBe(false);
    expect(r.findings.map((f) => f.slide)).toContain('learn-your-role-in-this-pilot');
  });

  it('PASSES the same deck once bound', () => {
    const { spec } = bindDeckFrames(SPEC, { pool: POOL, stats: STATS });
    expect(checkDeckScreenBacking(spec, { pool: POOL, stats: STATS }).pass).toBe(true);
    // …and passes the pool-less render-side gate too.
    expect(checkDeckScreenBacking(spec).pass).toBe(true);
  });
});

describe('bindDeckFrames on the real deck', () => {
  const { spec: BOUND, report } = bindDeckFrames(SPEC, { pool: POOL, stats: STATS });
  const aliasOf = (id: string) => (byId(BOUND, id) as { image?: string } | undefined)?.image;

  it('binds the frames the run HAD for slides that shipped empty', () => {
    expect(aliasOf('install-commcare')).toBe('@commcare-welcome'); // "you see its welcome screen"
    expect(aliasOf('syncing')).toBe('@deliver-launch-home'); // the Deliver home with its Sync with Server tile
  });

  it('replaces the loading screen with the installed Learn app', () => {
    expect(aliasOf('install-learn')).toBe('@learn-launch-home-tiles');
    expect(report.actions).toContainEqual(
      expect.objectContaining({ kind: 'replaced', slide: 'install-learn', from: 'learn-install', because: ['near-empty'] }),
    );
  });

  it('merges the six Learn modules no frame can illustrate into one slide over the Learn home grid', () => {
    const merged = byId(BOUND, 'learn-other-sections') as { layout: string; image: string; body: string; notes: string };
    expect(merged.layout).toBe('walkthrough');
    expect(merged.image).toBe('@learn-launch-suite-root');
    for (const label of ['Your role in this pilot', 'Registering yourself and your community', 'How payment works']) {
      expect(merged.body).toContain(`- ${label}`); // verbatim app labels (ace#1829)
    }
    // Nothing the six slides said is lost — it moves to the speaker notes.
    expect(merged.notes).toContain('Speakers can never be more than attendees.');
    for (const id of ['learn-your-role-in-this-pilot', 'learn-recording-a-meeting', 'learn-registering-yourself-and-your-community']) {
      expect(byId(BOUND, id)).toBeUndefined();
    }
    // The siblings that DO have frames keep them.
    expect(aliasOf('learn-before-you-start')).toBe('@journey-learn-m0-q1-answered');
    expect(aliasOf('learn-final-assessment')).toBe('@journey-learn-m7-q12-last-item-result');
  });

  it('folds a screen slide with no frame of its screen into its neighbour\'s notes', () => {
    expect(byId(BOUND, 'personal-id-details')).toBeUndefined();
    expect(byId(BOUND, 'personal-id-start-3')?.notes).toContain('Enter the code sent to your phone');
  });

  it('expands the three-up into one legible phone per slide', () => {
    expect(slides(BOUND).some((s) => s.layout === 'mobile_flow')).toBe(false);
    expect(['personal-id-start-1', 'personal-id-start-2', 'personal-id-start-3'].map(aliasOf)).toEqual([
      '@personal-id-start',
      '@personal-id-name',
      '@personal-id-phone',
    ]);
  });

  it('keeps a keyboard frame when nothing else shows that screen, and says so', () => {
    expect(aliasOf('meeting-finish')).toBe('@journey-deliver-notes-last-item');
    expect(report.actions).toContainEqual({ kind: 'kept', slide: 'meeting-finish', alias: 'journey-deliver-notes-last-item', weak: ['keyboard'] });
  });

  it('places no frame twice, and every image resolves', () => {
    const resolver = resolveManifest(BOUND.manifest);
    const ids = slides(BOUND).flatMap(imageRefsOnSlide).map((r) => extractDriveFileId(resolver.resolveImageRef(r)));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('asks for a `shows:` on the one newly placed frame nobody described', () => {
    expect(report.needs_shows).toEqual(['learn-launch-home-tiles']);
  });

  it('round-trips as a valid spec, formatting budgets included', () => {
    expect(() => parseTrainingSpec(yaml.dump(BOUND, { lineWidth: -1 }))).not.toThrow();
  });

  it('is deterministic and does not mutate its input', () => {
    const before = JSON.stringify(SPEC);
    expect(bindDeckFrames(SPEC, { pool: POOL, stats: STATS }).spec).toEqual(BOUND);
    expect(JSON.stringify(SPEC)).toBe(before);
  });

  it('a rejected frame is not used: the slide falls back to merge, never to empty', () => {
    const { spec } = bindDeckFrames(SPEC, { pool: POOL, stats: STATS, reject: new Set(['learn-launch-home-tiles']) });
    expect((byId(spec, 'install-learn') as { image?: string } | undefined)?.image).not.toBe('@learn-launch-home-tiles');
    expect(checkDeckScreenBacking(spec, { pool: POOL, stats: STATS }).pass).toBe(true);
  });
});
