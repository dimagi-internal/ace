/**
 * connect-opp-setup Step 4.0 — FINISH a half-built opportunity, never mint a
 * second one (ace#2083 fix (1), the identifier half of ace#2412).
 *
 * ## The defect
 *
 * `connect_create_opportunity` is one POST that creates the opportunity with
 * its dates and budget but NO payment units. Payment units land in Step 6 and
 * activation in Step 6.5. Connect's `Opportunity.is_setup_complete` is false
 * until a payment unit exists (`commcare_connect/opportunity/models.py`:
 * `paymentunit_set.exists() and total_budget and start_date and end_date`), and
 * while it is false the dashboard 302s to the payment-unit wizard, so every
 * read reports `dashboard_read: 'setup_incomplete'`. A Phase 4 that dies
 * between Step 4 and Step 6 therefore leaves exactly that shape.
 *
 * The skill then had no resume path ("an idempotent-resume path … is tracked as
 * future work"), and `products.connect` landed only at Step 10. A re-dispatch
 * read "no opportunity recorded", created ANOTHER, and the first was stranded
 * for good: Connect has no opportunity-delete route (`opportunity/urls.py`), and
 * its only purge is the Monday `delete_stale_opportunities` task, which takes
 * visit-free opportunities once they are SIX MONTHS old. Measured on
 * the shared PM org 2026-09-06: 11 of 71 rows, ACE's own abandoned Phase 4 runs,
 * each costing one `EXPECTED_OPP_BUDGET` in every program-ceiling sum on the
 * org (ace#2083).
 *
 * ## The rule
 *
 * Before the create, decide from two facts — the id this run already recorded
 * (`phases.connect-setup.products.connect.opportunity.id`) and a name-filtered
 * listing of the org — whether to CREATE, ADOPT an existing opportunity and
 * finish its setup, or HALT naming the ids. The opportunity's name is
 * deterministic (`"<run_id> · <PDD display name>"`, code-enforced by
 * `INVALID_OPP_NAME_PREFIX`), so a row bearing it is this run's own.
 *
 * Pure: the skill does `connect_list_opportunities({organization_slug,
 * name: <run_id>, hydrate: true})` and hands the result in. Never guesses: an
 * incomplete listing, a recorded id the listing cannot find, or more than one
 * candidate halts rather than picking one.
 */

export type OppResumeAction = 'create' | 'adopt' | 'halt';

export type OppResumeHaltCode =
  /** The listing did not read every row, so an orphan cannot be ruled out. */
  | 'LISTING_INCOMPLETE'
  /** run_state names an opportunity the (complete) listing does not contain. */
  | 'RECORDED_OPP_NOT_FOUND'
  /** More than one opportunity already carries this run's exact name. */
  | 'ORPHAN_OPPORTUNITIES'
  /** A row carries this run's id prefix under a DIFFERENT name. */
  | 'RUN_ID_COLLISION';

export interface OppResumeRow {
  id?: unknown;
  name?: unknown;
  dashboard_read?: unknown;
  active?: unknown;
}

export interface OppResumeInput {
  /** `YYYYMMDD-HHMM` — the run id the opportunity name leads with. */
  runId: string;
  /** The exact name Step 4 would create: `"<run_id> · <PDD display name>"`. */
  expectedName: string;
  /** `phases.connect-setup.products.connect.opportunity` as run_state has it. */
  recorded?: { id?: unknown; name?: unknown } | null;
  /** `connect_list_opportunities(...).listing`, or null if the read failed. */
  listing: { complete?: unknown; total_count?: unknown } | null;
  /** `connect_list_opportunities(...).opportunities`, or null if the read failed. */
  rows: OppResumeRow[] | null;
}

export interface OppResumeAdopted {
  opportunity_id: string;
  name: string;
  /** Where the id came from: run_state, or a listing row the run never recorded. */
  source: 'recorded' | 'listing';
  /**
   * `true` — Connect reports the setup unfinished: Steps 5, 6 and 6.5 must run
   * on THIS opportunity. `false` — setup is complete: list payment units
   * before creating any. `null` — the row was not hydrated, so unknown.
   */
  setup_incomplete: boolean | null;
}

export type OppResumePlan =
  | { action: 'create'; reason: string }
  | ({ action: 'adopt'; reason: string } & OppResumeAdopted)
  | { action: 'halt'; code: OppResumeHaltCode; opportunity_ids: string[]; reason: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function setupIncomplete(row: OppResumeRow): boolean | null {
  if (typeof row.dashboard_read !== 'string') return null;
  return row.dashboard_read === 'setup_incomplete';
}

function adopt(row: OppResumeRow, source: 'recorded' | 'listing', reason: string): OppResumePlan {
  return {
    action: 'adopt',
    opportunity_id: str(row.id) as string,
    name: str(row.name) ?? '',
    source,
    setup_incomplete: setupIncomplete(row),
    reason,
  };
}

/** Decide CREATE / ADOPT / HALT for connect-opp-setup Step 4.0. */
export function planOpportunityCreate(input: OppResumeInput): OppResumePlan {
  const expected = input.expectedName.trim();
  const recordedId = str(input.recorded?.id);
  const rows = (input.rows ?? []).filter((r) => str(r.id) !== null);

  // A recorded id the listing can see is the strongest fact there is — adopt
  // it whatever else the listing says.
  if (recordedId) {
    const hit = rows.find((r) => str(r.id) === recordedId);
    if (hit) {
      const others = rows.filter((r) => str(r.id) !== recordedId && str(r.name) === expected);
      return adopt(
        hit,
        'recorded',
        `run_state records opportunity ${recordedId} and Connect lists it — finish its setup, do not create another.` +
          (others.length
            ? ` ${others.length} other opportunit${others.length === 1 ? 'y carries' : 'ies carry'} this run's exact name ` +
              `(${others.map((r) => str(r.id)).join(', ')}) — orphans of an earlier dispatch; report them, do not touch them.`
            : ''),
      );
    }
  }

  if (input.rows === null || input.listing === null || input.listing.complete !== true) {
    return {
      action: 'halt',
      code: 'LISTING_INCOMPLETE',
      opportunity_ids: recordedId ? [recordedId] : [],
      reason:
        'connect_list_opportunities did not return a complete listing, so an opportunity this run already ' +
        'created cannot be ruled out — creating now could strand it as a permanent setup_incomplete orphan. ' +
        'Re-run the listing; do not create on a partial one.',
    };
  }

  if (recordedId) {
    return {
      action: 'halt',
      code: 'RECORDED_OPP_NOT_FOUND',
      opportunity_ids: [recordedId],
      reason:
        `run_state records opportunity ${recordedId} but the complete listing (${String(input.listing.total_count)} rows) ` +
        'does not contain it. Check the org it was listed at (the PM org lists NM-held opportunities) before ' +
        'anything else; never create a replacement on this evidence alone.',
    };
  }

  const exact = rows.filter((r) => str(r.name) === expected);
  const collisions = rows.filter((r) => str(r.name) !== expected && (str(r.name) ?? '').includes(input.runId));

  if (exact.length > 1) {
    return {
      action: 'halt',
      code: 'ORPHAN_OPPORTUNITIES',
      opportunity_ids: exact.map((r) => str(r.id) as string),
      reason:
        `${exact.length} opportunities already carry this run's exact name "${expected}". Adopting one is a guess ` +
        'and creating another adds a third; name them to the operator. The ones not adopted are permanent ' +
        'until Connect purges them (visit-free, 6 months — there is no delete API).',
    };
  }
  if (exact.length === 1) {
    return adopt(
      exact[0],
      'listing',
      `An opportunity named "${expected}" already exists but run_state never recorded it — an earlier dispatch ` +
        'created it and died before the write. Adopt it, record its id now, and finish its setup.',
    );
  }
  if (collisions.length > 0) {
    return {
      action: 'halt',
      code: 'RUN_ID_COLLISION',
      opportunity_ids: collisions.map((r) => str(r.id) as string),
      reason:
        `Opportunit${collisions.length === 1 ? 'y' : 'ies'} ${collisions.map((r) => `"${str(r.name)}"`).join(', ')} ` +
        `carry run id ${input.runId} under a different name. Either the PDD display name changed since an earlier ` +
        'dispatch (adopt it by id) or another run shares the id (Phase 6 tile matching would be ambiguous). ' +
        'The operator decides; do not create.',
    };
  }
  return {
    action: 'create',
    reason: `The complete listing (${String(input.listing.total_count)} rows) holds no opportunity for run ${input.runId}.`,
  };
}
