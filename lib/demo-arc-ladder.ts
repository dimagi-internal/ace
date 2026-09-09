/**
 * The FINALE tier — does the deck end on its strongest beat?
 *
 * `demo-scene-variety` asks whether the deck shows more than one thing.
 * This asks the next question down the same axis: of the things it shows,
 * is the LAST one the payoff?
 *
 * ## Why this is a check and not a note
 *
 * `ddd-arc-eval`'s `arc_shape` carries a **hard cap at 3** when the final
 * scene is not the run's strongest moment. `arc_shape` is weighted .30 and
 * every judge's overall is the MINIMUM across its dimensions, so a deck that
 * ends on a weak beat cannot reach the 4.0 convergence bar no matter what the
 * other four dimensions do. It is a ceiling, not a deduction — and it is
 * decidable from the spec before a frame is recorded.
 *
 * ## The run that is this module's evidence (spark-facilitator/20260909-1211)
 *
 * Six scenes. The peak was scene **4** — a filed meeting record that is
 * complete, correct, and earns nothing, with the cross-record history that
 * decided it. Scene 5 performed the demo's one real state change (a reviewer
 * confirming the record). Scene 6 was prose-only.
 *
 * `verdict-arc.yaml`, verbatim:
 *
 * > the run's strongest moment is scene 4 of 6, and both remaining scenes
 * > decline from it: scene 5 is a smaller claim on a re-used frame that
 * > undercuts itself on screen, and scene 6 is prose-only with no data,
 * > delivering the payoff sentence over the run's emptiest screen. The
 * > finale-strength deduction is a hard cap at 3.
 *
 * `arc_shape` 3, and with `overall_rule: lowest` the run could not converge.
 * The material for a strong finale was already in the deck — it was simply
 * not last. Moving the state-changing beat to the end is a reordering, not
 * new work.
 *
 * ## What this checks, and deliberately what it does not
 *
 * It checks ONE structural fact: **the deck's last scene performs a
 * state-changing action.** That is the artifact-keyed proxy for "ends on the
 * payoff" — a beat where the viewer watches the product DO something is the
 * one kind of finale that cannot be a recap.
 *
 * It does NOT try to judge which scene is "strongest". That is the arc judge's
 * job, it needs rendered frames, and a heuristic for it would be the fourth
 * false-positive rule in this family — `ddd-scene-actions` has already
 * retracted one (ace#1660) and pruned another (ace#1841) for firing on specs
 * that were fine. A deck whose genuine payoff is a read rather than an action
 * records `finale_is_read: true` in its spec and this check stands down,
 * exactly as `detectable_signal: none` stands the detection floor down.
 *
 * Reference: ace#2339.
 */
import type { QACheckResult } from './qa-types';

/**
 * Verbs that put something NEW on screen. Kept identical to
 * `demo-scene-variety`'s `STATE_CHANGING_KINDS` — the two checks must agree on
 * what "the product did something" means, or a deck can satisfy one by
 * violating the other's definition.
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

export interface LadderAction {
  kind: string;
  target?: string;
}

export interface LadderScene {
  id?: string;
  title?: string;
  actions?: LadderAction[];
}

export interface LadderSpec {
  scenes?: LadderScene[];
  /**
   * Declared escape: this deck's payoff is genuinely a read, not an action.
   * Requires a non-empty reason, on the same cite-your-source discipline the
   * `below_programme_scale` escape uses — an unevidenced flag is a silencer.
   */
  finale_is_read?: unknown;
}

export type ArcLadderFindingKind =
  /** The last scene performs no state change — the deck ends on a recap. */
  | 'finale-is-not-the-payoff'
  /** A state-changing beat exists but an inert scene follows it. */
  | 'payoff-followed-by-decline';

export interface ArcLadderFinding {
  kind: ArcLadderFindingKind;
  scene?: string;
  detail: string;
}

export interface ArcLadderReport extends QACheckResult {
  findings: ArcLadderFinding[];
  /** Scenes examined, so a clean report is measured rather than vacuous. */
  judged: number;
  /** 1-based index of the last scene that performs a state change, or null. */
  lastActionSceneIndex: number | null;
}

function finish(
  findings: ArcLadderFinding[],
  judged: number,
  lastActionSceneIndex: number | null,
  detail: string,
): ArcLadderReport {
  return {
    pass: findings.length === 0,
    judged,
    lastActionSceneIndex,
    findings,
    detail,
    ...(findings.length > 0
      ? {
          auto_fix_hint:
            'Move the deck\'s state-changing beat to the LAST scene and fold any trailing ' +
            'commentary into the framing. This is a reorder of material the deck already has.',
        }
      : {}),
  };
}

function isStateChanging(scene: LadderScene | undefined): boolean {
  return (scene?.actions ?? []).some((a) => STATE_CHANGING_KINDS.has(a?.kind));
}

function label(scene: LadderScene | undefined, index: number): string {
  const t = scene?.title?.trim();
  return t && t.length > 0 ? `${index}. ${t}` : `scene ${index}`;
}

function declaredReadFinale(spec: LadderSpec | undefined): boolean {
  const v = spec?.finale_is_read;
  if (typeof v === 'string') return v.trim().length > 0;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const r = (v as Record<string, unknown>).reason;
    return typeof r === 'string' && r.trim().length > 0;
  }
  return false;
}

export function checkArcLadder(spec: LadderSpec | undefined): ArcLadderReport {
  const scenes = spec?.scenes ?? [];
  const findings: ArcLadderFinding[] = [];

  // Nothing to judge. Never a silent pass on an absent deck — say it evaluated
  // nothing, the posture `demo-data-setup-qa` check 14 takes for unjudged frames.
  if (scenes.length === 0) {
    return finish(findings, 0, null, 'no scenes to judge — this check evaluated nothing');
  }

  let lastActionSceneIndex: number | null = null;
  scenes.forEach((s, i) => {
    if (isStateChanging(s)) lastActionSceneIndex = i + 1;
  });

  // A deck whose payoff is genuinely a read declares it and this stands down —
  // but the declaration still has to cost a sentence.
  if (declaredReadFinale(spec)) {
    return finish(
      findings,
      scenes.length,
      lastActionSceneIndex,
      `${scenes.length} scene(s) judged; finale_is_read declared with a reason, so the ` +
        'finale-carries-the-action rule stands down',
    );
  }

  if (lastActionSceneIndex === null) {
    findings.push({
      kind: 'finale-is-not-the-payoff',
      scene: label(scenes[scenes.length - 1], scenes.length),
      detail:
        `no scene in this deck performs a state-changing action, so there is no beat where the ` +
        `viewer watches the product DO anything — every frame is a read. \`arc_shape\` caps at 3 ` +
        `when the finale is not the strongest moment, and with \`overall_rule: lowest\` that ceiling ` +
        `alone keeps the run under the 4.0 convergence bar. Give the deck a beat that changes the ` +
        `page and put it last, or, if the payoff genuinely IS a read, declare \`finale_is_read\` ` +
        `with the reason and this check stands down`,
    });
    return finish(
      findings,
      scenes.length,
      lastActionSceneIndex,
      `${scenes.length} scene(s) judged; no scene performs a state change`,
    );
  }

  if (lastActionSceneIndex < scenes.length) {
    const trailing = scenes.length - lastActionSceneIndex;
    findings.push({
      kind: 'payoff-followed-by-decline',
      scene: label(scenes[lastActionSceneIndex - 1], lastActionSceneIndex),
      detail:
        `the deck's last state-changing beat is scene ${lastActionSceneIndex} of ${scenes.length}, ` +
        `and ${trailing} inert scene(s) follow it — so the run ends on a recap rather than on the ` +
        `moment the product acts. This is the ace#2339 shape verbatim: on ` +
        `spark-facilitator/20260909-1211 the peak was scene 4 of 6 and the arc judge capped ` +
        `\`arc_shape\` at 3 for exactly this, which pinned the whole run under 4.0. **The fix is a ` +
        `REORDER, not new material** — move the state-changing beat last, and fold whatever the ` +
        `trailing scenes say into the framing where it is context rather than a closing shrug`,
    });
    return finish(
      findings,
      scenes.length,
      lastActionSceneIndex,
      `${scenes.length} scene(s) judged; last state change at scene ${lastActionSceneIndex}`,
    );
  }

  return finish(
    findings,
    scenes.length,
    lastActionSceneIndex,
    `${scenes.length} scene(s) judged; the deck ends on its state-changing beat`,
  );
}
