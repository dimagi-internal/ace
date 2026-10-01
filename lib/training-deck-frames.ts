//
// Every slide that shows the trainee a screen gets a REAL frame of that screen
// — or it does not ship as a screen slide at all.
//
// ## The measurement this exists for
//
// `training-deck-render-eval` judged the rendered deck of
// spark-facilitator/20260926-1800 at 4.66 / fail. Ten slides that walk the
// trainee through an app screen carried no screenshot:
//
//   - slide 5 "you see its welcome screen" — and the shared pool HAS
//     `commcare-welcome`;
//   - slide 11 "Tap Sync with Server on the Deliver home" — and the run
//     captured `deliver-sync-*`;
//   - slides 16, 18-21, Learn modules whose siblings 15/17/22 carry frames.
//
// None of those was a missing capture. `training-deck-generate` is told to
// fall back to `content` layout "if the manifest has no frame", decides that
// by eye over a 114-row manifest, and the fallback is SILENT: a downgraded
// slide is schematically a text slide, so neither the coverage gate (ace#856)
// nor the render self-eval can see that it still promises a screen. Five of
// the ten had a frame available; the other five had no frame that shows the
// screen they describe, and shipped as empty walkthroughs anyway.
//
// So this module makes the choice deterministic, from the run's own data:
//
//   1. **Pool.** Every frame the run can cite — the capture manifest, the
//      `3-commcare/previews/apps-*/_previews.yaml` indexes, the shared pool
//      and template artwork in `manifest.common` / `manifest.template` — and,
//      for a FORK, the same along `forked_from` (see `walkForkLineage`).
//   2. **Assess.** A frame is unusable when its pixels say it is a loading
//      screen, and weak when a soft keyboard covers it (`lib/frame-pixels.ts`).
//      A NAVIGATION frame (a module's form list, a "finished" landing) shows
//      where a lesson is, never what it teaches — it cannot illustrate one.
//   3. **Bind.** A slide that promises a screen gets the best frame of THAT
//      screen: Learn-module slides from that module's own frames; other slides
//      by the words of the sentence that makes the promise, within the part of
//      the app the slide is about.
//   4. **Drop or merge** what is left. Frameless Learn-module slides collapse
//      into one "other sections" slide over the Learn home grid; any other
//      frameless screen slide is folded into its neighbour's speaker notes.
//      Never shipped empty.
//   5. **Legibility.** A `mobile_flow` draws three or four phones at ~54% of
//      the slide height — "in-phone text unreadable at projector distance"
//      (slide 6). It is expanded into one walkthrough per phone.
//
// `checkDeckScreenBacking` is the gate both skills run on the result.
//

import type { QACheckResult } from './qa-types.js';
import { collectCaptureEntries, type CaptureManifestLike } from './capture-manifest.js';
import {
  extractDriveFileId,
  FORMATTING_BUDGETS,
  type SlideSpec_v2,
  type TrainingDeckSpec,
} from './training-deck-spec.js';
import { NEAR_EMPTY_INK, KEYBOARD_COVERS, type FrameStats } from './frame-pixels.js';

// ---------------------------------------------------------------------------
// Fork lineage
// ---------------------------------------------------------------------------

/**
 * The run this one was FORKED from, or null.
 *
 * Two spellings are in the wild and both are read:
 *
 *   - top-level `forked_from` (+ `forked_from_phase`) — what ace-web's forker
 *     writes (spark-facilitator/20260926-1800: `forked_from: 20260925-1536`,
 *     `forked_from_phase: synthetic-data-and-workflows`);
 *   - `lineage.forked_from` — the run-record contract (`lib/run-record.ts`).
 *
 * `supersedes` is deliberately NOT followed. A superseded run is a different
 * build of the opp; its frames show a different app (20260925-1536 supersedes
 * 20260910-1624, and the two Learn apps do not share a module list).
 */
export function forkParentRunId(runState: unknown): string | null {
  if (!runState || typeof runState !== 'object') return null;
  const rs = runState as Record<string, unknown>;
  const top = rs.forked_from;
  if (typeof top === 'string' && top.trim()) return top.trim();
  const lineage = rs.lineage as Record<string, unknown> | undefined;
  const nested = lineage?.forked_from;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  return null;
}

/**
 * `[runId, parent, grandparent, …]` along `forked_from`, stopping at a run
 * with no parent, a run whose state cannot be read, a cycle, or `maxDepth`.
 *
 * Why a deck needs it: a fork copies the artifacts of every phase before its
 * fork point but NOT their `screenshots/` subtree (ace-web#758). The capture
 * manifest it inherits therefore names frames that live in the SOURCE run —
 * spark 20260926-1800 has no screenshots folder at all; every one of its 114
 * frames is in 20260925-1536's `6-qa-and-training/screenshots/`. A frame is
 * cited by `file_id`, which survives the copy, so the common case resolves on
 * its own. The walk covers the rest: a fork whose own manifest is missing or
 * lacks a step, and a row that carries only a run-relative `drive_path`,
 * which must be resolved in the run that TOOK it, never the fork.
 */
export async function walkForkLineage(
  runId: string,
  loadRunState: (runId: string) => Promise<unknown | null>,
  maxDepth = 6,
): Promise<string[]> {
  const chain = [runId];
  let cursor = runId;
  for (let i = 0; i < maxDepth; i++) {
    const state = await loadRunState(cursor);
    const parent = forkParentRunId(state);
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    cursor = parent;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// The frame pool
// ---------------------------------------------------------------------------

/** The part of the product a frame (or a slide) is about. */
export type Surface = 'platform' | 'learn' | 'deliver' | 'other';

/** Which part of the product a captured step belongs to, by the recipe's own step names. */
export function frameSurface(step: string): Surface {
  if (/^(journey-learn-|learn-tap-module-|learn-suite-|learn-launch-suite-root)/.test(step)) return 'learn';
  if (/^(journey-deliver-|deliver-form-walk-|deliver-case-select-)/.test(step)) return 'deliver';
  if (/^(connect-|claim-|personal-id|commcare-|learn-install|learn-launch-|deliver-launch-|deliver-sync-)/.test(step)) {
    return 'platform';
  }
  return 'other';
}

export type FramePoolKind = 'opp' | 'common' | 'template' | 'preview';

export interface PoolFrame {
  /** The alias a slide cites it by (`@<alias>`). For captures, the step name. */
  alias: string;
  step: string;
  file_id: string;
  shows?: string;
  duplicate_of?: string;
  kind: FramePoolKind;
  /** Run whose folder holds the frame (differs from the deck's run on a fork). */
  origin_run?: string;
  surface: Surface;
  /** Capture order across the pool — the recipe's order. */
  order: number;
}

export interface PreviewsIndexLike {
  output_key?: string;
  items?: ReadonlyArray<{ file_id?: unknown; name?: unknown; caption?: unknown }>;
}

export interface FrameSource {
  run_id: string;
  manifest?: CaptureManifestLike | null;
  previews?: readonly PreviewsIndexLike[];
}

/**
 * Merge every citable frame. Precedence for a step seen twice: the deck's own
 * run first, then up the fork chain (`sources` in `walkForkLineage` order);
 * a later source only FILLS a field the earlier one lacks (a `file_id`, a
 * `shows`). Shared-pool and template artwork come from the spec's manifest.
 */
export function buildFramePool(args: {
  specManifest?: TrainingDeckSpec['manifest'];
  sources: readonly FrameSource[];
}): PoolFrame[] {
  const byStep = new Map<string, PoolFrame>();
  let order = 0;
  const add = (f: Omit<PoolFrame, 'order' | 'surface'> & { surface?: Surface }) => {
    const prior = byStep.get(f.alias);
    if (prior) {
      if (!prior.file_id && f.file_id) prior.file_id = f.file_id;
      if (!prior.shows && f.shows) prior.shows = f.shows;
      return;
    }
    byStep.set(f.alias, { ...f, surface: f.surface ?? frameSurface(f.step), order: order++ });
  };

  for (const [kind, bucket] of [
    ['template', args.specManifest?.template],
    ['common', args.specManifest?.common],
  ] as const) {
    for (const [alias, value] of Object.entries(bucket ?? {})) {
      const id = extractDriveFileId(value);
      if (!id) continue;
      // The shared pool IS the Connect onboarding flow — that is what it is for.
      add({ alias, step: alias, file_id: id, kind, surface: 'platform' });
    }
  }

  for (const src of args.sources) {
    for (const e of collectCaptureEntries(src.manifest ?? undefined)) {
      add({
        alias: e.step,
        step: e.step,
        file_id: typeof e.file_id === 'string' ? e.file_id : '',
        shows: e.shows,
        duplicate_of: e.duplicate_of,
        kind: 'opp',
        origin_run: src.run_id,
      });
    }
    for (const idx of src.previews ?? []) {
      for (const item of idx.items ?? []) {
        const name = typeof item.name === 'string' ? item.name : '';
        const id = typeof item.file_id === 'string' ? item.file_id : '';
        if (!name || !id) continue;
        // `previewFileName` writes `<NN>-<step>.png` (lib/output-previews.ts).
        const step = name.replace(/\.png$/i, '').replace(/^\d{2,}-/, '');
        add({
          alias: step,
          step,
          file_id: id,
          shows: typeof item.caption === 'string' ? item.caption : undefined,
          kind: 'preview',
          origin_run: src.run_id,
        });
      }
    }
  }

  // Aliases the spec already resolves that no source listed (a hand-added row).
  for (const [alias, value] of Object.entries(args.specManifest?.opp ?? {})) {
    if (byStep.has(alias)) continue;
    const id = extractDriveFileId(value);
    if (id) add({ alias, step: alias, file_id: id, kind: 'opp' });
  }

  return [...byStep.values()].filter((f) => f.file_id);
}

// ---------------------------------------------------------------------------
// Frame assessment
// ---------------------------------------------------------------------------

export type FrameDefect = 'near-empty' | 'keyboard' | 'navigation';

/**
 * Steps that LAND on a list rather than on the content: a module's form list
 * (`learn-tap-module-*`), the list a lesson returns to (`*-finished`), a
 * submit's landing (`*-submitted`), a module or form list.
 *
 * Evidence, both from spark-facilitator/20260925-1536: `journey-learn-m2-
 * register-finished` carries `shows: "Module 'Registering yourself and
 * your...' form list with a single tile ... No lesson content on this frame."`,
 * and the render eval scored that frame on a lesson slide 2/5 ("conveys
 * nothing about registering"). The `m1/m3/m4/m5/m6` `-finished` frames are the
 * same one-tile list (committed fixture
 * `frames/journey-learn-m3-record-finished.png`).
 */
const NAVIGATION_STEP =
  /(^learn-tap-module-|-finished$|-submitted$|-module-list|-form-list|-form-row-|^deliver-form-walk-module-)/;
const NAVIGATION_SHOWS = /\b(form list|module list|single tile|one-row form list|no lesson content)\b/i;
const NEAR_EMPTY_SHOWS = /\b(loading|downloading|blank screen|spinner)\b/i;
const KEYBOARD_SHOWS = /\bkeyboard (is )?(open|up|showing|visible|covers)\b/i;

export function assessFrame(frame: { step: string; shows?: string }, stats?: FrameStats): FrameDefect[] {
  const out: FrameDefect[] = [];
  const shows = frame.shows ?? '';
  if ((stats && stats.inkRowFraction < NEAR_EMPTY_INK) || NEAR_EMPTY_SHOWS.test(shows)) out.push('near-empty');
  if ((stats && stats.keyboardFraction >= KEYBOARD_COVERS) || KEYBOARD_SHOWS.test(shows)) out.push('keyboard');
  if (NAVIGATION_STEP.test(frame.step) || NAVIGATION_SHOWS.test(shows)) out.push('navigation');
  return out;
}

// ---------------------------------------------------------------------------
// What a slide is about
// ---------------------------------------------------------------------------

/**
 * Which part of the product each slide teaches, from the template's own
 * structure: `platform-setup` is the Connect onboarding module, and inside
 * `your-opportunity` the four pillar dividers (`Learn` / `Deliver` / `Verify`
 * / `Pay`, required by `training-deck-generate` step 11) open each section.
 */
export function slideSections(spec: Pick<TrainingDeckSpec, 'modules'>): Map<SlideSpec_v2, Surface> {
  const out = new Map<SlideSpec_v2, Surface>();
  for (const mod of spec.modules) {
    let section: Surface = mod.id === 'platform-setup' ? 'platform' : 'other';
    for (const slide of mod.slides) {
      if (mod.id === 'your-opportunity' && slide.layout === 'section') {
        const t = slide.title.trim().toLowerCase();
        section = t === 'learn' ? 'learn' : t === 'deliver' ? 'deliver' : 'other';
      }
      out.set(slide, section);
    }
  }
  return out;
}

/**
 * Learn module labels in APP order, read off the capture recipe's own step
 * names (`learn-tap-module-{before,after,intermediate}-<label>`). The k-th
 * label owns the `journey-learn-m<k>-*` frames. Pass `explicit` (the Learn app
 * summary's list) when you have it; it wins.
 */
export function learnModuleLabels(pool: readonly PoolFrame[], explicit?: readonly string[]): string[] {
  if (explicit?.length) return [...explicit];
  const out: string[] = [];
  for (const f of [...pool].sort((a, b) => a.order - b.order)) {
    const m = /^learn-tap-module-(?:before|after|intermediate)-(.+)$/.exec(f.step);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Words that promise the reader a SCREEN. */
const PROMISE = /\b(you (?:will |can )?see|screen|tap|appears?|shows? you|opens?)\b/i;

export type ScreenPromise = 'learn-module' | 'step' | 'promise';

/**
 * Does this slide promise the trainee a screen? Only slides in a product
 * section (platform / learn / deliver) are asked; exercises, verify and pay
 * slides teach rules, not screens.
 */
export function screenPromise(
  slide: SlideSpec_v2,
  section: Surface,
  labels: readonly string[],
): ScreenPromise | null {
  if (section === 'other') return null;
  if (section === 'learn' && labels.some((l) => norm(l) === norm(slide.title))) return 'learn-module';
  if (/^step\s*\d/i.test(slide.title.trim())) return 'step';
  const text = slideText(slide);
  if (PROMISE.test(text)) return 'promise';
  return null;
}

function slideText(slide: SlideSpec_v2): string {
  const s = slide as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ['body', 'caption']) if (typeof s[k] === 'string') parts.push(s[k] as string);
  if (Array.isArray(s.callouts)) parts.push((s.callouts as string[]).join(' '));
  if (Array.isArray(s.steps)) for (const st of s.steps as Array<{ caption?: string }>) parts.push(st.caption ?? '');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Topic matching
// ---------------------------------------------------------------------------

const STOP = new Set(
  (
    'the and for you your then when with this that from are its tap see screen app apps commcare connect ' +
    'phone open opens step steps after before last item first each whenever once will can into onto what ' +
    'which have has had been there their they them was were not but all any our out about form forms ' +
    'question module journey page button shows show list may also only more one two three'
  ).split(' '),
);

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw)) continue;
    const w = raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (!STOP.has(w) && !STOP.has(raw)) out.add(w);
  }
  return out;
}

/** The words that carry a slide's promise: its title plus the promising sentences (all of them for a "Step N" slide). */
function promiseTokens(slide: SlideSpec_v2, kind: ScreenPromise | null): Set<string> {
  const text = slideText(slide);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const chosen = kind === 'promise' ? sentences.filter((s) => PROMISE.test(s)) : sentences;
  return tokens(`${slide.title} ${chosen.join(' ')}`);
}

/**
 * How well a frame matches a slide's words. A hit on the STEP name counts
 * double: the step is what the recipe set out to capture, while `shows:` also
 * lists whatever else happens to be on screen (spark's `deliver-launch-
 * download-gate` mentions "after Learn" — it is not a Learn screen).
 */
function stepHits(want: ReadonlySet<string>, f: PoolFrame): number {
  const step = tokens(f.step.replace(/[-_:]+/g, ' '));
  let n = 0;
  for (const w of want) if (step.has(w)) n++;
  return n;
}

function topicScore(want: ReadonlySet<string>, f: PoolFrame): number {
  const step = tokens(f.step.replace(/[-_:]+/g, ' '));
  const shows = tokens(f.shows ?? '');
  let score = 0;
  for (const w of want) score += step.has(w) ? 2 : shows.has(w) ? 1 : 0;
  return score;
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

export interface BindOptions {
  pool: readonly PoolFrame[];
  /** Pixel stats by Drive file id (`measureFrame`). A frame without stats is judged on its step name and `shows`. */
  stats?: ReadonlyMap<string, FrameStats>;
  /** Learn app module labels in app order (else derived from the pool). */
  learnModuleLabels?: readonly string[];
  /** Steps a human opened and rejected for the slide that cited them (re-run input). */
  reject?: ReadonlySet<string>;
}

export type BindAction =
  | { kind: 'kept'; slide: string; alias: string; weak?: FrameDefect[] }
  | { kind: 'bound'; slide: string; alias: string; score: number }
  | { kind: 'replaced'; slide: string; from: string; to: string; because: FrameDefect[] | ['rejected'] }
  | { kind: 'merged-into-notes'; slide: string; into: string }
  | { kind: 'merged-learn-sections'; slides: string[]; into: string; image?: string }
  | { kind: 'expanded-mobile-flow'; slide: string; into: string[] };

export interface BindReport {
  actions: BindAction[];
  /**
   * Newly placed frames nobody has described. `verify_caption_backing` fails a
   * cited opp frame without `shows:` — open each, record what it shows in the
   * capture manifest (app-screenshot-capture § Step 5.6), and if it does NOT
   * show what its slide says, re-run with that step in `reject`.
   */
  needs_shows: string[];
}

function poolIndex(pool: readonly PoolFrame[]) {
  const byAlias = new Map<string, PoolFrame>();
  const byId = new Map<string, PoolFrame>();
  for (const f of pool) {
    byAlias.set(f.alias, f);
    if (!byId.has(f.file_id)) byId.set(f.file_id, f);
  }
  return { byAlias, byId };
}

/** The pool frame a slide's image ref names (`@alias`, `drive:<id>`, a Drive URL). */
function frameForRef(ref: string, spec: TrainingDeckSpec, idx: ReturnType<typeof poolIndex>): PoolFrame | undefined {
  if (ref.startsWith('@')) {
    const alias = ref.slice(1);
    const hit = idx.byAlias.get(alias);
    if (hit) return hit;
    const value = spec.manifest.opp?.[alias] ?? spec.manifest.common?.[alias] ?? spec.manifest.template?.[alias];
    const id = value ? extractDriveFileId(value) : null;
    return id ? idx.byId.get(id) : undefined;
  }
  const id = extractDriveFileId(ref);
  return id ? idx.byId.get(id) : undefined;
}

/**
 * Bind real frames to every screen slide, drop or merge what cannot be bound,
 * and expand `mobile_flow` into legible single-phone slides.
 *
 * Pure: the input spec is not mutated; the returned one is a deep copy.
 * Deterministic: the same spec + pool + stats always yields the same deck —
 * ties break on capture order, never on map iteration.
 */
export function bindDeckFrames(input: TrainingDeckSpec, opts: BindOptions): { spec: TrainingDeckSpec; report: BindReport } {
  const spec: TrainingDeckSpec = JSON.parse(JSON.stringify(input));
  const actions: BindAction[] = [];
  const needsShows = new Set<string>();
  const idx = poolIndex(opts.pool);
  const labels = learnModuleLabels(opts.pool, opts.learnModuleLabels);
  const reject = opts.reject ?? new Set<string>();
  const defectsOf = (f: PoolFrame) => assessFrame(f, opts.stats?.get(f.file_id));

  // ---- 1. legibility: one phone per slide --------------------------------
  for (const mod of spec.modules) {
    const out: SlideSpec_v2[] = [];
    for (const slide of mod.slides) {
      if (slide.layout !== 'mobile_flow') {
        out.push(slide);
        continue;
      }
      const n = slide.steps.length;
      const ids: string[] = [];
      slide.steps.forEach((st, i) => {
        const suffix = ` (${i + 1}/${n})`;
        const title =
          slide.title.length + suffix.length <= FORMATTING_BUDGETS.titleChars
            ? slide.title + suffix
            : slide.title.slice(0, FORMATTING_BUDGETS.titleChars - suffix.length).trimEnd() + suffix;
        const id = `${slide.id}-${i + 1}`;
        ids.push(id);
        out.push({
          id,
          layout: 'walkthrough',
          title,
          image: st.image,
          body: st.caption,
          ...(i === 0 && slide.notes ? { notes: slide.notes } : {}),
        });
      });
      actions.push({ kind: 'expanded-mobile-flow', slide: slide.id, into: ids });
    }
    mod.slides = out;
  }

  // ---- 2. what is already cited ------------------------------------------
  const cited = new Set<string>();
  for (const mod of spec.modules) {
    for (const slide of mod.slides) {
      for (const ref of refsOf(slide)) {
        const f = frameForRef(ref, spec, idx);
        if (f) cited.add(f.file_id);
      }
    }
  }

  const sections = slideSections(spec);

  /** Is `f` an acceptable frame for a slide of this kind? */
  const usable = (f: PoolFrame, kind: ScreenPromise | null): boolean => {
    if (f.duplicate_of || reject.has(f.step)) return false;
    const d = defectsOf(f);
    if (d.includes('near-empty')) return false;
    if (d.includes('navigation') && kind === 'learn-module') return false;
    return true;
  };

  /** Best unused frame for a slide, or undefined. */
  const choose = (slide: SlideSpec_v2, section: Surface, kind: ScreenPromise | null): { f: PoolFrame; score: number } | undefined => {
    if (kind === 'learn-module') {
      const k = labels.findIndex((l) => norm(l) === norm(slide.title));
      if (k < 0) return undefined;
      const label = labels[k];
      const mine = opts.pool
        .filter((f) => f.surface === 'learn')
        .filter((f) => f.step.startsWith(`journey-learn-m${k}-`) || f.step.endsWith(label))
        .filter((f) => !cited.has(f.file_id) && usable(f, kind));
      mine.sort(rank(defectsOf));
      return mine[0] ? { f: mine[0], score: 1 } : undefined;
    }
    const want = promiseTokens(slide, kind);
    if (want.size === 0) return undefined;
    const scored = opts.pool
      .filter((f) => f.surface === section && !cited.has(f.file_id) && usable(f, kind))
      // At least one word must hit the STEP name. A `shows:` line alone is
      // not enough: it describes everything on screen, and on spark
      // "Complete Your Profile" matched the Deliver details card through its
      // "155 Days to complete".
      .filter((f) => stepHits(want, f) > 0)
      .map((f) => ({ f, hits: stepHits(want, f), score: topicScore(want, f) }));
    // The step name outranks the shows line: "Installing the Learn App ...
    // appear on your screen as tiles" is `learn-launch-home-tiles` (two step
    // words), not `deliver-launch-download-gate` (one step word, "download",
    // plus "after Learn" in its shows).
    scored.sort((a, b) => b.hits - a.hits || b.score - a.score || rank(defectsOf, section)(a.f, b.f));
    return scored[0];
  };

  const bindTo = (f: PoolFrame) => {
    cited.add(f.file_id);
    if (f.kind === 'opp' || f.kind === 'preview') {
      spec.manifest.opp = spec.manifest.opp ?? {};
      if (!spec.manifest.opp[f.alias]) {
        spec.manifest.opp[f.alias] = `https://drive.google.com/uc?export=view&id=${f.file_id}`;
      }
      if (!f.shows?.trim()) needsShows.add(f.step);
    }
    return `@${f.alias}`;
  };

  // ---- 3. bind / replace, slide by slide ---------------------------------
  const frameless = new Set<SlideSpec_v2>();
  const kinds = new Map<SlideSpec_v2, ScreenPromise | null>();
  for (const mod of spec.modules) {
    mod.slides = mod.slides.map((slide) => {
      const section = sections.get(slide) ?? 'other';
      const kind = screenPromise(slide, section, labels);
      kinds.set(slide, kind);

      if (slide.layout === 'walkthrough' || slide.layout === 'mobile_zoom' || slide.layout === 'web_screen') {
        const current = frameForRef(slide.image, spec, idx);
        if (!current) return slide; // not ours to judge (an external URL / unknown alias — the resolver halts on those)
        const d = defectsOf(current);
        const bad = !usable(current, kind);
        if (!bad && !d.includes('keyboard')) {
          actions.push({ kind: 'kept', slide: slide.id, alias: current.alias });
          return slide;
        }
        cited.delete(current.file_id);
        // Replacing: match on the WHOLE slide, not just its promising sentence.
        const asked: ScreenPromise = kind ?? 'step';
        const alt = choose(slide, section, asked);
        // A merely WEAK frame (keyboard up) is only swapped for one that
        // matches the slide at least as well and has no keyboard itself —
        // a clean picture of the wrong screen is worse than a crowded picture
        // of the right one.
        const asGood =
          alt &&
          !defectsOf(alt.f).includes('keyboard') &&
          (asked === 'learn-module' || alt.score >= topicScore(promiseTokens(slide, asked), current));
        if (alt && (bad || asGood)) {
          const ref = bindTo(alt.f);
          actions.push({
            kind: 'replaced', slide: slide.id, from: current.alias, to: alt.f.alias,
            because: reject.has(current.step) ? ['rejected'] : d,
          });
          return { ...slide, image: ref } as SlideSpec_v2;
        }
        if (!bad) {
          cited.add(current.file_id);
          actions.push({ kind: 'kept', slide: slide.id, alias: current.alias, weak: d });
          return slide;
        }
        // No usable frame: it is a screen slide with no screen.
        const asContent = toContent(slide);
        kinds.set(asContent, kind ?? 'promise');
        frameless.add(asContent);
        return asContent;
      }

      if (slide.layout === 'content' && kind) {
        const pick = choose(slide, section, kind);
        if (pick) {
          const ref = bindTo(pick.f);
          actions.push({ kind: 'bound', slide: slide.id, alias: pick.f.alias, score: pick.score });
          const bound: SlideSpec_v2 = {
            id: slide.id, layout: 'walkthrough', title: slide.title, image: ref, body: slide.body,
            ...(slide.notes ? { notes: slide.notes } : {}),
          };
          kinds.set(bound, kind);
          return bound;
        }
        frameless.add(slide);
      }
      return slide;
    });
  }

  // ---- 4. drop or merge what is left -------------------------------------
  // 4a. Frameless Learn modules -> ONE slide over the Learn home grid.
  for (const mod of spec.modules) {
    const learnless = mod.slides.filter((s) => frameless.has(s) && kinds.get(s) === 'learn-module');
    if (learnless.length === 0) continue;
    const grid = opts.pool
      .filter((f) => /^learn-launch-suite-root$|^learn-suite-reentry-from-module-suite-root$/.test(f.step))
      .find((f) => !cited.has(f.file_id) && usable(f, null));
    const listed = learnless.map((s) => `- ${s.title}`).join('\n');
    const notes = [
      'Cover each of these sections in a sentence:',
      ...learnless.map((s) => `- ${s.title}: ${'body' in s ? (s as { body: string }).body : ''}`),
    ].join('\n');
    const id = 'learn-other-sections';
    const merged: SlideSpec_v2 = grid
      ? {
          id, layout: 'walkthrough', title: 'The Other Learn Sections', image: bindTo(grid),
          body: `Each section is a tile on the Learn home. Do them in this order:\n${listed}`, notes,
        }
      : {
          id, layout: 'content', title: 'The Other Learn Sections',
          body: `Work through these sections in the Learn app, in this order:\n${listed}`, notes,
        };
    const at = mod.slides.indexOf(learnless[0]);
    mod.slides = mod.slides.filter((s) => !learnless.includes(s));
    mod.slides.splice(at, 0, merged);
    actions.push({
      kind: 'merged-learn-sections', slides: learnless.map((s) => s.id), into: id,
      ...(grid ? { image: grid.alias } : {}),
    });
  }

  // 4b. Any other frameless screen slide -> its neighbour's speaker notes.
  for (const mod of spec.modules) {
    for (let i = 0; i < mod.slides.length; i++) {
      const s = mod.slides[i];
      if (!frameless.has(s)) continue;
      const neighbour = mod.slides[i - 1] ?? mod.slides[i + 1];
      if (!neighbour) continue; // a module of one frameless slide: leave it for the gate to name
      const body = 'body' in s ? (s as { body: string }).body : '';
      const carried = `Also cover — ${s.title}: ${body}`.trim();
      neighbour.notes = neighbour.notes ? `${neighbour.notes}\n\n${carried}` : carried;
      if (s.notes) neighbour.notes += `\n${s.notes}`;
      actions.push({ kind: 'merged-into-notes', slide: s.id, into: neighbour.id });
      mod.slides.splice(i, 1);
      i--;
    }
  }

  return { spec, report: { actions, needs_shows: [...needsShows] } };
}

/** Capture order, preferring described frames, then frames free of a keyboard, then platform-pool art in the platform section. */
function rank(defectsOf: (f: PoolFrame) => FrameDefect[], section?: Surface) {
  return (a: PoolFrame, b: PoolFrame): number => {
    const kb = (f: PoolFrame) => (defectsOf(f).includes('keyboard') ? 1 : 0);
    const described = (f: PoolFrame) => (f.shows?.trim() || f.kind === 'common' || f.kind === 'template' ? 0 : 1);
    const pooled = (f: PoolFrame) => (section === 'platform' && f.kind === 'common' ? 0 : 1);
    return kb(a) - kb(b) || described(a) - described(b) || pooled(a) - pooled(b) || a.order - b.order;
  };
}

function refsOf(slide: SlideSpec_v2): string[] {
  switch (slide.layout) {
    case 'walkthrough':
    case 'web_screen':
    case 'mobile_zoom':
      return [slide.image];
    case 'mobile_flow':
      return slide.steps.map((s) => s.image);
    case 'two_column':
      return [slide.left.image, slide.right.image].filter((x): x is string => !!x);
    default:
      return [];
  }
}

function toContent(slide: SlideSpec_v2): SlideSpec_v2 {
  const s = slide as Record<string, unknown>;
  const body =
    typeof s.body === 'string'
      ? (s.body as string)
      : typeof s.caption === 'string'
        ? (s.caption as string)
        : Array.isArray(s.callouts)
          ? (s.callouts as string[]).map((c) => `- ${c}`).join('\n')
          : '';
  return { id: slide.id, layout: 'content', title: slide.title, body, ...(slide.notes ? { notes: slide.notes } : {}) };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface ScreenBackingFinding {
  slide: string;
  reason:
    /** A slide in a product section promises a screen and carries no image. */
    | 'screen-without-frame'
    /** A `mobile_flow` — phones at ~54% of slide height, unreadable projected. */
    | 'phones-too-small'
    /** The image's own pixels / step say it cannot show the slide's screen. */
    | 'unusable-frame';
  detail: string;
}

export interface ScreenBackingReport extends QACheckResult {
  findings: ScreenBackingFinding[];
}

/**
 * The gate `training-deck-generate` runs before writing the spec and
 * `training-deck-render` runs before copying the template. Failing it means
 * "run `bindDeckFrames`", never "ship it": every finding is a slide a trainer
 * would stand in front of with nothing to point at.
 *
 * Without a pool it still sees the two defects visible in the spec alone — a
 * screen promise with no image, and a `mobile_flow`. With `pool` + `stats` it
 * also sees an image whose frame cannot show the screen (a loading screen; a
 * module's form list on a Learn-module slide).
 */
export function checkDeckScreenBacking(
  spec: TrainingDeckSpec,
  opts: { pool?: readonly PoolFrame[]; stats?: ReadonlyMap<string, FrameStats>; learnModuleLabels?: readonly string[] } = {},
): ScreenBackingReport {
  const findings: ScreenBackingFinding[] = [];
  const pool = opts.pool ?? poolFromSpec(spec);
  const idx = poolIndex(pool);
  const labels = learnModuleLabels(pool, opts.learnModuleLabels);
  const sections = slideSections(spec);

  for (const mod of spec.modules) {
    for (const slide of mod.slides) {
      const section = sections.get(slide) ?? 'other';
      const kind = screenPromise(slide, section, labels);
      if (slide.layout === 'mobile_flow') {
        findings.push({
          slide: slide.id, reason: 'phones-too-small',
          detail: `${slide.steps.length} phones side by side render at ~54% of the slide height`,
        });
        continue;
      }
      const refs = refsOf(slide);
      if (kind && refs.length === 0) {
        findings.push({
          slide: slide.id, reason: 'screen-without-frame',
          detail: `"${slide.title}" (${kind}) promises a screen and shows none`,
        });
        continue;
      }
      for (const ref of refs) {
        const f = frameForRef(ref, spec, idx);
        if (!f) continue;
        const d = assessFrame(f, opts.stats?.get(f.file_id));
        if (d.includes('near-empty') || (d.includes('navigation') && kind === 'learn-module')) {
          findings.push({ slide: slide.id, reason: 'unusable-frame', detail: `${f.alias}: ${d.join(', ')}` });
        }
      }
    }
  }

  const pass = findings.length === 0;
  return {
    pass,
    findings,
    detail: pass
      ? 'every screen slide carries a usable frame'
      : `${findings.length} screen slide(s) without a usable frame: ${findings.map((f) => f.slide).join(', ')}`,
    ...(pass
      ? {}
      : {
          auto_fix_hint:
            'Run scripts/bind-deck-frames.ts on the spec (lib/training-deck-frames.ts::bindDeckFrames): it binds a ' +
            'real frame to each screen slide, merges what has none, and expands mobile_flow.',
        }),
  };
}

/** The pool a spec alone can describe: its own manifest rows, with step-name surfaces. */
function poolFromSpec(spec: TrainingDeckSpec): PoolFrame[] {
  return buildFramePool({ specManifest: spec.manifest, sources: [] });
}
