/**
 * The LEGIBILITY tier — can a rendered frame be READ?
 *
 * `demo-data-setup-qa` carries thirteen checks and every one of them is about
 * DATA: bindings, pipelines, extraction, totals, constraints, cohort size. Each
 * asks whether the numbers are right. None asks whether a viewer can read them
 * off the frame the render produces, and that is the gap this module closes.
 *
 * ## Five Phase 7 runs at concept 2.0/5, three narrow rules, one class (ace#2219)
 *
 * - **ace#1841** (2026-08-29) — *"three Phase 7 runs at concept 2.0/5"*. Fixed by
 *   adding a DETECTION verb to `checkSceneCardinality`, keyed on the narrative's
 *   VOCABULARY.
 * - **ace#2131** (2026-09-07) — *"stopped_not_converged at 2.0/5 again"*, from a
 *   detection demo written in plain descriptive prose that matched no token.
 *   Fixed by `checkDetectionCohortFloor`, keyed on a DECLARED field.
 * - **poverty-graduation/20260905-1345** (2026-09-07) — 2.0/5 again, from a
 *   third, unrelated cause. Neither of the two previous fixes could see it,
 *   because it is not about the data at all.
 *
 * Each fix patched the evasion the last one missed. This one is deliberately
 * not keyed on vocabulary — it reads the ARTIFACT: the spec's own scroll
 * actions, and the dashboard's own labels against the dashboard's own
 * definitions.
 *
 * ## What the judges said, on the run that is this module's evidence
 *
 * `verdict-user.yaml` returned `projector_test: false` and
 * `five_second_read_correct: false` on **7 of 7** scenes. The concept judge's
 * headline was *"The narration is strong throughout; the frames under-carry
 * it."* Two mechanisms, both decidable before a frame is recorded.
 *
 * **Framing.** *"Scene 5's capture puts the title, the simulated-data
 * disclosure and all four KPI cards off the top"*, and row twelve — Umar Bello —
 * rendered *"sliced through its middle at the bottom edge with its badge
 * truncated mid-word"*, which *"spoils scene 6 without being readable"*. Scene
 * 4's `bottom` *"guillotines the two modal histogram bars (627 and 487) at the
 * frame's top edge — value labels gone, the two bars rendering at identical
 * heights when they differ by 140 households"*.
 *
 * The spec used `kind: scroll` **five times** — `'400'`, `'1280'`, `'bottom'`,
 * `'320'`, `'top'` — and `scroll_to` once. Three of the five are raw pixel
 * guesses about how a page this spec does not own renders at a viewport it does
 * not control, valid for exactly one row count and one font stack. That is
 * CLAUDE.md's *"close the loop to the source of truth — don't guess at what
 * another system owns"*, and it is why row twelve got sliced.
 *
 * **Jargon.** The `'jargon visible to non-technical users, max 2'` hard cap
 * fired on **six of seven** scenes, on `31-point band`, `10-point band`,
 * `Surveys in the 31-point band`, `Mean likelihood below the line`, and
 * `Payable` / `Non-payable` — *"coined terms defined nowhere on the page"*.
 *
 * The second iteration of that run is the more important measurement. A *"What
 * each column means"* panel was added, the judge recorded it as VERIFIED PRESENT
 * and correct — and the cap fired on six of seven scenes anyway, because *"the
 * panel is BELOW THE FOLD of every frame that uses the vocabulary"*. In the
 * judge's words, *"moving a definition on-screen is not the same as moving it to
 * the point of use"*. So a definition that a reader of the label cannot reach
 * from the label does not clear this check.
 *
 * ## This is NOT the retracted ace#1660 check, and it writes no `offset`
 *
 * `ddd-scene-actions.ts` used to carry a `scroll-under-fixed-header` rule that
 * flagged every `scroll_to` lacking `offset: 96`. It was retracted, and both of
 * its halves were wrong: canopy's `ScrollToAction` declares only `kind` and
 * `target`, `_ActionBase` sets `extra="forbid"`, and an author who followed the
 * remediation converted a passing spec into one canopy REFUSES. **Do not re-add
 * it, and never write an `offset` key on any action.**
 *
 * This module inverts that check rather than restoring it. It says nothing about
 * `scroll_to` — `scroll_to` is the REMEDY here, taken exactly as canopy
 * declares it, with a `target` and nothing else. What it flags is the OTHER
 * action, `kind: scroll`, whose `value` the author had to invent. Today's judge
 * remedy reads *"offset so no partial histogram sits above it"*; followed
 * literally that breaks the spec, which is precisely why the remedy this module
 * emits is pinned by a vocabulary audit in
 * `test/lib/demo-frame-legibility.test.ts`.
 *
 * ## Scope
 *
 * Both checks are pure and take DATA. `checkScrollFraming` reads the spec the
 * narrative already authored. `checkCoinedTerms` takes the dashboard's labels
 * and its definitions as two lists the caller enumerates — this module does not
 * decide which words are jargon, because a keyword list is the evasion that has
 * now failed twice.
 */

import type { QACheckResult } from './qa-types';

/** One action of a canopy scene. `value` is `ScrollAction`'s only own field. */
export interface LegibilityAction {
  kind: string;
  target?: string;
  value?: string | number;
  seconds?: number;
}

export interface LegibilityScene {
  id?: string;
  title?: string;
  actions?: LegibilityAction[];
}

export interface LegibilitySpec {
  scenes?: LegibilityScene[];
}

/**
 * A column or row label as it RENDERS on a dashboard — the caller enumerates
 * these off the render code it is about to upload.
 */
export interface DashboardTerm {
  /** The label verbatim, as a viewer sees it. */
  label: string;
  /** Free text — where it renders (a column header, a KPI card, a row label). */
  surface?: string;
  /**
   * Does it render on a high-prominence surface a frame will show on its own?
   * Defaults to `true`: a label enumerated as coined is assumed load-bearing
   * until the caller says otherwise.
   */
  prominent?: boolean;
}

/** An on-page definition affordance for one term. */
export interface TermDefinition {
  /** The term defined. Matched against a label case- and whitespace-insensitively. */
  term: string;
  /**
   * Can a reader of the LABEL reach this definition from the label — an info
   * affordance on the header, a tooltip, an adjacent gloss? A glossary panel
   * elsewhere on the page is `false`.
   */
  at_point_of_use?: boolean;
  /** Free text — where the definition lives, for the finding detail. */
  where?: string;
}

export type LegibilityFindingKind =
  /** A `kind: scroll` whose `value` is a raw pixel guess, deciding a judged frame. */
  | 'pixel-scroll-framing'
  /** A `kind: scroll` to a page end, deciding a judged frame the page's length frames. */
  | 'unanchored-scroll-framing'
  /** A coined label with no on-page definition at all. */
  | 'undefined-term'
  /** Defined, but not reachable from the label a frame actually shows. */
  | 'definition-not-at-point-of-use'
  /** A definition whose term matches no enumerated label — the glossary drifted. */
  | 'orphan-definition'
  /** Nothing was enumerated, so nothing was judged. */
  | 'no-terms-enumerated'
  /**
   * Every framing action in the spec is a `scroll_to`, which this check does
   * not evaluate — so the pass was earned over nothing.
   */
  | 'scroll-to-framing-unjudged';

export interface LegibilityFinding {
  kind: LegibilityFindingKind;
  /** Scene `id` or `title`, for the framing findings. */
  scene?: string;
  /** The label or definition term, for the coined-term findings. */
  term?: string;
  /** Blocking findings fail the check; reported ones are surfaced, never silent. */
  blocking: boolean;
  detail: string;
}

export interface LegibilityReport extends QACheckResult {
  findings: LegibilityFinding[];
  /**
   * How many things were actually judged — framing-decisive scrolls, or
   * enumerated labels — so a report of zero findings is measured, not assumed.
   */
  judged: number;
}

/** A `value` that is a raw pixel offset rather than a page landmark. */
const PIXEL_VALUE = /^-?\d+(\.\d+)?\s*(px)?$/i;

/** canopy's `ScrollAction.value` default, verbatim from its model. */
const SCROLL_DEFAULT = 'bottom';

/** Verbs that re-frame the page, invalidating an earlier scroll's framing. */
const REFRAMING_KINDS = new Set(['goto', 'scroll', 'scroll_to']);

/** Verbs after which a judged still exists at the current scroll position. */
const FRAME_WRITING_KINDS = new Set(['hold', 'snapshot']);

function sceneName(s: LegibilityScene, i: number): string {
  return s.id ?? s.title ?? `(scene ${i + 1})`;
}

/**
 * Does the frame this scroll produced actually get judged?
 *
 * A scroll matters when a still is written at the position it set. Scan
 * forward: a `hold` or `snapshot` before anything re-frames the page means yes;
 * so does running off the end of the scene, because the scene's END frame is
 * the canonical `scene_<N>.png`. A `goto` or another scroll first means the
 * position was transient and no judge ever sees it.
 */
function framesAJudgedStill(actions: LegibilityAction[], from: number): boolean {
  for (let i = from + 1; i < actions.length; i++) {
    const k = actions[i].kind;
    if (FRAME_WRITING_KINDS.has(k)) return true;
    if (REFRAMING_KINDS.has(k)) return false;
  }
  return true; // ran to the end — the scene's end frame is the judged still.
}

function buildFinishedReport(
  findings: LegibilityFinding[],
  judged: number,
  what: string,
): LegibilityReport {
  const blockers = findings.filter((f) => f.blocking);
  return {
    pass: blockers.length === 0,
    judged,
    findings,
    detail:
      `${judged} ${what} judged; ${blockers.length} blocking, ` +
      `${findings.length - blockers.length} reported`,
    ...(blockers.length > 0
      ? {
          auto_fix_hint: blockers
            .map((f) => `[${f.kind}] ${f.scene ?? f.term ?? ''} — ${f.detail}`)
            .join('\n'),
        }
      : {}),
  };
}

/**
 * Every frame a judge will read is framed by something the page owns.
 *
 * A `kind: scroll` carrying a pixel `value` is a guess about a layout this spec
 * does not own — it holds for exactly one viewport, one row count and one font
 * stack, and nothing tells the author when it stops holding. `scroll_to` names
 * an element and lets the recorder find it, which is the same
 * close-the-loop-to-the-source-of-truth rule the rest of ACE runs on.
 *
 * `top` and `bottom` get the softer treatment, and the reason is that they are
 * not guesses: both name a landmark the page itself defines, and both land in
 * the same place however the page grows. What they cannot do is guarantee that
 * the SUBJECT of the frame is in it — the opposite edge is wherever the page's
 * own length puts it, which is how scene 4's `bottom` guillotined two histogram
 * bars at the top edge while the panel the scene was about sat fully framed
 * below. So they are reported rather than blocking. Reported is not tolerated:
 * a landmark scroll is right only when the frame's subject IS the page's first
 * or last content, and the author is the one who can say whether it is.
 */
export function checkScrollFraming(spec: LegibilitySpec | undefined): LegibilityReport {
  const findings: LegibilityFinding[] = [];
  let judged = 0;
  /**
   * How many `scroll_to` actions frame a judged still. Counted so a pass with
   * `judged` at zero can say what it DECLINED to look at rather than reading as
   * an approval — see the finding emitted at the end of this function.
   */
  let scrollToFrames = 0;

  const scenes = spec?.scenes ?? [];
  for (let si = 0; si < scenes.length; si++) {
    const scene = scenes[si];
    const name = sceneName(scene, si);
    const actions = scene.actions ?? [];

    for (let ai = 0; ai < actions.length; ai++) {
      const a = actions[ai];
      if (a.kind === 'scroll_to' && framesAJudgedStill(actions, ai)) scrollToFrames++;
      if (a.kind !== 'scroll') continue;
      if (!framesAJudgedStill(actions, ai)) continue;

      judged++;
      const raw = a.value === undefined || a.value === null ? SCROLL_DEFAULT : String(a.value);
      const value = raw.trim();

      if (PIXEL_VALUE.test(value)) {
        findings.push({
          kind: 'pixel-scroll-framing',
          scene: name,
          blocking: true,
          detail:
            `this scene frames a judged still with a raw pixel scroll of ${value}, then holds ` +
            `there. A hard-coded pixel position is a guess about how a page this spec does not own ` +
            `renders — ` +
            `it is correct for one viewport, one row count and one font stack, and nothing ` +
            `reports when it stops being correct. On poverty-graduation/20260905-1345 the same ` +
            `move landed a twelve-row table one row short, slicing row twelve (Umar Bello) ` +
            `through its middle at the bottom edge with its badge truncated mid-word, and pushed ` +
            `the title, the disclosure and all four KPI cards off the top. Seven of seven scenes ` +
            `came back with a failed projector test and a wrong five-second read, and the run ` +
            `ended at concept 2.0 of 5. Replace it with a scroll_to action naming the element ` +
            `this frame is about — canopy resolves it live and centres it, so it holds at any ` +
            `page length. Write only kind and target on that action — canopy forbids extra keys on ` +
            `an action, so inventing a framing key makes the spec fail validation, which is what ` +
            `the retracted ace#1660 check told authors to do. If the header block and the whole ` +
            `table cannot co-exist in one ` +
            `frame, split the beat into two scenes rather than compromising both`,
        });
        continue;
      }

      if (value.toLowerCase() === 'top' || value.toLowerCase() === 'bottom') {
        findings.push({
          kind: 'unanchored-scroll-framing',
          scene: name,
          blocking: false,
          detail:
            `this scene frames a judged still by scrolling to the page's ${value.toLowerCase()}. ` +
            `That is a landmark the page defines rather than a pixel guess, so it survives a ` +
            `layout change — but it only decides ONE edge of the frame, and the page's own ` +
            `length decides the other. On poverty-graduation/20260905-1345 scene 4's scroll to ` +
            `the page bottom guillotined the two modal histogram bars at the top edge, dropping ` +
            `their value labels and rendering bars that differ by 140 households at identical ` +
            `heights, while the panel the scene was actually about sat fully framed below. ` +
            `Reported rather than blocking because it is right whenever the subject of this ` +
            `frame IS the page's first or last content. Confirm that it is, or name the subject ` +
            `with a scroll_to action instead`,
        });
        continue;
      }

      findings.push({
        kind: 'unanchored-scroll-framing',
        scene: name,
        blocking: false,
        detail:
          `this scene frames a judged still with a scroll value of "${value}", which is neither ` +
          `a page landmark nor a pixel position. canopy reads the value of a scroll action as ` +
          `top, bottom, or a pixel position, so confirm what this resolves to — or name the ` +
          `element the frame is about with a scroll_to action, which cannot be ambiguous`,
      });
    }
  }

  if (judged === 0 && scrollToFrames > 0) {
    findings.push({
      kind: 'scroll-to-framing-unjudged',
      blocking: false,
      detail:
        `this check judged NOTHING. It reads pixel scrolls only, and all ${scrollToFrames} ` +
        `framing-decisive action(s) in this spec are scroll_to, which it skips — so the pass ` +
        `above records the ABSENCE of a pixel guess, not an approval of how these frames are ` +
        `composed. Read it that way. On spark-facilitator/20260907-1120 it was read as a ` +
        `verdict — the spec of record framed all five of its stills with scroll_to, ` +
        `this check returned a pass having evaluated zero actions, and it was reported as ` +
        `"check 14 passed". Three of those five scroll_to actions had silently failed to move ` +
        `the page — scroll_to CENTRES its target, and a centred position outside the page's ` +
        `own scroll range is clamped back to where the camera already was, so the recorder ` +
        `filmed the previous frame and canopy failed the run on duplicate frames. The render ` +
        `replaced them with pixel scrolls; once the spec of record was reconciled to what was ` +
        `actually rendered, this same check returned two blocking findings. Nothing here says ` +
        `scroll_to is wrong — it is this module's remedy, and it holds at any page length ` +
        `whenever the centred position is reachable. What is wrong is treating a pass with ` +
        `nothing in scope as evidence that the framing was looked at. ace#2253`,
    });
  }

  return buildFinishedReport(findings, judged, 'framing-decisive scroll(s)');
}

function normalizeTerm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '');
}

/**
 * Every coined label a frame shows carries an on-page definition a reader of
 * that label can reach.
 *
 * Both lists are DATA the caller enumerates — the labels off the render code it
 * is about to upload, the definitions off the same code. This function does not
 * decide which words are jargon: a keyword list is exactly the shape that
 * ace#1841 pruned for precision and that ace#2131 then evaded, and a rule keyed
 * on vocabulary has now failed twice.
 *
 * The `at_point_of_use` distinction is the finding that cost a whole iteration.
 * A glossary panel is a real improvement and it did not clear the cap: the
 * judge recorded the panel as present and correct and still scored six of seven
 * scenes at the jargon floor, because a frame showing the hero row does not show
 * the panel. A definition is only reachable if it is reachable from the label.
 */
export function checkCoinedTerms(
  dashboardTerms: DashboardTerm[] | undefined,
  definedTerms: TermDefinition[] | undefined,
): LegibilityReport {
  const findings: LegibilityFinding[] = [];
  const terms = dashboardTerms ?? [];
  const definitions = definedTerms ?? [];

  if (terms.length === 0) {
    findings.push({
      kind: 'no-terms-enumerated',
      blocking: false,
      detail:
        `no dashboard labels were enumerated, so nothing was judged. This check cannot tell a ` +
        `dashboard written in plain programme language from one whose coined labels were never ` +
        `written down, and only one of those is a pass. Enumerate the column and row labels a ` +
        `lay viewer meets on this dashboard, even when the answer is that none of them are ` +
        `coined — a recorded empty list is evidence and an omitted one is not`,
    });
    return buildFinishedReport(findings, 0, 'dashboard label(s)');
  }

  const byTerm = new Map<string, TermDefinition>();
  for (const d of definitions) {
    if (typeof d?.term === 'string') byTerm.set(normalizeTerm(d.term), d);
  }

  const matched = new Set<string>();

  for (const t of terms) {
    const key = normalizeTerm(t.label ?? '');
    const def = byTerm.get(key);
    const prominent = t.prominent !== false;
    const where = t.surface ? ` (${t.surface})` : '';

    if (!def) {
      findings.push({
        kind: 'undefined-term',
        term: t.label,
        blocking: true,
        detail:
          `the label "${t.label}"${where} renders with no definition anywhere on the page. A ` +
          `coined column or row label is a term the programme invented, and a viewer meeting it ` +
          `for the first time on a projector has no way to resolve it — the judges' jargon cap ` +
          `fired on six of seven scenes of poverty-graduation/20260905-1345 on exactly this ` +
          `list, including 31-point band and Mean likelihood below the line, described as ` +
          `"coined terms defined nowhere on the page". Add a definition affordance the reader ` +
          `OPENS from the label itself — an info control on the header carrying the one-line ` +
          `plain read. Renaming the label so it needs no gloss is the better fix where it is ` +
          `available, and deletes the definition rather than adding one`,
      });
      continue;
    }

    matched.add(key);

    if (def.at_point_of_use !== true) {
      const panel = def.where ? ` in ${def.where}` : ' elsewhere on the page';
      findings.push({
        kind: 'definition-not-at-point-of-use',
        term: t.label,
        blocking: prominent,
        detail:
          `the label "${t.label}"${where} is defined${panel}, which a reader of the label ` +
          `cannot reach from the label. This is the measurement that cost an iteration on ` +
          `poverty-graduation/20260905-1345 — its definitions panel was added, judged VERIFIED ` +
          `PRESENT and correct, and the jargon cap fired on six of seven scenes anyway, because ` +
          `the panel sits below the fold of every frame that uses the vocabulary. In the judge's ` +
          `own words, moving a definition on-screen is not the same as moving it to the point of ` +
          `use. Put the gloss on the label — an info control on the column header, a tooltip, or ` +
          `an adjacent plain-language lead line with the statistics demoted behind it` +
          (prominent
            ? ''
            : `. Reported rather than blocking here because this label was enumerated as not ` +
              `rendering on a hero surface, so a frame showing it plausibly shows the panel too ` +
              `— confirm that it does`),
      });
    }
  }

  for (const d of definitions) {
    const key = normalizeTerm(d?.term ?? '');
    if (!key || matched.has(key)) continue;
    findings.push({
      kind: 'orphan-definition',
      term: d.term,
      blocking: false,
      detail:
        `the page defines "${d.term}", which matches no enumerated label. Either the render ` +
        `dropped that label and the definition is now dead weight competing for the reader's ` +
        `attention, or the label is still there and the enumeration missed it — in which case ` +
        `this check judged fewer labels than the dashboard shows. Reconcile the two lists`,
    });
  }

  return buildFinishedReport(findings, terms.length, 'dashboard label(s)');
}
