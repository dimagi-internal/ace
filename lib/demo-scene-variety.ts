/**
 * The SEQUENCE tier — does the deck show more than one thing?
 *
 * Every other check in this family judges ONE artifact: a record, a row, a
 * frame, a label. The arc judge is the only lens in the DDD loop that sees the
 * scenes as a sequence, and it is where two of ACE's Phase 7 runs have died —
 * not on anything wrong in a frame, but on seven frames of the same table.
 *
 * ## The run that is this module's evidence (spark-facilitator/20260907-1120)
 *
 * `verdict-arc.yaml` came back 2 of 5, `fail`, on two dimensions that were both
 * capped by DETERMINISTIC deduction rules — rules decidable from the spec before
 * a single frame is recorded:
 *
 * - **`visual_variety` capped at 2** — *"more than half the scenes are the same
 *   surface at different scroll offsets"*. 4 of 7 scenes were the payment-ledger
 *   page at four offsets. In the judge's words, *"the run contains exactly two
 *   shapes across seven frames"*.
 * - **`escalation` capped at 2** — *"two scenes showing the same surface with
 *   only a scroll between them", applied literally: scenes 1->2, 2->3 and 3->4
 *   are each the same ledger surface separated by ~174px of scroll*. Of scene 2
 *   it said: *"the payment-test panel it narrates is already fully readable in
 *   scene 1's frame, so it adds voiceover, not a new thing to look at"*.
 *
 * The spec that produced it:
 *
 *     1  what-the-pilot-pays-for        ${payment_integrity_par_url}  wait_for, hold
 *     2  the-test-a-record-has-to-pass  (inherits)                    scroll, hold
 *     3  three-below-the-target         (inherits)                    scroll, hold
 *     4  the-column-that-changes-nothing(inherits)                    scroll_to, hold
 *     5  the-week-in-front-of-a-...     ${weekly_review_par_url}      wait_for, hold, ...
 *     6  narrow-the-week-to-the-three   (inherits)                    click, wait_for, hold
 *     7  the-decision-the-...           (inherits)                    click, wait_for, ...
 *
 * Both caps are readable off that table. Nothing had to be rendered, judged, or
 * watched to know this deck would be marked down — and the loop cannot fix it
 * afterwards, because collapsing scenes is a narrative change behind the
 * `concept_change` gate. So it stopped, unattended, at 2.0.
 *
 * ## Why this is a BLOCKING authoring check
 *
 * The usual argument for reporting rather than failing is that the author knows
 * something the check does not. That argument does not apply here: the arc judge
 * applies these two rules literally and caps the whole run at 2 when they fire.
 * A finding this module reports at authoring time costs one edit; the same
 * finding discovered by the judge costs a full render, a judging pass, and — as
 * on this run — the phase, because the remedy is gated behind a human.
 *
 * A scene that shows the viewer something the previous frame already contained
 * is voiceover with a picture attached. That is the defect, and both rules are
 * ways of saying it.
 */

import type { QACheckResult } from './qa-types';

export interface VarietyAction {
  kind: string;
  target?: string;
  value?: string | number;
}

export interface VarietyScene {
  id?: string;
  title?: string;
  /** Absent means the scene stays on the previous scene's surface. */
  url?: string;
  actions?: VarietyAction[];
}

export interface VarietySpec {
  scenes?: VarietyScene[];
}

export type VarietyFindingKind =
  /** More than half the scenes are one surface. */
  | 'surface-monopoly'
  /** A scene adds narration over a surface the previous frame already showed. */
  | 'scroll-only-transition';

export interface VarietyFinding {
  kind: VarietyFindingKind;
  scene?: string;
  blocking: boolean;
  detail: string;
}

export interface VarietyReport extends QACheckResult {
  findings: VarietyFinding[];
  /** Scenes actually examined, so a clean report is measured. */
  judged: number;
  /** Distinct surfaces the deck visits. */
  surfaces: number;
}

/**
 * Verbs that put something NEW on screen — a state change the previous frame
 * could not have contained. Scrolling is deliberately not one of them: it
 * re-frames what was already rendered.
 */
const STATE_CHANGING_KINDS = new Set([
  'click',
  'type',
  'fill',
  'select',
  'hover',
  'press',
  'check',
  'uncheck',
  'upload',
  'drag',
  'goto',
]);

function sceneName(s: VarietyScene, i: number): string {
  return s.id ?? s.title ?? `(scene ${i + 1})`;
}

/** Resolve each scene's surface, carrying the last declared url forward. */
function resolveSurfaces(scenes: VarietyScene[]): string[] {
  const out: string[] = [];
  let current = '';
  for (const s of scenes) {
    if (typeof s.url === 'string' && s.url.trim().length > 0) current = s.url.trim();
    out.push(current);
  }
  return out;
}

/**
 * Judge the deck as a sequence.
 *
 * Takes the authored spec and nothing else — no render, no screenshots. Both
 * rules mirror the arc judge's own deduction rules verbatim, so a pass here is
 * a prediction the judge will not cap these two dimensions.
 */
export function checkSceneVariety(spec: VarietySpec | undefined): VarietyReport {
  const findings: VarietyFinding[] = [];
  const scenes = spec?.scenes ?? [];

  if (scenes.length === 0) {
    return finish(findings, 0, 0);
  }

  const surfaces = resolveSurfaces(scenes);
  const distinct = new Set(surfaces.filter((s) => s.length > 0));

  // Rule 1 — "more than half the scenes are the same surface".
  const counts = new Map<string, number>();
  for (const s of surfaces) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [surface, n] of counts) {
    if (surface.length === 0) continue;
    if (n * 2 > scenes.length) {
      const names = scenes.filter((_, i) => surfaces[i] === surface).map((s, i) => sceneName(s, i));
      findings.push({
        kind: 'surface-monopoly',
        blocking: true,
        detail:
          `${n} of ${scenes.length} scenes are one surface, ${surface} — ${names.join(', ')}. ` +
          `The arc judge caps visual_variety at 2 on exactly this, worded "more than half the ` +
          `scenes are the same surface at different scroll offsets", and one capped dimension ` +
          `holds the whole run at its floor. On spark-facilitator/20260907-1120 four of seven ` +
          `scenes were the payment ledger at four offsets and the judge's summary was that the ` +
          `run "contains exactly two shapes across seven frames". Give this deck another thing ` +
          `to look at, or merge the beats that share a surface into fewer, denser scenes. ` +
          `Splitting one page across four scenes buys narration, not pictures`,
      });
    }
  }

  // Rule 2 — "two scenes showing the same surface with only a scroll between them".
  for (let i = 1; i < scenes.length; i++) {
    if (surfaces[i] !== surfaces[i - 1]) continue;
    const actions = scenes[i].actions ?? [];
    if (actions.some((a) => STATE_CHANGING_KINDS.has(a.kind))) continue;

    findings.push({
      kind: 'scroll-only-transition',
      scene: sceneName(scenes[i], i),
      blocking: true,
      detail:
        `follows ${sceneName(scenes[i - 1], i - 1)} on the same surface and changes nothing on ` +
        `the page — its actions are ${actions.map((a) => a.kind).join(', ') || '(none)'}, which ` +
        `re-frame what was already rendered rather than putting something new on screen. The ` +
        `arc judge caps escalation at 2 on this, and of the equivalent scene on ` +
        `spark-facilitator/20260907-1120 it wrote that the panel it narrates "is already fully ` +
        `readable in scene 1's frame, so it adds voiceover, not a new thing to look at". Either ` +
        `fold this beat into the scene before it, or give the scene an action that changes what ` +
        `the page shows — a filter, a selection, a drill-in`,
    });
  }

  return finish(findings, scenes.length, distinct.size);
}

function finish(findings: VarietyFinding[], judged: number, surfaces: number): VarietyReport {
  const blockers = findings.filter((f) => f.blocking);
  return {
    pass: blockers.length === 0,
    judged,
    surfaces,
    findings,
    detail:
      `${judged} scene(s) over ${surfaces} surface(s) judged; ${blockers.length} blocking, ` +
      `${findings.length - blockers.length} reported`,
    ...(blockers.length > 0
      ? {
          auto_fix_hint: blockers
            .map((f) => `[${f.kind}] ${f.scene ?? ''} — ${f.detail}`)
            .join('\n'),
        }
      : {}),
  };
}
