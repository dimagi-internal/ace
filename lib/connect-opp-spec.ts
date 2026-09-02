// Validator for a STANDALONE Connect opportunity spec -- the input to
// `/ace:connect-opp-create` (skills/connect-opp-create).
//
// Phase 4 (`connect-opp-setup`) derives the same values from a PDD, a Phase-3
// deploy summary and a run_state. This is the same contract with the
// derivation removed: one YAML in, a list of issues out, no Drive, no run.
//
// ## Why an issue LIST, and why it takes `unknown`
//
// It returns every complaint at once rather than throwing on the first,
// because `connect_create_opportunity` registers HQApiKey records and
// synchronously fetches app names from CommCareHQ -- a create/fix/create loop
// is not free, and the create is write-once (Connect exposes no way to
// re-point a live opportunity at a different app).
//
// It accepts `unknown` because its only caller hands it `yaml.parse()` of an
// operator-authored file. Typing the parameter as the happy shape and trusting
// it is how the first version reported "spec OK" on `total_budget: "900"` --
// a quoted number, the single most likely YAML slip -- while silently skipping
// BOTH the whole-unit check and the funds->=1-FLW floor. That floor is the most
// valuable rule here, so "not checked, rendered as no issue" is the one
// outcome this file must never produce. It is the same lesson the skill quotes
// at Step 4 for Connect's own read-backs (ace#1647): an absent value is
// unknown, never agreement.
//
// ## Scope, stated so it can be widened
//
// This validates the SPEC. It does not call Connect, so it cannot see the
// program budget ceiling, whether the target org has an ACCEPTED
// ProgramApplication, whether the HQ apps are released, or which apps other
// opportunities already use. Those are live facts and the real call is their
// authority -- CLAUDE.md: "attempt the transition and treat the conflict as
// the skip."
//
// Rules shared with the MCP boundary (the name prefix, the 50-char cap, the
// capacity formula) are IMPORTED from `lib/connect-opp-invariants.ts`, not
// copied. An earlier revision copied them and pinned them with a test; review
// found the copies had already diverged on non-finite input, which is exactly
// what a pin cannot prevent.
import {
  OPP_NAME_RUN_ID_PREFIX_RE,
  SHORT_DESCRIPTION_MAX,
  HQ_BASE_URLS,
  minBudgetForOneUser,
  numberOfUsers,
  fundsAtLeastOneUser,
} from './connect-opp-invariants.js';

export { OPP_NAME_RUN_ID_PREFIX_RE, SHORT_DESCRIPTION_MAX, minBudgetForOneUser };

/** One payment unit, in the shape `connect_create_payment_units` takes. */
export interface OppSpecPaymentUnit {
  name: string;
  description?: string;
  /** Whole currency units (NOT cents) -- PositiveIntegerField upstream. */
  amount: number;
  org_amount?: number;
  max_total: number;
  max_daily?: number;
  /**
   * Deliver-unit `server_id`s that MUST be completed for this payment to
   * trigger. Non-empty is a hard pre-create gate -- see the validator.
   */
  required_deliver_units: number[];
  optional_deliver_units?: number[];
}

/** `HqAppZ` from `mcp/connect-server.ts`, minus the api_key. */
export interface OppSpecApp {
  cc_domain: string;
  /** Bare 32-char HQ app id. */
  cc_app_id: string;
  /** Required by the atom (`z.string().url()`), allowlisted here. */
  hq_server_url: string;
  /** Learn only -- Connect's form marks it required. */
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
  /** How many FLWs the budget should fund. Default 3. */
  fund_users?: number;
  /** FLW pre-invites, E.164 (or a `${VAR}` placeholder). */
  invite_phone_numbers?: string[];
  verification_flags?: OppSpecVerificationFlags;
  clone_from?: OppSpecCloneFrom;
}

export interface OppSpecFormFieldRule {
  /** Capped at 25 chars -- a longer name fails the WHOLE formset. */
  name: string;
  /** JSONPath into the HQ form-JSON doc (`form.group.q`), NOT an XForm XPath. */
  question_path: string;
  question_value: string;
  deliver_unit_id: number;
}

export interface OppSpecVerificationFlags {
  form_field_rules?: OppSpecFormFieldRule[];
  form_submission_start?: string;
  form_submission_end?: string;
}

export interface SpecIssue {
  /** `error` blocks the create; `warn` is advisory and the flow proceeds. */
  severity: 'error' | 'warn';
  code: string;
  field: string;
  message: string;
}

/** Values mirror `KNOWN_HQ_BASE_URLS` in `mcp/connect/hq-clusters.ts`. */
export const KNOWN_HQ_BASE_URLS = Object.values(HQ_BASE_URLS);

/** Cap on `form_field_rules[].name`. Enforced in `mcp/connect-server.ts`. */
export const FORM_FIELD_RULE_NAME_MAX = 25;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HQ_APP_ID_RE = /^[0-9a-f]{32}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
/** E.164: leading +, then 1-15 digits. */
const E164_RE = /^\+[1-9]\d{1,14}$/;
/** A `${VAR}` placeholder the MCP substitutes from env -- never a literal. */
const ENV_PLACEHOLDER_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Field names that must never carry a literal value in a spec file. A spec is
 * written to disk, may be committed, and is echoed into the run record -- so
 * "don't put a key here" cannot be prose. It is also the path the system
 * silently REWARDS: `resolveEnvSubstitution` returns early on any string with
 * no `$` in it, so an inlined key is forwarded verbatim and the create works.
 */
const SECRET_FIELD_RE = /^(api_?key|password|passwd|secret|token|plaintext_password)$/i;

const DEFAULT_FUND_USERS = 3;

/** Keys the spec format defines. Anything else is probably a typo. */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'organization_slug', 'program_id', 'name', 'short_description', 'description',
  'target_organization_slug', 'start_date', 'end_date', 'total_budget',
  'passing_score', 'is_test', 'learn_app', 'deliver_app', 'payment_units',
  'fund_users', 'invite_phone_numbers', 'verification_flags', 'clone_from',
]);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

type Bag = Record<string, unknown>;

const isBag = (v: unknown): v is Bag =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function push(
  issues: SpecIssue[],
  severity: SpecIssue['severity'],
  code: string,
  field: string,
  message: string,
): void {
  issues.push({ severity, code, field, message });
}

/** Present-and-non-empty. Deliberately allows `0` and `false`. */
function req(issues: SpecIssue[], field: string, value: unknown): boolean {
  if (value === undefined || value === null || value === '') {
    push(issues, 'error', 'missing_required_field', field,
      `\`${field}\` is required by connect_create_opportunity.`);
    return false;
  }
  return true;
}

function str(issues: SpecIssue[], field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    push(issues, 'error', 'wrong_type', field,
      `\`${field}\` must be a string, got ${describeType(value)}.`);
    return undefined;
  }
  return value;
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
  if (typeof v === 'object') return 'a mapping';
  return `a ${typeof v} (${JSON.stringify(v)})`;
}

/**
 * A finite number, or an issue. This is the fix for the fail-open class: the
 * earlier version returned early on a non-number and the capacity check was
 * gated on `typeof === 'number'`, so `total_budget: "900"` produced NO issue
 * at all and the flow proceeded to create.
 */
function num(issues: SpecIssue[], field: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    push(issues, 'error', 'not_a_number', field,
      `\`${field}\` must be a finite number, got ${describeType(value)}. ` +
      'A quoted number in YAML (`"900"`) is a string, and Connect stores these fields as ' +
      'integers -- so this must be caught here rather than becoming string arithmetic ' +
      'in the budget check.');
    return undefined;
  }
  return value;
}

/** A finite, non-negative integer in whole currency units. */
function money(issues: SpecIssue[], field: string, value: unknown): number | undefined {
  const n = num(issues, field, value);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) {
    push(issues, 'error', 'non_integer_currency', field,
      `\`${field}\` is ${n}. Connect stores amount / org_amount / total_budget as integers ` +
      'in whole currency units (PositiveIntegerField / PositiveBigIntegerField in ' +
      'commcare_connect/opportunity/models.py) and the serializer refuses floats. ' +
      'Round to a whole unit and log the rounding.');
    return undefined;
  }
  if (n < 0) {
    push(issues, 'error', 'negative_currency', field, `\`${field}\` must be non-negative.`);
    return undefined;
  }
  return n;
}

/** Does this string name a real calendar date, not just look like one? */
function isRealDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Normalize an HQ app id for comparison: ids are hex and case-insensitive. */
const normId = (s: string): string => s.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Rule groups
// ---------------------------------------------------------------------------

/**
 * Flag any secret-shaped key carrying a literal value, at the top level and
 * one level into the app blocks. A `${VAR}` placeholder is fine -- that is the
 * intended form, and the MCP's own name allowlist constrains what it may name.
 */
function checkSecrets(issues: SpecIssue[], spec: Bag): void {
  const scopes: Array<[string, unknown]> = [
    ['', spec],
    ['learn_app.', spec.learn_app],
    ['deliver_app.', spec.deliver_app],
  ];
  for (const [prefix, obj] of scopes) {
    if (!isBag(obj)) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (!SECRET_FIELD_RE.test(key)) continue;
      if (typeof value !== 'string' || value === '') continue;
      if (ENV_PLACEHOLDER_RE.test(value)) continue;
      // Never echo the value -- the point is keeping it out of transcripts.
      push(issues, 'error', 'inlined_secret', `${prefix}${key}`,
        `\`${prefix}${key}\` carries a literal value. Secrets never belong in a spec file: it ` +
        'is written to disk, may be committed, and is echoed into the run record. Use a ' +
        '`${VAR}` placeholder instead -- `${ACE_HQ_API_KEY}` for the HQ key -- which the MCP ' +
        'substitutes from $CLAUDE_PLUGIN_DATA/.env under its own name allowlist, so the value ' +
        'never reaches the model. If this key is real, rotate it: it has been on disk.');
    }
  }
}

function checkUnknownKeys(issues: SpecIssue[], spec: Bag): void {
  for (const key of Object.keys(spec)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) continue;
    if (SECRET_FIELD_RE.test(key)) continue; // already reported, with better advice
    push(issues, 'warn', 'unknown_key', key,
      `\`${key}\` is not part of the spec format and is ignored. If you meant one of ` +
      `${[...KNOWN_TOP_LEVEL_KEYS].join(', ')}, fix the spelling -- a misspelled key ` +
      'silently takes its default.');
  }
}

function checkIdentity(issues: SpecIssue[], spec: Bag): void {
  for (const f of ['organization_slug', 'program_id', 'name', 'short_description', 'description'] as const) {
    if (req(issues, f, spec[f])) str(issues, f, spec[f]);
  }

  const programId = typeof spec.program_id === 'string' ? spec.program_id : undefined;
  if (programId && !UUID_RE.test(programId.trim())) {
    push(issues, 'warn', 'program_id_shape', 'program_id',
      `\`program_id\` ("${programId}") is not UUID-shaped. Connect programs are addressed by ` +
      'UUID; an integer or a slug here will 404 at Step 1.');
  }

  const shortDesc = typeof spec.short_description === 'string' ? spec.short_description : undefined;
  if (shortDesc && shortDesc.length > SHORT_DESCRIPTION_MAX) {
    push(issues, 'error', 'short_description_too_long', 'short_description',
      `\`short_description\` is ${shortDesc.length} chars; the cap is ${SHORT_DESCRIPTION_MAX}. ` +
      'Nothing truncates: `Opportunity.short_description` is CharField(max_length=50) but the ' +
      'DRF serializer is mistyped 255, so a 51-255 char payload validates clean and then ' +
      'Postgres raises DataError inside transaction.atomic(), which the view does not catch -- ' +
      'surfacing as a Django 500 with no body. Bisected 2026-05-12: 49 chars -> 201, 51 -> 500. ' +
      'Put the long form in `description`.');
  }

  // NOTE: there is deliberately no `description` length rule. Earlier ACE
  // versions warned above ~250 chars citing jjackson/ace#106 finding 7, but
  // the MCP boundary records that observation as NOT reproduced under the
  // bisect protocol that proved the short_description trap, and says to treat
  // any "description 500" as suspect-misattribution. Re-warning on it here
  // would revive a retracted claim, which is the class CLAUDE.md's
  // refuted-citation rail exists to stop. `Opportunity.description` is a
  // TextField with no DB-enforced length.

  if (spec.is_test !== undefined && typeof spec.is_test !== 'boolean') {
    push(issues, 'error', 'wrong_type', 'is_test',
      `\`is_test\` must be true or false, got ${describeType(spec.is_test)}.`);
  }
  // The MCP boundary rejects this before any network call (ace#755); surfacing
  // it here only saves a round-trip -- it is not a second opinion.
  const name = typeof spec.name === 'string' ? spec.name : undefined;
  if (spec.is_test === true && name && !OPP_NAME_RUN_ID_PREFIX_RE.test(name)) {
    push(issues, 'error', 'invalid_opp_name_prefix', 'name',
      `\`is_test: true\` names must lead with a run-id prefix ("YYYYMMDD-HHMM · <display>", ` +
      `U+00B7 separator) -- got "${name}". Phase 6 mobile recipes anchor their opp-tile match ` +
      'on the run-id, so a missing prefix deterministically breaks claim/resume (ace#755). ' +
      'For a real, human-facing opportunity set `is_test: false`.');
  }
}

function checkWindow(issues: SpecIssue[], spec: Bag): void {
  const dates: Partial<Record<'start_date' | 'end_date', string>> = {};
  for (const f of ['start_date', 'end_date'] as const) {
    if (!req(issues, f, spec[f])) continue;
    const v = str(issues, f, spec[f]);
    if (v === undefined) continue;
    if (!DATE_RE.test(v)) {
      push(issues, 'error', 'bad_date_format', f, `\`${f}\` must be YYYY-MM-DD -- got "${v}".`);
      continue;
    }
    if (!isRealDate(v)) {
      // Without this, "2026-13-45" passes the shape check and then trips the
      // window comparison lexicographically -- telling the operator their
      // window is backwards when they actually typo'd a month.
      push(issues, 'error', 'impossible_date', f,
        `\`${f}\` is "${v}", which is not a real calendar date.`);
      continue;
    }
    dates[f] = v;
  }
  if (dates.start_date && dates.end_date && dates.start_date > dates.end_date) {
    push(issues, 'error', 'window_inverted', 'end_date',
      `\`end_date\` (${dates.end_date}) is before \`start_date\` (${dates.start_date}).`);
  }
}

function checkApps(issues: SpecIssue[], spec: Bag): void {
  const ids: Partial<Record<'learn_app' | 'deliver_app', string>> = {};
  for (const side of ['learn_app', 'deliver_app'] as const) {
    const app = spec[side];
    if (!req(issues, side, app)) continue;
    if (!isBag(app)) {
      push(issues, 'error', 'wrong_type', side,
        `\`${side}\` must be a mapping, got ${describeType(app)}.`);
      continue;
    }
    if (req(issues, `${side}.cc_domain`, app.cc_domain)) {
      str(issues, `${side}.cc_domain`, app.cc_domain);
    }
    if (req(issues, `${side}.cc_app_id`, app.cc_app_id)) {
      const id = str(issues, `${side}.cc_app_id`, app.cc_app_id);
      if (id !== undefined) {
        ids[side] = normId(id);
        if (!HQ_APP_ID_RE.test(id.trim())) {
          push(issues, 'warn', 'app_id_shape', `${side}.cc_app_id`,
            `\`${side}.cc_app_id\` should be a bare 32-char hex HQ app id -- got "${id}". ` +
            'A build id or a URL fragment here wires the opportunity to nothing, and app ' +
            'wiring is write-once at create.');
        }
      }
    }
    // Connect's form marks the Learn app description required; the create
    // fails without it. Inside the loop so it is suppressed when the app
    // object itself is missing.
    if (side === 'learn_app') req(issues, 'learn_app.description', app.description);

    // The atom requires hq_server_url (`z.string().url()`), so omitting it
    // fails at Step 4 -- the create/fix loop this validator exists to avoid.
    if (req(issues, `${side}.hq_server_url`, app.hq_server_url)) {
      const url = str(issues, `${side}.hq_server_url`, app.hq_server_url);
      if (url !== undefined && !KNOWN_HQ_BASE_URLS.includes(url)) {
        // An allowlist, not a formatting rule: this URL travels to Connect
        // alongside the resolved 40-char HQ API key, and Connect fetches from
        // it server-side, so an arbitrary host is an exfiltration path that
        // surfaces only as "Failed to fetch apps from CommCare HQ".
        push(issues, 'error', 'unknown_hq_host', `${side}.hq_server_url`,
          `\`${side}.hq_server_url\` is "${url}", which is not a known CommCare HQ cluster ` +
          `(${KNOWN_HQ_BASE_URLS.join(', ')}). This URL travels to Connect alongside the ` +
          'resolved HQ API key and Connect fetches from it server-side, so an unrecognised ' +
          'host is a credential-exfiltration path.');
      }
    }
  }

  if (ids.learn_app && ids.deliver_app && ids.learn_app === ids.deliver_app) {
    push(issues, 'error', 'same_app_both_sides', 'deliver_app.cc_app_id',
      '`learn_app.cc_app_id` and `deliver_app.cc_app_id` are the same app (compared ' +
      'case-insensitively -- HQ app ids are hex). The atom documents that these must differ ' +
      'and Connect validates it server-side.');
  }
}

function checkLearnGate(issues: SpecIssue[], spec: Bag): void {
  if (!req(issues, 'passing_score', spec.passing_score)) return;
  const s = num(issues, 'passing_score', spec.passing_score);
  if (s === undefined) return;
  if (!Number.isInteger(s) || s < 0 || s > 100) {
    push(issues, 'error', 'bad_passing_score', 'passing_score',
      `\`passing_score\` must be an integer 0-100 -- got ${s}.`);
  }
}

function checkMoney(issues: SpecIssue[], spec: Bag): void {
  req(issues, 'total_budget', spec.total_budget);
  const totalBudget = money(issues, 'total_budget', spec.total_budget);

  const fundUsersRaw = spec.fund_users;
  let fundUsers = DEFAULT_FUND_USERS;
  if (fundUsersRaw !== undefined && fundUsersRaw !== null) {
    const n = num(issues, 'fund_users', fundUsersRaw);
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
      push(issues, 'error', 'bad_fund_users', 'fund_users',
        `\`fund_users\` must be a positive integer -- got ${n}. It multiplies the remediation ` +
        'figure in the budget message, so a zero or negative value renders nonsense advice.');
    } else if (n !== undefined) {
      fundUsers = n;
    }
  }

  const rawUnits = spec.payment_units;
  if (rawUnits === undefined || rawUnits === null) {
    push(issues, 'error', 'no_payment_units', 'payment_units',
      "At least one payment unit is required: Connect's /activate/ endpoint validates that one " +
      'exists and rolls back the create when none does (ace#584), so an opportunity with no ' +
      'payment unit can never be activated and never accepts invites.');
    return;
  }
  if (!Array.isArray(rawUnits)) {
    // Omitting the `-` list dash is the commonest YAML authoring slip, and the
    // contract of this function is an issue list -- not a TypeError.
    push(issues, 'error', 'payment_units_not_a_list', 'payment_units',
      `\`payment_units\` must be a list, got ${describeType(rawUnits)}. Each entry needs a ` +
      'leading `- ` in YAML.');
    return;
  }
  if (rawUnits.length === 0) {
    push(issues, 'error', 'no_payment_units', 'payment_units',
      "At least one payment unit is required: Connect's /activate/ endpoint validates that one " +
      'exists and rolls back the create when none does (ace#584).');
    return;
  }

  const units: OppSpecPaymentUnit[] = [];
  const duToUnits = new Map<number, string[]>();

  rawUnits.forEach((raw, i) => {
    const at = `payment_units[${i}]`;
    if (!isBag(raw)) {
      push(issues, 'error', 'wrong_type', at,
        `\`${at}\` must be a mapping, got ${describeType(raw)}.`);
      return;
    }
    if (req(issues, `${at}.name`, raw.name)) str(issues, `${at}.name`, raw.name);
    req(issues, `${at}.amount`, raw.amount);
    req(issues, `${at}.max_total`, raw.max_total);
    const amount = money(issues, `${at}.amount`, raw.amount);
    const orgAmount = money(issues, `${at}.org_amount`, raw.org_amount);
    const maxTotal = money(issues, `${at}.max_total`, raw.max_total);
    money(issues, `${at}.max_daily`, raw.max_daily);

    if (maxTotal === 0) {
      push(issues, 'warn', 'zero_max_total', `${at}.max_total`,
        `\`${at}.max_total\` is 0, so this payment unit permits zero visits and contributes ` +
        'nothing to the capacity calculation. Probably not what you meant.');
    }

    // The hard pre-create gate. An empty required_deliver_units (a) fails the
    // opp's is_setup_complete, (b) blocks connect_send_flw_invite and the
    // Phase 6 device walk because the FLW cannot claim the opp, and (c) makes
    // synthetic accrual mint completed_works: 0 no matter how many visits
    // exist -- the engine attributes completed work to a unit's required DUs,
    // so with none there is nothing to attribute. Confirmed live on
    // hh-poverty-targeting/20260702-1456: a PU existed with
    // required_deliver_units: [] and produced 498 visits, 0 completed works
    // (jjackson/ace#843).
    const required = raw.required_deliver_units;
    if (!Array.isArray(required) || required.length === 0) {
      push(issues, 'error', 'no_required_deliver_units', `${at}.required_deliver_units`,
        `\`${at}.required_deliver_units\` must be a non-empty list of deliver-unit ` +
        '`server_id`s -- this is a hard pre-create gate, not a nicety. An empty list creates a ' +
        "payment unit that fails the opportunity's is_setup_complete, blocks FLW invites and " +
        'the device walk, and makes accrual report 0 completed works regardless of visit ' +
        'count (jjackson/ace#843: 498 visits, 0 completed works). Take the ids from the Step 4 ' +
        'create response\'s `deliver_app.deliver_units[].server_id` -- NOT `id`, which is a ' +
        'per-opp display index the server rejects as "Invalid Data".');
    } else {
      const optional = Array.isArray(raw.optional_deliver_units) ? raw.optional_deliver_units : [];
      for (const du of required) {
        if (typeof du !== 'number' || !Number.isInteger(du)) {
          push(issues, 'error', 'bad_deliver_unit_id', `${at}.required_deliver_units`,
            `\`${at}.required_deliver_units\` entries must be integer server_ids -- got ` +
            `${describeType(du)}.`);
          continue;
        }
        if (optional.includes(du)) {
          push(issues, 'error', 'deliver_unit_in_both_lists', `${at}.optional_deliver_units`,
            `Deliver unit ${du} appears in both \`required\` and \`optional\` on ${at}. ` +
            'Connect rejects the whole batch.');
        }
        const seen = duToUnits.get(du) ?? [];
        seen.push(at);
        duToUnits.set(du, seen);
      }
    }

    if (amount !== undefined && maxTotal !== undefined) {
      units.push({
        name: typeof raw.name === 'string' ? raw.name : '',
        amount,
        org_amount: orgAmount,
        max_total: maxTotal,
        required_deliver_units: [],
      });
    }
  });

  for (const [du, at] of duToUnits) {
    if (at.length < 2) continue;
    push(issues, 'error', 'deliver_unit_reused_across_units', 'payment_units',
      `Deliver unit ${du} is required by more than one payment unit (${at.join(', ')}) in the ` +
      'same request. Connect rejects the whole batch.');
  }

  // The capacity floor. Only computable when every contributing figure parsed;
  // when one did not, the `not_a_number` issue above is already blocking, so we
  // are not letting anything through silently.
  if (units.length !== rawUnits.length || totalBudget === undefined) return;

  const minOne = minBudgetForOneUser(units);
  if (minOne === 0) return; // a free opportunity funds anyone
  if (!fundsAtLeastOneUser(totalBudget, units)) {
    const users = numberOfUsers(totalBudget, units);
    push(issues, 'error', 'opportunity_underfunded', 'total_budget',
      `total_budget ${totalBudget} funds ${users.toFixed(4)} FLW (< 1). Connect computes ` +
      'number_of_users = total_budget / SUM(max_total * (amount + org_amount)) = ' +
      `${totalBudget} / ${minOne}; below 1 it under-allocates create_claim_limits and no FLW ` +
      `can claim. Raise total_budget to at least ${minOne * fundUsers} ` +
      `(x${fundUsers} headroom), or lower max_total. If you passed cents you inflated the ` +
      'per-user cost 100x -- pass whole units.');
    return;
  }
  const users = numberOfUsers(totalBudget, units);
  if (users < fundUsers) {
    push(issues, 'warn', 'thin_headroom', 'total_budget',
      `total_budget funds ${users.toFixed(2)} FLW; \`fund_users\` asks for ${fundUsers}. ` +
      `Raise to ${minOne * fundUsers} for headroom.`);
  }
}

function checkInvites(issues: SpecIssue[], spec: Bag): void {
  const raw = spec.invite_phone_numbers;
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) {
    push(issues, 'error', 'wrong_type', 'invite_phone_numbers',
      `\`invite_phone_numbers\` must be a list, got ${describeType(raw)}.`);
    return;
  }
  raw.forEach((phone, i) => {
    const at = `invite_phone_numbers[${i}]`;
    if (typeof phone !== 'string' || phone === '') {
      push(issues, 'error', 'bad_invite_phone', at, `\`${at}\` must be a non-empty string.`);
      return;
    }
    if (ENV_PLACEHOLDER_RE.test(phone) || E164_RE.test(phone)) return;
    push(issues, 'error', 'bad_invite_phone', at,
      `"${phone}" is not E.164 (leading +, then 1-15 digits) and not a \`\${VAR}\` placeholder. ` +
      'connect_send_flw_invite returns {status: "queued"} regardless, and `queued` is not proof ' +
      'the invite landed (ace#824) -- so a malformed number fails silently and the worker ' +
      'simply never gets an invite.');
  });
}

function checkVerificationFlags(issues: SpecIssue[], spec: Bag): void {
  const flags = spec.verification_flags;
  if (flags === undefined || flags === null) return;
  if (!isBag(flags)) {
    push(issues, 'error', 'wrong_type', 'verification_flags',
      `\`verification_flags\` must be a mapping, got ${describeType(flags)}.`);
    return;
  }
  for (const f of ['form_submission_start', 'form_submission_end'] as const) {
    const v = flags[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !TIME_RE.test(v)) {
      push(issues, 'error', 'bad_submission_time', `verification_flags.${f}`,
        `\`verification_flags.${f}\` must be HH:MM:SS -- got ${describeType(v)}.`);
    }
  }
  const rules = flags.form_field_rules;
  if (rules === undefined || rules === null) return;
  if (!Array.isArray(rules)) {
    push(issues, 'error', 'wrong_type', 'verification_flags.form_field_rules',
      `\`verification_flags.form_field_rules\` must be a list, got ${describeType(rules)}.`);
    return;
  }
  rules.forEach((raw, i) => {
    const at = `verification_flags.form_field_rules[${i}]`;
    if (!isBag(raw)) {
      push(issues, 'error', 'wrong_type', at, `\`${at}\` must be a mapping.`);
      return;
    }
    const name = str(issues, `${at}.name`, raw.name);
    if (name !== undefined && name.length > FORM_FIELD_RULE_NAME_MAX) {
      push(issues, 'error', 'rule_name_too_long', `${at}.name`,
        `\`${at}.name\` is ${name.length} chars; the cap is ${FORM_FIELD_RULE_NAME_MAX}. ` +
        'A longer name fails the WHOLE formset, not just this rule.');
    }
    const path = str(issues, `${at}.question_path`, raw.question_path);
    if (path !== undefined && path.startsWith('/')) {
      push(issues, 'error', 'xpath_not_jsonpath', `${at}.question_path`,
        `\`${at}.question_path\` is "${path}", an XForm XPath. Connect evaluates it as a ` +
        'JSONPath into the forwarded HQ form-JSON doc, in which the instance is nested under ' +
        '`form` -- so `/data/group/q` is written `form.group.q`. An XPath makes the parse ' +
        'raise, the HQ->Connect forward 500s, and every payable visit is lost while the device ' +
        'still shows "1 form sent to server!" (ace#1301, spark-facilitator/20260813-2126).');
    }
    req(issues, `${at}.question_value`, raw.question_value);
    if (raw.deliver_unit_id !== undefined) num(issues, `${at}.deliver_unit_id`, raw.deliver_unit_id);
  });
}

/**
 * The clone app-reuse traps. Both are invisible until late and neither is
 * recoverable in place, which is why they are code rather than prose.
 */
function checkClone(issues: SpecIssue[], spec: Bag): void {
  const clone = spec.clone_from;
  if (clone === undefined || clone === null) return;
  if (!isBag(clone)) {
    push(issues, 'error', 'wrong_type', 'clone_from',
      `\`clone_from\` must be a mapping, got ${describeType(clone)}.`);
    return;
  }
  req(issues, 'clone_from.opportunity_id', clone.opportunity_id);

  const learnId = typeof spec.learn_app === 'object' && spec.learn_app !== null
    ? (spec.learn_app as Bag).cc_app_id : undefined;
  const deliverId = typeof spec.deliver_app === 'object' && spec.deliver_app !== null
    ? (spec.deliver_app as Bag).cc_app_id : undefined;

  const cases: Array<{
    field: string; source: unknown; next: unknown; code: string; message: string;
  }> = [
    {
      field: 'deliver_app.cc_app_id',
      source: clone.source_deliver_app_id,
      next: deliverId,
      code: 'clone_reuses_deliver_app',
      message:
        "Clone reuses the source opportunity's Deliver app. Connect keys DeliverUnit on the " +
        'released app, not on the opportunity, so the new opp cannot create a payment unit ' +
        '("Invalid or already-assigned deliver unit IDs"), there is no ' +
        'connect_delete_payment_unit atom, and an opp with no payment unit can never activate ' +
        '(jjackson/ace#573). Mint a fresh app id with commcare_linked_app_copy, then build and ' +
        'release it.',
    },
    {
      field: 'learn_app.cc_app_id',
      source: clone.source_learn_app_id,
      next: learnId,
      code: 'clone_reuses_learn_app',
      message:
        "Clone reuses the source opportunity's Learn app. Connect keys CommCareApp on " +
        '(cc_app_id, cc_domain, organization, hq_server) and the create path runs get_or_create ' +
        'with update_existing=False, so the posted passing_score is silently discarded and the ' +
        "new opp inherits the source opp's gate (jjackson/ace#1350). Mint a fresh app id with " +
        'commcare_linked_app_copy.',
    },
  ];

  for (const c of cases) {
    if (typeof c.source !== 'string' || typeof c.next !== 'string') continue;
    if (normId(c.source) !== normId(c.next)) continue;
    push(issues, 'error', c.code, c.field, c.message);
  }

  // The guard above can only fire on provenance the operator supplied, and
  // provenance is an editable field -- so its absence is worth saying out
  // loud rather than passing clean. The live check (comparing against the
  // apps other opportunities on this program already use) belongs at Step 1,
  // which has the hydrated listing; this validator cannot see it.
  const missing = (['source_learn_app_id', 'source_deliver_app_id'] as const)
    .filter((k) => typeof clone[k] !== 'string' || clone[k] === '');
  if (missing.length > 0) {
    push(issues, 'warn', 'clone_without_provenance', 'clone_from',
      `\`clone_from\` omits ${missing.join(' and ')}, so the app-reuse check cannot run for ` +
      'that side. Those two traps (ace#573, ace#1350) are the reason the clone path mints ' +
      'fresh apps; without the source ids nothing here can tell whether it did. Re-hydrate ' +
      'with `--clone`, or verify at Step 1 against the apps this program already uses.');
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validate a standalone opportunity spec. Takes `unknown` -- see the header.
 * Returns every issue found; the caller creates nothing while any
 * `severity: 'error'` remains.
 */
export function validateConnectOppSpec(raw: unknown): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!isBag(raw)) {
    push(issues, 'error', 'spec_not_a_mapping', '',
      `The spec must be a YAML mapping, got ${describeType(raw)}.`);
    return issues;
  }
  checkSecrets(issues, raw);
  checkUnknownKeys(issues, raw);
  checkIdentity(issues, raw);
  checkWindow(issues, raw);
  checkApps(issues, raw);
  checkLearnGate(issues, raw);
  checkMoney(issues, raw);
  checkInvites(issues, raw);
  checkVerificationFlags(issues, raw);
  checkClone(issues, raw);
  return issues;
}

/** Convenience: does this spec have any blocking issue? */
export function hasBlockingIssue(issues: SpecIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** Render issues for an operator, errors first. */
export function formatSpecIssues(issues: SpecIssue[]): string {
  if (issues.length === 0) return 'spec OK - no issues.';
  const order = { error: 0, warn: 1 } as const;
  return [...issues]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((i) => `[${i.severity.toUpperCase()}] ${i.field} (${i.code}): ${i.message}`)
    .join('\n');
}
