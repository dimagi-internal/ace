/**
 * What a `passing_score` read-back mismatch actually MEANS after
 * `connect_create_opportunity`, and what to do about it.
 *
 * Why this is code rather than a severity rule in prose
 * (dimagi-internal/ace#1350): the mismatch has one dominant cause, and the
 * skill's existing `[BLOCKER]` did not name it, so it read as generic server
 * drift and sent the operator to debug the wrong thing.
 *
 * The cause, from `commcare_connect/opportunity/forms.py:556-587`
 * (`dimagi/commcare-connect@5f69bb3d`):
 *
 * ```python
 * app, created = CommCareApp.objects.get_or_create(
 *     cc_app_id=app_data["id"], cc_domain=domain,
 *     organization=organization, hq_server=hq_server,
 *     defaults=defaults,          # <- includes passing_score
 * )
 * if not created and update_existing:   # update_existing=False on CREATE
 * ```
 *
 * The row is keyed on `(cc_app_id, cc_domain, organization, hq_server)` — NOT
 * by opportunity. So:
 *
 *  1. **The score is SHARED.** Every opportunity in the org wired to the same
 *     HQ Learn app reads one `CommCareApp.passing_score`. Changing it for one
 *     changes the gate for all — the same shape as the documented
 *     `DeliverUnit` sharing gotcha.
 *  2. **On CREATE against an existing row the posted value is DISCARDED.**
 *     `get_or_create` ignores `defaults` when the row exists, and the create
 *     path passes `update_existing=False`. No error is raised.
 *
 * ACE has escaped this only by an unstated invariant — every `/ace:run` builds
 * a fresh Nova Learn app, so every create posts a new `cc_app_id` and always
 * takes `created=True`. It breaks the moment anything reuses an HQ Learn app:
 * a forked run, a hand-wired opp, a Phase 4 re-mint against the same release,
 * or an opp created against a prior run's app to save a build.
 *
 * The repair atom exists (`connect_set_learn_passing_score`, ace#1341 / PR
 * #1348), so the right response is to REPAIR and disclose the shared-gate
 * consequence — not to halt on an unexplained symptom.
 */

export interface PassingScoreReadback {
  /** What ACE posted on the create call. */
  posted: number;
  /** What `connect_get_opportunity` returned; undefined when unreadable. */
  readBack?: number;
  /**
   * True when the PDD stated the gate
   * (`program_parameters.learn_passing_score` is set). False when ACE
   * defaulted and the server returned its own — a different situation.
   */
  pddDecided: boolean;
}

export interface PassingScoreRepair {
  atom: 'connect_set_learn_passing_score';
  passing_score: number;
  caution: string;
}

export interface PassingScoreVerdict {
  severity: 'ok' | 'info' | 'blocker';
  message: string;
  repair?: PassingScoreRepair;
}

const SHARED_GATE_CAUTION =
  'This moves the gate for EVERY opportunity in the org wired to this HQ Learn app — the score ' +
  'lives on the shared CommCareApp row, not on the opportunity. Record the previous value the ' +
  'atom returns, and check no live opportunity depends on it.';

export function classifyPassingScoreReadback(r: PassingScoreReadback): PassingScoreVerdict {
  if (r.readBack === undefined) {
    return {
      severity: 'blocker',
      message:
        'passing_score could not be read back from the created opportunity — the gate is in an ' +
        'unknown state and this call is the only place it is set. Inspect the opportunity in the ' +
        'Connect web UI before proceeding.',
    };
  }
  if (r.readBack === r.posted) {
    return { severity: 'ok', message: `passing_score round-tripped as ${r.posted}` };
  }
  if (!r.pddDecided) {
    return {
      severity: 'info',
      message:
        `ACE defaulted passing_score to ${r.posted} and the server returned ${r.readBack}. The PDD ` +
        'decided nothing, so the server default stands — document the diff and proceed.',
    };
  }
  return {
    severity: 'blocker',
    message:
      `posted passing_score=${r.posted}, read back ${r.readBack}. This is almost certainly NOT server ` +
      'drift: the CommCareApp row for this cc_app_id already existed in this org, so Connect ' +
      "discarded the posted value (get_or_create ignores `defaults` on an existing row, and the " +
      'create path passes update_existing=False). The opportunity inherited whatever an earlier one ' +
      `set. Repair with connect_set_learn_passing_score(${r.posted}).`,
    repair: {
      atom: 'connect_set_learn_passing_score',
      passing_score: r.posted,
      caution: SHARED_GATE_CAUTION,
    },
  };
}
