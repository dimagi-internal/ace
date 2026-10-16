/**
 * The FACT half of `connect-opp-setup-eval`, as code: diff what the PDD's typed
 * handoff (`## Program Parameters`) and the run's own records declare against
 * what Connect's API holds.
 *
 * Four of the rubric's six dimensions are comparisons, so they are computed
 * here (see `lib/deterministic-verdict.ts` for why the fact-check evals stopped
 * being LLM judges). The two that need judgment — `deployability` (rate vs a
 * REAL regional day-rate benchmark, threshold survivability in the field) and
 * `archetype_config_coherence` (cross-dimension fit, and whether every PDD
 * Layer A predicate found a home) — stay with the skill's LLM pass and are
 * handed in as `residue`.
 *
 * | dimension                   | weight | evidence |
 * |-----------------------------|--------|----------|
 * | verification_flag_fidelity  | 0.20   | `products.connect.opportunity.verification` — decided `form_field_rules` vs `form_field_rules_saved` (Connect has NO read surface for rules, so the persisted count is the only evidence); each rule's shape (25-char name cap, JSONPath not XPath — ace#1301, string predicate — ace#2296, a live DU id) |
 * | payment_unit_fit            | 0.16   | live `connect_list_payment_units` count vs the archetype's PU shape (one for the whole arc on `longitudinal-visits`, ace#2294); the CREATE response's `amount` / `max_daily` / `max_total` / `required_deliver_units` vs `payment_rate_*`, `daily_cap_per_flw`, `total_cap_per_flw` (the list read cannot see those — ace#1026) |
 * | deliver_unit_wiring         | 0.16   | live `connect_list_deliver_units` slugs vs the PDD-payable slugs; `deliver_app.cc_app_id` vs the deployed HQ Deliver app; PU `required_deliver_units` ⊆ live DU server ids |
 * | active_window_status        | 0.16   | `checkOppPostcondition` (is_test, activation proven by an invite row — ace#617); window length vs `opportunity_{start,end}_date` ±10% |
 *
 * Verification flags `gps` / `duplicate` / `gps_radius_meters` /
 * `catchment_areas` / `check_attachments` are NOT graded: Connect's form no
 * longer has them and the atom refuses them (ace#1013), so "the PDD wants GPS
 * ≤ 50 m" has no Connect-side state to diff — it is a `[PLATFORM]` gap the
 * coherence residue weighs, not a fidelity miss.
 */
import type { AutoSurfaced, CheckRecord, Verdict } from './verdict-schema.js';
import { checkOppPostcondition } from './connect-opp-postcondition.js';
import { readProgramParameter } from './payment-grain.js';
import { opportunityWindow } from './opportunity-window.js';
import { composeVerdict, incompleteVerdict, parseResidue, type ScoredDimension } from './deterministic-verdict.js';

export const OPP_DETERMINISTIC_WEIGHTS = {
  verification_flag_fidelity: 0.2,
  payment_unit_fit: 0.16,
  deliver_unit_wiring: 0.16,
  active_window_status: 0.16,
} as const;
export const OPP_RESIDUE_WEIGHTS = {
  deployability: 0.22,
  archetype_config_coherence: 0.1,
} as const;

export interface FormFieldRuleRecord {
  name?: string;
  question_path?: string;
  question_value?: unknown;
  deliver_unit_id?: string | number;
}

export interface OppConfigInput {
  target: string;
  archetype?: string;
  /** Markdown export of the PDD (`readProgramParameter` needs the table). */
  pddText?: string | null;
  /** `run_state.yaml` `phases.connect-setup.products.connect`. */
  products?: {
    opportunity?: {
      id?: string;
      verification?: { form_field_rules?: FormFieldRuleRecord[]; form_field_rules_saved?: number | null };
    };
  } | null;
  /** `connect_get_opportunity` result; null = the read failed. */
  opportunity: Record<string, unknown> | null;
  /** `connect_list_payment_units` rows; null = the read failed. */
  paymentUnits: Array<Record<string, unknown>> | null;
  /** `connect_create_payment_units` response rows, when the run recorded them (authoritative for amounts/caps/DUs). */
  createdPaymentUnits?: Array<Record<string, unknown>> | null;
  /** `connect_list_deliver_units` rows; null = the read failed. */
  deliverUnits: Array<Record<string, unknown>> | null;
  /** `connect_list_flw_invites({phone})` — `{match}`; null = the read failed. */
  testUserInvite: { match: unknown } | null;
  /** Deliver-unit slugs the PDD declares payable (CCZ projection / app-connect-coverage). */
  payableDeliverSlugs?: string[];
  /** The HQ Deliver app id `app-deploy` recorded. */
  expectedHqDeliverAppId?: string;
  /** Override for the expected payment-unit count. */
  expectedPaymentUnitCount?: number;
  /** Judgment dimensions from the skill's LLM pass. Required to compose the final verdict. */
  residue?: unknown;
  ranAt?: string;
}

export interface OppFactsResult {
  dimensions: Record<string, ScoredDimension>;
  autoSurfaced: AutoSurfaced[];
  checks: CheckRecord[];
  liveStateVerified: boolean;
  degraded: boolean;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function param(pdd: string | null | undefined, key: string): string | null {
  return pdd ? readProgramParameter(pdd, key) : null;
}

/** The archetype's payment-unit shape (connect-opp-setup-eval § payment_unit_fit). */
export function expectedPaymentUnitCount(archetype: string | undefined, payableSlugs: string[] | undefined): number {
  if (archetype === 'multi-stage') return Math.max(1, payableSlugs?.length ?? 1);
  return 1; // atomic-visit / focus-group: one per delivery/session; longitudinal: ONE for the whole arc (ace#2294)
}

export function checkOppConfigFacts(input: OppConfigInput): OppFactsResult {
  const auto: AutoSurfaced[] = [];
  const checks: CheckRecord[] = [];
  const oppId = String(input.products?.opportunity?.id ?? input.opportunity?.id ?? '');
  const degraded = /TBD-MANUAL/i.test(oppId);
  const live = input.opportunity !== null && input.paymentUnits !== null && input.deliverUnits !== null;
  for (const [name, v] of [['connect_get_opportunity', input.opportunity], ['connect_list_payment_units', input.paymentUnits], ['connect_list_deliver_units', input.deliverUnits]] as const) {
    if (v === null) {
      checks.push({ name, status: 'unable', reason: `${name} failed at grading time` });
      auto.push({ severity: 'PLATFORM', message: `${name} failed at grading time — dependent sub-checks unverified` });
    } else checks.push({ name, status: 'checked' });
  }

  const liveDuIds = new Set(
    (input.deliverUnits ?? []).map((d) => String(d.server_id ?? d.id ?? '')).filter(Boolean),
  );
  const liveDuSlugs = (input.deliverUnits ?? []).map((d) => String(d.slug ?? '')).filter(Boolean);

  // ── verification_flag_fidelity ────────────────────────────────────────
  let vf = 10;
  const vfNotes: string[] = [];
  const ver = input.products?.opportunity?.verification;
  const rules = ver?.form_field_rules ?? [];
  const saved = ver?.form_field_rules_saved ?? null;
  if (!rules.length) {
    vfNotes.push('no form_field_rules decided — whether the PDD Layer A needed one is graded in archetype_config_coherence');
    auto.push({ severity: 'INFO', message: 'no Connect form_field_rules were decided; Layer A coverage is a judgment call (coherence residue)' });
  } else {
    if (saved === null) {
      vf -= 2 * rules.length;
      vfNotes.push(`${rules.length} rule(s) decided, no form_field_rules_saved recorded — persistence unproven`);
      auto.push({ severity: 'WARN', message: `${rules.length} form_field_rule(s) decided but no form_field_rules_saved recorded — Connect has no read surface, so the write is unproven` });
    } else if (saved < rules.length) {
      vf -= 2 * (rules.length - saved);
      vfNotes.push(`${saved} of ${rules.length} rule(s) persisted`);
      auto.push({ severity: 'WARN', message: `only ${saved} of ${rules.length} decided form_field_rules persisted on Connect` });
    }
    for (const r of rules) {
      const label = r.name ?? r.question_path ?? '(unnamed rule)';
      if ((r.name ?? '').length > 25) {
        vf -= 2;
        auto.push({ severity: 'WARN', message: `form_field_rule "${label}" name exceeds Connect's 25-char cap — the whole formset silently fails` });
      }
      const path = r.question_path ?? '';
      if (!/^form\./.test(path)) {
        vf = Math.min(vf, 3);
        auto.push({ severity: 'BLOCKER', message: `form_field_rule "${label}" question_path "${path}" is not a JSONPath under form.* — Connect's receiver 500s on every payable visit (ace#1301)` });
      }
      if (typeof r.question_value !== 'string' || !r.question_value) {
        vf -= 2;
        auto.push({ severity: 'WARN', message: `form_field_rule "${label}" question_value is ${JSON.stringify(r.question_value)} — the payability predicate must be a quoted string (ace#2296)` });
      }
      if (input.deliverUnits && r.deliver_unit_id !== undefined && liveDuIds.size && !liveDuIds.has(String(r.deliver_unit_id))) {
        vf -= 2;
        auto.push({ severity: 'WARN', message: `form_field_rule "${label}" targets deliver_unit_id ${String(r.deliver_unit_id)}, which is not a live deliver unit on this opportunity` });
      }
    }
    if (!vfNotes.length) vfNotes.push(`${rules.length} rule(s) decided and persisted, shapes valid`);
  }
  checks.push({ name: 'form-field-rules', status: 'checked' });

  // ── payment_unit_fit ──────────────────────────────────────────────────
  let pu = 10;
  const puNotes: string[] = [];
  const expectedCount = input.expectedPaymentUnitCount ?? expectedPaymentUnitCount(input.archetype, input.payableDeliverSlugs);
  if (input.paymentUnits) {
    if (input.paymentUnits.length !== expectedCount) {
      pu -= 3;
      puNotes.push(`${input.paymentUnits.length} payment unit(s) live, ${expectedCount} expected for ${input.archetype ?? 'the archetype'}`);
      auto.push({ severity: 'WARN', message: `payment-unit count ${input.paymentUnits.length} ≠ ${expectedCount} expected for archetype ${input.archetype ?? '(unstated)'}` });
    }
  }
  const created = input.createdPaymentUnits ?? null;
  const rateMin = num(param(input.pddText, 'payment_rate_min'));
  const rateMax = num(param(input.pddText, 'payment_rate_max'));
  const dailyCap = num(param(input.pddText, 'daily_cap_per_flw'));
  const totalCap = num(param(input.pddText, 'total_cap_per_flw'));
  if (!created || !created.length) {
    checks.push({ name: 'payment-unit-create-response', status: 'unable', reason: 'no connect_create_payment_units response supplied — amounts, caps and DU wiring cannot be read back from the list atom (ace#1026)' });
    auto.push({ severity: 'INFO-SKIPPED', message: 'payment-unit amount/cap/DU checks skipped: no create response supplied (the list read cannot see those fields)' });
  } else {
    checks.push({ name: 'payment-unit-create-response', status: 'checked' });
    for (const row of created) {
      const name = String(row.name ?? '(unnamed PU)');
      const amount = num(row.amount);
      if (amount !== null && rateMin !== null && rateMax !== null && (amount < rateMin || amount > rateMax)) {
        pu -= 3;
        auto.push({ severity: 'WARN', message: `PU "${name}" amount ${amount} is outside the PDD band ${rateMin}–${rateMax}` });
      }
      if (dailyCap !== null && num(row.max_daily) !== null && num(row.max_daily) !== dailyCap) {
        pu -= 2;
        auto.push({ severity: 'WARN', message: `PU "${name}" max_daily ${String(row.max_daily)} ≠ PDD daily_cap_per_flw ${dailyCap}` });
      }
      if (totalCap !== null && num(row.max_total) !== null && num(row.max_total) !== totalCap) {
        pu -= 2;
        auto.push({ severity: 'WARN', message: `PU "${name}" max_total ${String(row.max_total)} ≠ PDD total_cap_per_flw ${totalCap}` });
      }
      const req = Array.isArray(row.required_deliver_units) ? row.required_deliver_units : [];
      if (!req.length) {
        pu = Math.min(pu, 3);
        auto.push({ severity: 'BLOCKER', message: `PU "${name}" has no required_deliver_units in the create response — the opp is not setup-complete and synthetic accrual mints 0 completed works (ace#843)` });
      }
    }
    if (rateMin === null || rateMax === null) auto.push({ severity: 'INFO-SKIPPED', message: 'PDD declares no payment_rate_min/max — amount band not checked' });
  }
  const oppCurrency = input.opportunity ? String(input.opportunity.currency ?? '') : '';
  const pddCurrency = param(input.pddText, 'opportunity_currency');
  if (oppCurrency && pddCurrency && oppCurrency.toUpperCase() !== pddCurrency.trim().toUpperCase()) {
    pu -= 3;
    auto.push({ severity: 'WARN', message: `opportunity currency ${oppCurrency} ≠ PDD opportunity_currency ${pddCurrency} — every amount is mispriced` });
  }
  if (!puNotes.length) puNotes.push(`${input.paymentUnits?.length ?? '?'} payment unit(s); amounts/caps ${created?.length ? 'match the PDD' : 'not read back'}`);

  // ── deliver_unit_wiring ───────────────────────────────────────────────
  let du = 10;
  const duNotes: string[] = [];
  if (input.deliverUnits) {
    if (!input.deliverUnits.length) {
      du = Math.min(du, 3);
      auto.push({ severity: 'BLOCKER', message: 'Connect lists ZERO deliver units on the opportunity — no visit can be credited' });
    }
    for (const s of input.payableDeliverSlugs ?? []) {
      if (liveDuSlugs.length && !liveDuSlugs.includes(s)) {
        du -= 4;
        auto.push({ severity: 'WARN', message: `PDD-payable deliver unit "${s}" is not on the Connect opportunity` });
      }
    }
    if (!input.payableDeliverSlugs?.length) auto.push({ severity: 'INFO-SKIPPED', message: 'no PDD-payable slug list supplied — deliver-unit name match not checked' });
  }
  const deliverApp = (input.opportunity?.deliver_app ?? null) as { cc_app_id?: string } | null;
  if (input.expectedHqDeliverAppId && deliverApp?.cc_app_id && deliverApp.cc_app_id !== input.expectedHqDeliverAppId) {
    du = Math.min(du, 3);
    auto.push({ severity: 'BLOCKER', message: `opportunity's Deliver app is ${deliverApp.cc_app_id}, but app-deploy recorded ${input.expectedHqDeliverAppId} — visits would be credited against the wrong app` });
  }
  if (created?.length && liveDuIds.size) {
    for (const row of created) {
      for (const id of Array.isArray(row.required_deliver_units) ? row.required_deliver_units : []) {
        if (!liveDuIds.has(String(id))) {
          du -= 3;
          auto.push({ severity: 'WARN', message: `PU "${String(row.name)}" requires deliver unit ${String(id)}, which is not a live deliver unit on the opportunity` });
        }
      }
    }
  }
  duNotes.push(`${input.deliverUnits?.length ?? '?'} live deliver unit(s)`);

  // ── active_window_status ──────────────────────────────────────────────
  let aw = 10;
  const awNotes: string[] = [];
  const post = checkOppPostcondition(
    {
      opportunity: input.opportunity as never,
      paymentUnits: input.paymentUnits as never,
      testUserInvite: input.testUserInvite,
    },
    { paymentUnitNames: (input.paymentUnits ?? []).map((p) => String(p.name ?? '')), formFieldRulesExpected: 0, formFieldRulesSaved: null, expectActive: true, expectTestUserInvited: false },
  );
  for (const c of post.checks.filter((c) => c.id === 'is_test' || c.id === 'activated')) {
    if (!c.pass) {
      aw = Math.min(aw, 3);
      auto.push({ severity: 'BLOCKER', message: `${c.id}: ${c.detail}` });
    }
    awNotes.push(`${c.id}: ${c.pass ? 'ok' : 'FAIL'}`);
  }
  const ps = param(input.pddText, 'opportunity_start_date');
  const pe = param(input.pddText, 'opportunity_end_date');
  const os = input.opportunity?.start_date;
  const oe = input.opportunity?.end_date;
  if (ps && pe && typeof os === 'string' && typeof oe === 'string') {
    try {
      const want = opportunityWindow(ps.slice(0, 10), pe.slice(0, 10)).days;
      const have = opportunityWindow(os.slice(0, 10), oe.slice(0, 10)).days;
      if (have < want * 0.9) {
        aw -= 2;
        auto.push({ severity: 'WARN', message: `opportunity window ${have} days is shorter than the PDD's ${want} (±10%) — truncates the planned programme` });
      } else if (have > want * 1.1) {
        aw -= 0.5;
        auto.push({ severity: 'INFO', message: `opportunity window ${have} days is longer than the PDD's ${want}` });
      }
      awNotes.push(`window ${have}d vs PDD ${want}d`);
      checks.push({ name: 'active-window', status: 'checked' });
    } catch (e) {
      checks.push({ name: 'active-window', status: 'unable', reason: String((e as Error).message) });
    }
  } else {
    checks.push({ name: 'active-window', status: 'unable', reason: 'PDD opportunity_start_date/end_date or the live start/end dates are absent' });
    auto.push({ severity: 'INFO-SKIPPED', message: 'active-window length not compared: PDD or Connect dates absent' });
  }

  return {
    degraded,
    liveStateVerified: live,
    autoSurfaced: auto,
    checks,
    dimensions: {
      verification_flag_fidelity: { score: Math.max(0, vf), weight: OPP_DETERMINISTIC_WEIGHTS.verification_flag_fidelity, source: 'deterministic', note: vfNotes.join('; ') },
      payment_unit_fit: { score: Math.max(0, pu), weight: OPP_DETERMINISTIC_WEIGHTS.payment_unit_fit, source: 'deterministic', note: puNotes.join('; ') },
      deliver_unit_wiring: { score: Math.max(0, du), weight: OPP_DETERMINISTIC_WEIGHTS.deliver_unit_wiring, source: 'deterministic', note: duNotes.join('; ') },
      active_window_status: { score: Math.max(0, aw), weight: OPP_DETERMINISTIC_WEIGHTS.active_window_status, source: 'deterministic', note: awNotes.join('; ') },
    },
  };
}

/**
 * The full `connect-opp-setup-eval` verdict: the facts above plus the judgment
 * residue. A missing / malformed residue throws — the skill must grade
 * deployability (it carries the out-of-chain hard-gate) rather than let the
 * fact half pass alone.
 */
export function checkConnectOppSetup(input: OppConfigInput): Verdict {
  const capturePath = '4-connect/connect-opp-setup_summary.md';
  const facts = checkOppConfigFacts(input);
  if (facts.degraded) {
    return incompleteVerdict({
      skill: 'connect-opp-setup-eval',
      target: input.target,
      capturePath,
      ranAt: input.ranAt,
      dimensionWeights: { ...OPP_RESIDUE_WEIGHTS, ...OPP_DETERMINISTIC_WEIGHTS },
      reason: 'degraded-mode artifacts (connect_opportunity_id: TBD-MANUAL); not gradable as Connect-real',
    });
  }
  const residue = parseResidue(input.residue, { ...OPP_RESIDUE_WEIGHTS });
  const auto = [...facts.autoSurfaced];
  if (residue.deployability.score <= 3) auto.push({ severity: 'BLOCKER', message: `deployability hard-gate: ${residue.deployability.note}` });
  return composeVerdict({
    skill: 'connect-opp-setup-eval',
    target: input.target,
    capturePath,
    ranAt: input.ranAt,
    dimensions: { ...residue, ...facts.dimensions },
    autoSurfaced: auto,
    checks: facts.checks,
    liveStateVerified: facts.liveStateVerified,
  });
}
