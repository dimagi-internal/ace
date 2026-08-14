/**
 * Three ways a DDD scene reports `ok: true` while demonstrating nothing — all
 * decidable from the spec, before a single frame is rendered.
 *
 * All three surfaced on the SAME run, spark-facilitator/20260813-2126.
 *
 * ## #1379 — the click landed on prose
 *
 * Scene 3 filters twenty facilitators down to nine:
 *
 * ```yaml
 * - kind: click     target: text:Needs a look
 * - kind: wait_for  target: text:Showing
 * ```
 *
 * `record_video` reported **39 actions: all ok**. The frame showed the
 * checkbox UNCHECKED and the table reading "showing 20 of 20 facilitators".
 * `getByText('Needs a look')` matched THREE nodes — a card-subtitle DIV, the
 * actual LABEL control, and a reconciliation-sentence DIV — and `.first()`
 * took the DIV. **Clicking a div succeeds.** And `wait_for text:Showing` is
 * satisfied in both states, so the gate could not fail either.
 *
 * The extra DIV had been added by an earlier craft pass reconciling three
 * attention counts — a legitimate product improvement silently broke a
 * walkthrough scene, which is why "target the control, not the words" is a
 * contract and not a style note.
 *
 * ## #1380 — the scene was not idempotent
 *
 * Scene 5 clicks "Draft coaching message". The first render CREATED coaching
 * draft #5139 on the live dashboard. On the next render the button read "Open
 * draft #5139", the click failed `target_not_found`, and the scene captured
 * the un-drafted state while the narration described a draft being written.
 *
 * Worse: the frame-fit verifier replays the same actions, so **running the
 * verifier consumes the precondition for the render that follows it**. Two
 * tools that each need pristine state, run back to back, guarantee the second
 * sees dirty state.
 *
 * ## #1365 — the artifact framed under a fixed header
 *
 * The labs page has a **~72px fixed top bar**. `scroll_to` uses Playwright's
 * `scroll_into_view_if_needed`, which lands the artifact's top edge at y < 72
 * — underneath the bar. The scene captures, the action reports ok, and seven
 * independent judges rediscovered the same defect in different words
 * (`motion_friction` 2 on 7 of 12 scenes; concept eval **2/5, fail**). The
 * control case is decisive: the only two scenes scoring 4 are the two that
 * scroll to `bottom`, where no fixed header can occlude anything.
 *
 * ## Scope
 *
 * The RUNTIME halves belong in canopy's walkthrough runner — resolving an
 * ambiguous `text:` target to the interactive node, comparing a gate against
 * the captured before-frame, replaying restores, and offsetting the scroll.
 * This module is the ACE half: what `demo-narrative` can decide about its own
 * spec before handing off to the DDD loop.
 */

export interface SceneAction {
  kind: string;
  target?: string;
  /** Pixels to leave above the artifact — see #1365. */
  offset?: number;
}

export interface DddScene {
  title?: string;
  actions?: SceneAction[];
  /** Off-camera actions restoring this scene's precondition (#1380). */
  restore?: SceneAction[];
}

export type SceneFindingKind =
  | 'ambiguous-text-target'
  | 'non-discriminating-gate'
  | 'mutation-without-restore'
  | 'scroll-under-fixed-header';

export interface SceneFinding {
  kind: SceneFindingKind;
  scene: string;
  detail: string;
}

export interface SceneReport {
  ok: boolean;
  findings: SceneFinding[];
}

/** The labs shell's fixed top bar, measured on spark-facilitator (#1365). */
export const FIXED_HEADER_PX = 72;

/** Selector forms that name a CONTROL rather than whatever text matches first. */
const CONTROL_SELECTOR = /^(role=|label:|css=|xpath=|testid=|aria=)/i;

/**
 * Verbs whose click CREATES or DESTROYS something, so the same action finds a
 * different affordance on a re-run.
 */
const MUTATING_VERB =
  /\b(draft|create|send|submit|award|approve|reject|delete|discard|publish|invite|assign|archive)\b/i;

function targetText(t: string | undefined): string {
  return (t ?? '').replace(/^text:/i, '').trim();
}

export function checkSceneActions(scenes: DddScene[]): SceneReport {
  const findings: SceneFinding[] = [];

  for (const s of scenes ?? []) {
    const name = s.title ?? '(untitled)';
    const actions = s.actions ?? [];
    const hasRestore = (s.restore ?? []).length > 0;

    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];

      if (a.kind === 'click' && !CONTROL_SELECTOR.test(a.target ?? '')) {
        findings.push({
          kind: 'ambiguous-text-target',
          scene: name,
          detail:
            `click targets "${a.target}" by TEXT. A text selector resolves .first() in DOM order, and ` +
            'clicking a non-interactive node SUCCEEDS — so the action reports ok while nothing happens. ' +
            'Target the control: role=… / label: / css= / testid=',
        });
      }

      if (a.kind === 'click' && MUTATING_VERB.test(targetText(a.target)) && !hasRestore) {
        findings.push({
          kind: 'mutation-without-restore',
          scene: name,
          detail:
            `click "${targetText(a.target)}" creates or destroys a persistent object, so this scene is ` +
            'NOT idempotent: on the second render the same action finds a different affordance and ' +
            'fails. Declare a `restore:` block that returns the page to this scene\'s precondition — ' +
            'and note it must run before EVERY render and before every frame-fit pass, since the ' +
            'verifier replays these actions too',
        });
      }

      if (a.kind === 'wait_for') {
        // A gate must name something only the POST state contains. The tell of
        // a gate that cannot discriminate is that it is a bare prefix — no
        // number, no changed word — of text present either way.
        const gate = targetText(a.target);
        const discriminating = /\d/.test(gate) || gate.split(/\s+/).length >= 4;
        if (!discriminating) {
          findings.push({
            kind: 'non-discriminating-gate',
            scene: name,
            detail:
              `wait_for "${gate}" is satisfied before the action as well as after, so it gates nothing. ` +
              'Gate on a value only the post-state carries (a count, a status word, the new id)',
          });
        }
      }

      if (a.kind === 'scroll_to') {
        const t = targetText(a.target).toLowerCase();
        const anchored = t === 'bottom' || t === 'top';
        if (!anchored && (a.offset ?? 0) < FIXED_HEADER_PX) {
          findings.push({
            kind: 'scroll-under-fixed-header',
            scene: name,
            detail:
              `scroll_to "${targetText(a.target)}" has no offset clearing the ~${FIXED_HEADER_PX}px fixed ` +
              'top bar. scroll_into_view_if_needed lands the artifact\'s top edge underneath it — the ' +
              'scene still captures and the action still reports ok, the frame is just wrong. Pass ' +
              `offset: ${FIXED_HEADER_PX + 24} or scroll to bottom`,
          });
        }
      }
    }
  }

  return { ok: findings.length === 0, findings };
}
