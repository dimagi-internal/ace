// Validator for a STANDALONE Connect opportunity spec â€” the input to
// `/ace:connect-opp-create` (skills/connect-opp-create).
//
// Phase 4 (`connect-opp-setup`) derives ~15 values from a PDD, a Phase-3
// deploy summary and a run_state. This helper is the same contract with the
// derivation removed: one YAML in, a list of issues out, no Drive, no run.
//
// It is deliberately a PURE helper returning issues rather than throwing on
// the first problem. A standalone operator flow wants every complaint at once
// â€” the alternative is a create/fix/create loop, and `connect_create_opportunity`
// is not free (it registers HQApiKey records and synchronously fetches app
// names from CommCareHQ).
//
// SCOPE, stated so it can be widened: this validates the SPEC. It does not
// call Connect, so it cannot see the program budget ceiling, whether the
// target org has an ACCEPTED ProgramApplication, or whether the HQ apps are
// released. Those are live-surface facts and the real call is their authority
// â€” CLAUDE.md Â§ "attempt the transition and treat the conflict as the skip."
//
// Two canonical rules are re-derived here rather than imported, because the
// repo convention is that `mcp/` imports `lib/` and never the reverse:
//   - the is_test run-id name prefix â€” `mcp/connect/opportunity-name.ts`
//   - the funds-â‰¥1-FLW capacity formula â€” `mcp/connect/opportunity-capacity.ts`
// `test/lib/connect-opp-spec.test.ts` imports BOTH sides and asserts they
// agree, so the duplication cannot drift silently.

/** One payment unit, in the shape `connect_create_payment_units` takes. */
export interface OppSpecPaymentUnit {
  name: string;
  description?: string;
  /** Whole currency units (NOT cents) â€” PositiveIntegerField upstream. */
  amount: number;
  org_amount?: number;
  max_total: number;
  max_daily?: number;
}

/** `HqAppZ` from `mcp/connect-server.ts`, minus the api_key (env-substituted). */
export interface OppSpecApp {
  cc_domain: string;
  /** Bare 32-char HQ app id. */
  cc_app_id: string;
  hq_server_url?: string;
  /** Learn only â€” Connect's form marks it required. */
  description?: string;
}

/**
 * Clone provenance. Present iff the spec was hydrated from an existing
 * opportunity via `connect_get_opportunity`.
 */
export interface OppSpecCloneFrom {
  opportunity_id: string;
  /** The SOURCE opp's app ids, so we can refuse to reuse them. */
  source_learn_app_id?: string;
  source_deliver_app_id?: string;
}

export interface ConnectOppSpec {
  organization_slug?: string;
  program_id?: string;
  name?: string;
  short_description?: string;
  description?: string;
  target_organization_slug?: string;
  start_date?: string;
  end_date?: string;
  total_budget?: number;
  passing_score?: number;
  is_test?: boolean;
  learn_app?: Partial<OppSpecApp>;
  deliver_app?: Partial<OppSpecApp>;
  payment_units?: OppSpecPaymentUnit[];
  /** Smoke headroom â€” how many FLWs the budget must fund. Default 3. */
  fund_users?: number;
  clone_from?: OppSpecCloneFrom;
}

export interface SpecIssue {
  /** `error` blocks the create; `warn` is advisory and the flow proceeds. */
  severity: 'error' | 'warn';
  code: string;
  field: string;
  message: string;
}

/**
 * Run-id front prefix for `is_test` opportunities: `YYYYMMDD-HHMM` + space +
 * U+00B7 MIDDLE DOT + space. Mirrors `OPP_NAME_RUN_ID_PREFIX_RE` in
 * `mcp/connect/opportunity-name.ts`; pinned equal by the test.
 */
export const RUN_ID_PREFIX_RE = /^\d{8}-\d{4} · /u;

/** Server-enforced ceiling on `short_description`. */
export const SHORT_DESCRIPTION_MAX = 50;

/**
 * Advisory ceiling on `description`. Not server-enforced: Connect 500s
 * intermittently somewhere above this, first observed on leep-paint-collection
 * (jjackson/ace#106 finding 7). Advisory precisely because the threshold was
 * never pinned â€” a hard bar here would be a prediction, not a rule.
 */
export const DESCRIPTION_SOFT_MAX = 250;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HQ_APP_ID_RE = /^[0-9a-f]{32}$/i;

const DEFAULT_FUND_USERS = 3;

/**
 * Î£ over payment units of `max_total Ã— (amount + org_amount)` â€” the budget
 * that funds exactly one FLW at the configured maxima. Connect's own
 * `Opportunity.number_of_users` divides `total_budget` by this.
 */
export function minBudgetForOneUser(units: OppSpecPaymentUnit[]): number {
  return units.reduce((sum, pu) => sum + pu.max_total * (pu.amount + (pu.org_amount ?? 0)), 0);
}

function req(
  issues: SpecIssue[],
  field: string,
  value: unknown,
  code = 'missing_required_field',
): boolean {
  if (value === undefined || value === null || value === '') {
    issues.push({
      severity: 'error',
      code,
      field,
      message: `\`${field}\` is required by connect_create_opportunity.`,
    });
    return false;
  }
  return true;
}

function wholeUnitInteger(issues: SpecIssue[], field: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  if (!Number.isInteger(value)) {
    issues.push({
      severity: 'error',
      code: 'non_integer_currency',
      field,
      message:
        `\`${field}\` is ${value}. Connect stores amount / org_amount / total_budget as ` +
        'integers in whole currency units (PositiveIntegerField / PositiveBigIntegerField in ' +
        'commcare_connect/opportunity/models.py) and the serializer refuses floats. ' +
        'Round to a whole unit and log the rounding.',
    });
  }
  if (value < 0) {
    issues.push({
      severity: 'error',
      code: 'negative_currency',
      field,
      message: `\`${field}\` must be non-negative.`,
    });
  }
}

/**
 * Validate a standalone opportunity spec. Returns every issue found; the
 * caller creates nothing while any `severity: 'error'` remains.
 */
export function validateConnectOppSpec(spec: ConnectOppSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];

  // ---- Identity -----------------------------------------------------------
  req(issues, 'organization_slug', spec.organization_slug);
  req(issues, 'program_id', spec.program_id);
  req(issues, 'name', spec.name);
  req(issues, 'short_description', spec.short_description);
  req(issues, 'description', spec.description);

  if (spec.short_description && spec.short_description.length > SHORT_DESCRIPTION_MAX) {
    issues.push({
      severity: 'error',
      code: 'short_description_too_long',
      field: 'short_description',
      message:
        `\`short_description\` is ${spec.short_description.length} chars; Connect caps it at ` +
        `${SHORT_DESCRIPTION_MAX} server-side and truncates silently, after which slug-keyed ` +
        'lookups 404. Put the long form in `description`.',
    });
  }

  if (spec.description && spec.description.length > DESCRIPTION_SOFT_MAX) {
    issues.push({
      severity: 'warn',
      code: 'description_long',
      field: 'description',
      message:
        `\`description\` is ${spec.description.length} chars. Connect has been seen to 500 ` +
        'intermittently on long descriptions (jjackson/ace#106 finding 7); ' +
        `â‰¤${DESCRIPTION_SOFT_MAX} is the safe band. Advisory â€” the real call is the authority.`,
    });
  }

  // The name prefix is enforced in code at the MCP boundary, so surfacing it
  // here only saves a round-trip â€” it is not a second opinion (ace#755).
  if (spec.is_test === true && spec.name && !RUN_ID_PREFIX_RE.test(spec.name)) {
    issues.push({
      severity: 'error',
      code: 'invalid_opp_name_prefix',
      field: 'name',
      message:
        `\`is_test: true\` names must lead with a run-id prefix ("YYYYMMDD-HHMM · <display>", ` +
        `U+00B7 separator) â€” got "${spec.name}". The MCP boundary rejects this before any ` +
        'network call (ace#755). For a real, human-facing opportunity set `is_test: false`.',
    });
  }

  // ---- Window -------------------------------------------------------------
  for (const f of ['start_date', 'end_date'] as const) {
    const v = spec[f];
    if (!req(issues, f, v)) continue;
    if (!DATE_RE.test(String(v))) {
      issues.push({
        severity: 'error',
        code: 'bad_date_format',
        field: f,
        message: `\`${f}\` must be YYYY-MM-DD â€” got "${String(v)}".`,
      });
    }
  }
  if (
    spec.start_date &&
    spec.end_date &&
    DATE_RE.test(spec.start_date) &&
    DATE_RE.test(spec.end_date) &&
    spec.start_date >= spec.end_date
  ) {
    issues.push({
      severity: 'error',
      code: 'window_inverted',
      field: 'end_date',
      message: `\`end_date\` (${spec.end_date}) must be after \`start_date\` (${spec.start_date}).`,
    });
  }

  // ---- Apps ---------------------------------------------------------------
  for (const side of ['learn_app', 'deliver_app'] as const) {
    const app = spec[side];
    if (!req(issues, side, app)) continue;
    req(issues, `${side}.cc_domain`, app?.cc_domain);
    if (req(issues, `${side}.cc_app_id`, app?.cc_app_id) && !HQ_APP_ID_RE.test(app!.cc_app_id!)) {
      issues.push({
        severity: 'warn',
        code: 'app_id_shape',
        field: `${side}.cc_app_id`,
        message:
          `\`${side}.cc_app_id\` should be a bare 32-char hex HQ app id â€” got ` +
          `"${app!.cc_app_id}". A build id or a URL fragment here wires the opportunity to ` +
          'nothing, and app wiring is write-once at create.',
      });
    }
  }
  if (!req(issues, 'learn_app.description', spec.learn_app?.description)) {
    // Connect's form marks the Learn app description required; the create
    // fails without it.
  }
  if (
    spec.learn_app?.cc_app_id &&
    spec.deliver_app?.cc_app_id &&
    spec.learn_app.cc_app_id === spec.deliver_app.cc_app_id
  ) {
    issues.push({
      severity: 'error',
      code: 'same_app_both_sides',
      field: 'deliver_app.cc_app_id',
      message:
        '`learn_app.cc_app_id` and `deliver_app.cc_app_id` are the same app. Connect validates ' +
        'these differ server-side.',
    });
  }

  // ---- Learn gate ---------------------------------------------------------
  if (req(issues, 'passing_score', spec.passing_score)) {
    const s = spec.passing_score!;
    if (!Number.isInteger(s) || s < 0 || s > 100) {
      issues.push({
        severity: 'error',
        code: 'bad_passing_score',
        field: 'passing_score',
        message: `\`passing_score\` must be an integer 0-100 â€” got ${String(s)}.`,
      });
    }
  }

  // ---- Money --------------------------------------------------------------
  req(issues, 'total_budget', spec.total_budget);
  wholeUnitInteger(issues, 'total_budget', spec.total_budget);

  const units = spec.payment_units ?? [];
  if (units.length === 0) {
    issues.push({
      severity: 'error',
      code: 'no_payment_units',
      field: 'payment_units',
      message:
        'At least one payment unit is required: Connect\'s /activate/ endpoint validates that ' +
        'one exists, so an opp with none can never be activated and never accepts invites.',
    });
  }
  units.forEach((pu, i) => {
    req(issues, `payment_units[${i}].name`, pu.name);
    req(issues, `payment_units[${i}].amount`, pu.amount);
    req(issues, `payment_units[${i}].max_total`, pu.max_total);
    wholeUnitInteger(issues, `payment_units[${i}].amount`, pu.amount);
    wholeUnitInteger(issues, `payment_units[${i}].org_amount`, pu.org_amount);
    wholeUnitInteger(issues, `payment_units[${i}].max_total`, pu.max_total);
  });

  const fundUsers = spec.fund_users ?? DEFAULT_FUND_USERS;
  const minOne = minBudgetForOneUser(units);
  if (units.length > 0 && minOne > 0 && typeof spec.total_budget === 'number') {
    const users = spec.total_budget / minOne;
    if (users < 1) {
      issues.push({
        severity: 'error',
        code: 'opportunity_underfunded',
        field: 'total_budget',
        message:
          `total_budget ${spec.total_budget} funds ${users.toFixed(4)} FLW (< 1). Connect computes ` +
          `number_of_users = total_budget / Σ(max_total × (amount + org_amount)) = ` +
          `${spec.total_budget} / ${minOne}; below 1 it under-allocates create_claim_limits and no ` +
          'FLW can claim. Raise total_budget to at least ' +
          `${minOne * fundUsers} (×${fundUsers} headroom), or lower max_total. If you passed ` +
          'cents you inflated the per-user cost 100× — pass whole units.',
      });
    } else if (users < fundUsers) {
      issues.push({
        severity: 'warn',
        code: 'thin_headroom',
        field: 'total_budget',
        message:
          `total_budget funds ${users.toFixed(2)} FLW; \`fund_users\` asks for ${fundUsers}. ` +
          `Raise to ${minOne * fundUsers} for smoke headroom.`,
      });
    }
  }

  // ---- Clone provenance ---------------------------------------------------
  // The single most expensive mistake available in this flow, and the one a
  // clone invites by construction: pointing the new opportunity at the SOURCE
  // opportunity's released apps.
  if (spec.clone_from) {
    const pairs: Array<[string, string | undefined, string | undefined]> = [
      ['deliver_app.cc_app_id', spec.clone_from.source_deliver_app_id, spec.deliver_app?.cc_app_id],
      ['learn_app.cc_app_id', spec.clone_from.source_learn_app_id, spec.learn_app?.cc_app_id],
    ];
    for (const [field, source, next] of pairs) {
      if (!source || !next || source !== next) continue;
      const isDeliver = field.startsWith('deliver');
      issues.push({
        severity: 'error',
        code: isDeliver ? 'clone_reuses_deliver_app' : 'clone_reuses_learn_app',
        field,
        message: isDeliver
          ? `Clone reuses the source opportunity's Deliver app (${source}). Connect keys DeliverUnit ` +
            'on the released app, not on the opportunity, so the new opp cannot create a payment ' +
            'unit ("Invalid or already-assigned deliver unit IDs"), there is no ' +
            'connect_delete_payment_unit atom, and an opp with no payment unit can never activate ' +
            '(jjackson/ace#573). Mint a fresh app id with commcare_linked_app_copy, then build and ' +
            'release it.'
          : `Clone reuses the source opportunity's Learn app (${source}). Connect keys CommCareApp ` +
            'on (cc_app_id, cc_domain, organization, hq_server) and the create path runs ' +
            'get_or_create with update_existing=False, so the posted passing_score is silently ' +
            'discarded and the new opp inherits the source opp\'s gate (jjackson/ace#1350). Mint a ' +
            'fresh app id with commcare_linked_app_copy, or accept the shared gate deliberately and ' +
            'drop source_learn_app_id from the spec.',
      });
    }
  }

  return issues;
}

/** Convenience: does this spec have any blocking issue? */
export function hasBlockingIssue(issues: SpecIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** Render issues for an operator, errors first. */
export function formatSpecIssues(issues: SpecIssue[]): string {
  if (issues.length === 0) return 'spec OK â€” no issues.';
  const order = { error: 0, warn: 1 } as const;
  return [...issues]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((i) => `[${i.severity.toUpperCase()}] ${i.field} (${i.code}): ${i.message}`)
    .join('\n');
}
