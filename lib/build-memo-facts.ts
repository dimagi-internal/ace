//
// The FACT SHEET build-memo-eval grades the memo against.
//
// The build memo is the run's review artifact — ace-web's public summary
// renders it first — and before this nothing judged it: build-memo's own
// checks are completeness (every producer section present), which a memo that
// misstates the build passes. `build-memo-eval`'s fitness dimension asks
// "does what the memo says match what was BUILT?", so it needs what was built
// from somewhere other than the memo: this module assembles that, from
// run_state (written by the producers as each object was minted) and, when
// the skill passes them, LIVE Connect reads. The memo's own claims are never
// an input here.
//
// Pure. Every fact carries its source, so a judge's finding can cite it.

export interface BuildFact {
  /** Stable key, e.g. `opportunity.end_date`. */
  key: string;
  /** Human label for the verdict note. */
  label: string;
  value: string;
  /** Where the value came from — `run_state` or `live:<atom>`. */
  source: string;
}

export interface LiveConnect {
  /** `connect_get_opportunity` result. */
  opportunity?: Record<string, unknown> | null;
  /** `connect_list_payment_units().payment_units`. */
  paymentUnits?: Array<Record<string, unknown>> | null;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function buildMemoFacts(runState: unknown, live: LiveConnect = {}): BuildFact[] {
  const facts: BuildFact[] = [];
  const add = (key: string, label: string, value: unknown, source: string) => {
    const v = s(value);
    if (v) facts.push({ key, label, value: v, source });
  };
  const phases = rec(rec(runState).phases);
  const root = rec(runState);
  // Run identity: a forked run inherits its source's memo, and a memo still
  // titled with the SOURCE run id misattributes every fact in it
  // (spark-facilitator/20260926-1800, forked from 20260925-1536).
  add('run.run_id', 'run id', root.run_id, 'run_state');
  add('run.forked_from', 'forked from run', root.forked_from, 'run_state');

  const apps = rec(rec(rec(phases['commcare-setup']).products).apps);
  for (const kind of ['learn', 'deliver'] as const) {
    const a = rec(apps[kind] ?? apps[`${kind}_app`]);
    add(`apps.${kind}.name`, `${kind} app name`, a.name, 'run_state');
    add(`apps.${kind}.released_version`, `${kind} app released version`, a.released_version, 'run_state');
    add(`apps.${kind}.build_status`, `${kind} app build status`, a.build_status, 'run_state');
  }

  const connect = rec(rec(rec(phases['connect-setup']).products).connect);
  const opp = rec(connect.opportunity);
  add('opportunity.name', 'opportunity name', opp.name, 'run_state');
  add('opportunity.is_test', 'opportunity is_test', opp.is_test, 'run_state');
  add('org.holding', 'holding org', connect.holding_org_slug ?? connect.organization_slug, 'run_state');
  add('org.mode', 'org mode', connect.org_mode, 'run_state');

  const pus = Array.isArray(connect.payment_units) ? (connect.payment_units as unknown[]) : [];
  pus.forEach((raw, i) => {
    const p = rec(raw);
    const label = s(p.name) || `payment unit ${i + 1}`;
    add(`payment_units.${i}.name`, 'payment unit', p.name, 'run_state');
    add(`payment_units.${i}.amount`, `${label} — worker amount`, p.amount !== undefined ? `${s(p.amount)} ${s(p.currency)}`.trim() : '', 'run_state');
    add(`payment_units.${i}.org_amount`, `${label} — organisation amount`, p.org_amount !== undefined ? `${s(p.org_amount)} ${s(p.currency)}`.trim() : '', 'run_state');
    add(`payment_units.${i}.max_total`, `${label} — max total per worker`, p.max_total, 'run_state');
    add(`payment_units.${i}.max_daily`, `${label} — max per day`, p.max_daily, 'run_state');
  });

  const v = rec(connect.verification);
  const rules = Array.isArray(v.form_field_rules) ? (v.form_field_rules as unknown[]) : [];
  if (connect.verification !== undefined) add('verification.rules_written', 'verification rules written to Connect', rules.length, 'run_state');
  add('verification.rules_saved', 'verification rules Connect persisted', v.form_field_rules_saved, 'run_state');
  add('verification.not_applied_reason', 'verification rules NOT applied because', v.not_applied_reason, 'run_state');

  const tu = rec(connect.ace_test_user);
  add('test_user.invite_row_present', 'ACE test user invited', tu.invite_row_present, 'run_state');

  const lo = live.opportunity ? rec(live.opportunity) : null;
  if (lo) {
    for (const [k, label] of [
      ['name', 'opportunity name'],
      ['active', 'opportunity active'],
      ['is_test', 'opportunity is_test'],
      ['start_date', 'opportunity start date'],
      ['end_date', 'opportunity end date'],
      ['total_budget', 'opportunity total budget'],
      ['currency', 'currency'],
      ['program_name', 'program name'],
    ] as const) {
      add(`live.opportunity.${k}`, label, lo[k], 'live:connect_get_opportunity');
    }
  }
  if (Array.isArray(live.paymentUnits)) {
    add('live.payment_units.count', 'payment units on Connect', live.paymentUnits.length, 'live:connect_list_payment_units');
    live.paymentUnits.forEach((p, i) => add(`live.payment_units.${i}.name`, 'payment unit on Connect', rec(p).name, 'live:connect_list_payment_units'));
  }
  return facts;
}

/** The fact sheet as a markdown table, for the judge prompt and the verdict's audit trail. */
export function renderFactSheet(facts: readonly BuildFact[]): string {
  const rows = facts.map((f) => `| ${f.label} | ${f.value.replace(/\|/g, '\\|')} | ${f.source} |`);
  return ['| Fact | Value | Source |', '|---|---|---|', ...rows].join('\n');
}
