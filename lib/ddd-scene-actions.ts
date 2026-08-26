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
 * ## #1365 — the artifact framed under a fixed header (RETRACTED, ace#1660)
 *
 * This module used to carry a `scroll-under-fixed-header` check: it flagged
 * every `scroll_to` whose `offset` was under 72px and told the author to pass
 * `offset: 96`. **Both halves were wrong, and the check is deleted. Do not
 * re-add it.**
 *
 * 1. **The remediation named a field canopy REJECTS.** `ScrollToAction` in
 *    canopy's `runtime/scripts/narrative/models.py` declares only `kind` and
 *    `target` (plus `note` / `must_succeed` / `timeout_ms` from `_ActionBase`),
 *    and `_ActionBase` sets `model_config = ConfigDict(extra="forbid")` — which
 *    its own docstring calls "the whole point of the discriminated union".
 *    Constructed against canopy 0.2.423:
 *    `ScrollToAction(kind="scroll_to", target="…", offset=96)` →
 *    `('offset',) Extra inputs are not permitted`. An author who followed the
 *    remediation converted a passing spec into one canopy refuses.
 *
 * 2. **The premise was stale.** The recorder does not stop at
 *    `scroll_into_view_if_needed`. `runtime/scripts/walkthrough/_lib/recorder.py`
 *    chases it with an explicit centring scroll —
 *    `window.scrollTo({top: y + window.scrollY - window.innerHeight / 2})` —
 *    which puts the element's top edge at the vertical CENTRE of the viewport,
 *    unreachable by a 72px fixed bar on any viewport taller than ~144px. That
 *    is ace#1365's own fix, closed COMPLETED 2026-08-14; the check outlived it
 *    and kept reporting a defect that had already been repaired.
 *
 * On bednet-check-2-visit/20260825-1310 it drew 5 findings, all false, on a
 * spec that validates clean. There is no `offset`-shaped field in canopy's
 * schema at any level, so the only honest levers on framing today are `scroll`
 * to `top`/`bottom` (its `value` takes a pixel offset) or a per-scene
 * `viewport`. This is the same shape as ace#1519 — a checker inventing syntax
 * for a system it does not own — which is why the remediation vocabulary is
 * now pinned by a test (see `test/lib/ddd-scene-actions.test.ts`).
 *
 * ## Scope
 *
 * The RUNTIME halves belong in canopy's walkthrough runner — resolving an
 * ambiguous `text:` target to the interactive node, comparing a gate against
 * the captured before-frame, and replaying restores.
 * This module is the ACE half: what `demo-narrative` can decide about its own
 * spec before handing off to the DDD loop.
 */

export interface SceneAction {
  kind: string;
  target?: string;
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
  | 'mutation-without-restore';

export interface SceneFinding {
  kind: SceneFindingKind;
  scene: string;
  detail: string;
}

export interface SceneReport {
  ok: boolean;
  findings: SceneFinding[];
}

/**
 * canopy's recorder prefixes, verbatim.
 *
 * `_PREFIXES = ("css", "text", "testid", "aria", "role")` with
 * `_PREFIX_SEPARATOR = ":"` in
 * `runtime/scripts/walkthrough/_lib/targets.py` (read against canopy 0.2.423).
 * `parse_target` looks for an exact `<prefix>:` match and returns
 * `("auto", target)` for everything else — so any OTHER spelling (`css=`,
 * `label:`, `xpath=`) falls through to the bare-string heuristic, i.e. the very
 * ambiguous-text resolution these checks exist to guard against. There is no
 * `=` form. (ace#1519.)
 */
const RECORDER_PREFIXES = ['css', 'text', 'testid', 'aria', 'role'] as const;

/**
 * The subset that names a CONTROL rather than whatever text matches first —
 * every recorder prefix except `text:` (the ambiguous form). `role:` also takes
 * a name segment (`role:button:Save`), which is why matching is prefix-only.
 */
const CONTROL_SELECTOR = /^(css:|testid:|aria:|role:)/i;

/** Strips any recorder prefix, so a word count sees the author's words only. */
const ANY_RECORDER_PREFIX = new RegExp(`^(${RECORDER_PREFIXES.join('|')}):`, 'i');

/**
 * Verbs whose click CREATES or DESTROYS something, so the same action finds a
 * different affordance on a re-run.
 */
const MUTATING_VERB =
  /\b(draft|create|send|submit|award|approve|reject|delete|discard|publish|invite|assign|archive)\b/i;

function targetText(t: string | undefined): string {
  return (t ?? '').replace(ANY_RECORDER_PREFIX, '').trim();
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
            'Target the control with a recorder prefix — css: / testid: / aria: / role:',
        });
      }

      if (a.kind === 'click' && MUTATING_VERB.test(targetText(a.target)) && !hasRestore) {
        findings.push({
          kind: 'mutation-without-restore',
          scene: name,
          detail:
            `click "${a.target}" creates or destroys a persistent object, so this scene is ` +
            'NOT idempotent — on the second render the same action finds a different affordance and ' +
            'fails. Declare a `restore:` block that returns the page to this scene\'s precondition — ' +
            'and note it must run before EVERY render and before every frame-fit pass, since the ' +
            'verifier replays these actions too',
        });
      }

      if (a.kind === 'wait_for') {
        // A gate must name something only the POST state contains. The tell of
        // a gate that cannot discriminate is that it is a bare prefix — no
        // number, no changed word — of text present either way.
        //
        // The heuristic is a WORD COUNT, so it only means anything on a target
        // made of words. A control selector (`testid:`/`css:`/`aria:`/`role:`)
        // names one specific element by id, and whether that element is present
        // only in the post-state is a fact about the DOM that no amount of
        // counting its id's words can answer — `testid:coverage-table` would be
        // flagged and `testid:coverage-table-9` waved through, for the same
        // gate. So: skip the heuristic when the author has already named a
        // control, and apply it to `text:`/bare targets, whose words ARE the
        // gate. Before ace#1660 only `text:` was stripped, so every control
        // selector was measured with its prefix still attached and flagged
        // unless its id happened to contain a digit — penalising exactly the
        // form `ambiguous-text-target` tells authors to use.
        const named = CONTROL_SELECTOR.test(a.target ?? '');
        const gate = targetText(a.target);
        const discriminating = /\d/.test(gate) || gate.split(/\s+/).length >= 4;
        if (!named && !discriminating) {
          findings.push({
            kind: 'non-discriminating-gate',
            scene: name,
            detail:
              `wait_for "${gate}" is satisfied before the action as well as after, so it gates nothing. ` +
              'Gate on a value only the post-state carries (a count, a status word, the new id)',
          });
        }
      }

    }
  }

  return { ok: findings.length === 0, findings };
}
