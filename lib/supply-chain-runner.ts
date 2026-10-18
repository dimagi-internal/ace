/**
 * Who runs a labs programme's supply chain, and what ACE does about it.
 *
 * Labs gives every programme ONE running organisation — the one whose people
 * tender, award, contract, order, pay and receive (`programme_runner_get`). A
 * caller is `programme` (a member of it), `operator` (platform support) or
 * `partner` (read, and write only through an update link). Tenders, awards,
 * contracts and payments need `programme`.
 *
 * Who ACE declares (owner, 2026-10-18: "having that winner fake a supply
 * chain procurement"):
 *
 *   - **`ace_winner` path → the winner's labs org (`llo_org`).** The awarded
 *     LLO is the one that procures, so it runs the programme's supply chain;
 *     contracts then name it as `buyer_of_record: programme_org`.
 *   - **otherwise → the PM org's labs org (`pm_org`).** The org that manages
 *     the programme in Connect runs it; a partner it buys for is named as
 *     `buyer_of_record: partner_org`.
 *
 * If labs refuses the winner as runner because it is not ELIGIBLE (e.g. it
 * holds no accepted application in the programme — simulated mode never
 * onboards it), ACE falls back to the PM org and keeps the winner as the
 * partner buyer of record. That is the same procurement, recorded with the
 * PM org deciding and the winner buying; the fallback and its reason are
 * written to run state, never silent.
 *
 * If labs refuses because ONLY PLATFORM SUPPORT may declare a runner (the
 * pre-2026-10-18 gate), nothing ACE can do changes that: halt with a
 * [BLOCKER]. Never work around it (spec § F1).
 *
 * An EXISTING runner is never moved: records already written are attributed
 * to it and cannot be deleted (spec § F6). If ACE already has `programme`
 * standing under it, proceed under that runner; if not, halt.
 */

export type RunnerRole = 'llo' | 'pm';
export type BuyerOfRecord = 'programme_org' | 'partner_org';

export interface RunnerState {
  /** Labs org id of the declared runner, or null when nobody has declared one. */
  org_id: number | null;
  your_standing: 'programme' | 'operator' | 'partner' | string;
}

export interface RunnerPlanInput {
  aceWinner: boolean;
  pmLabsOrgId: number;
  /** Required when `aceWinner` is true. */
  lloLabsOrgId?: number;
  current: RunnerState;
}

export type RunnerPlan =
  | {
      action: 'declare';
      /** The org to declare, in preference order: the first, then (on an eligibility refusal) the next. */
      candidates: ReadonlyArray<{ org_id: number; role: RunnerRole }>;
    }
  | {
      action: 'proceed';
      org_id: number;
      role: RunnerRole | 'other';
      buyer_of_record: BuyerOfRecord;
      note: string;
    }
  | { action: 'blocker'; reason: string };

export class SupplyChainRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplyChainRunnerError';
  }
}

/** What to do about the runner, from `programme_runner_get` and the run's optional steps. */
export function planRunner(input: RunnerPlanInput): RunnerPlan {
  if (input.aceWinner && input.lloLabsOrgId === undefined) {
    throw new SupplyChainRunnerError('ace_winner is on but no llo_org labs id was given');
  }
  if (input.aceWinner && input.lloLabsOrgId === input.pmLabsOrgId) {
    throw new SupplyChainRunnerError('llo_org and pm_org resolve to the same labs org; they must be distinct (spec § C)');
  }
  const { current } = input;
  if (current.org_id === null) {
    const candidates: Array<{ org_id: number; role: RunnerRole }> = [];
    if (input.aceWinner) candidates.push({ org_id: input.lloLabsOrgId as number, role: 'llo' });
    candidates.push({ org_id: input.pmLabsOrgId, role: 'pm' });
    return { action: 'declare', candidates };
  }
  const role: RunnerRole | 'other' =
    current.org_id === input.lloLabsOrgId ? 'llo' : current.org_id === input.pmLabsOrgId ? 'pm' : 'other';
  if (current.your_standing !== 'programme' && current.your_standing !== 'operator') {
    return {
      action: 'blocker',
      reason:
        `program already has runner org ${current.org_id} and ACE's standing under it is ` +
        `'${current.your_standing}'. ACE never moves an existing runner (its records cannot be deleted); ` +
        `an admin of org ${current.org_id} must add ace@ to its team (supply_chain_programme_team_add).`,
    };
  }
  return {
    action: 'proceed',
    org_id: current.org_id,
    role,
    buyer_of_record: buyerOfRecord(role),
    note:
      role === 'other'
        ? `runner org ${current.org_id} is neither pm_org nor llo_org; proceeding under it because ACE has programme standing`
        : 'runner already declared; not moved',
  };
}

/** The contract `buyer_of_record` that follows from who runs the programme. */
export function buyerOfRecord(runner: RunnerRole | 'other'): BuyerOfRecord {
  return runner === 'llo' ? 'programme_org' : 'partner_org';
}

export type RunnerRefusal = 'support_only' | 'not_eligible' | 'other';

/**
 * Classify a refused `programme_runner_set`. `support_only` is the gate
 * nothing in ACE can pass (halt); `not_eligible` means this org cannot run
 * this programme (try the next candidate); `other` is unknown (halt, quoting it).
 *
 * The support-only text is the live gate's own (connect-labs
 * `supply_chain/runner/operations.py`, 2026-10-18: "only platform support
 * declares which organisation runs a program"; the atom's description says
 * "Platform support only").
 */
export function classifyRunnerRefusal(message: string): RunnerRefusal {
  const m = message.toLowerCase();
  if (/only platform support|platform support only/.test(m)) return 'support_only';
  if (
    /accepted application|not (?:a |an )?(?:member|participant|eligible)|does not (?:hold|manage|participate)|no (?:accepted )?application|cannot run/.test(
      m,
    )
  ) {
    return 'not_eligible';
  }
  return 'other';
}
