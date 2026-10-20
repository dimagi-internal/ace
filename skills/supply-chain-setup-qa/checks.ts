/**
 * Static QA checks for `supply-chain-setup-qa`.
 *
 * The artifact is ONE JSON document: `{plan, readback}`.
 *   - `plan` is `supply-chain-setup`'s plan file (what it meant to create).
 *   - `readback` is what labs returns NOW, read fresh by this QA skill through
 *     the `*_list` / `*_get` atoms and normalised into the shape below. The
 *     verdict is a function of the read-back, never of the write responses
 *     (spec 2026-10-18 § F0): a write that answered ok but did not land must
 *     fail here.
 *
 * Imported by the skill at runtime and by
 * `test/skills/supply-chain-setup-qa/checks.test.ts`.
 */
import type { QACheck, QACheckResult } from '../../lib/qa-types';
import { SYNTHETIC_SUFFIX } from '../../lib/supply-chain-ref';

export interface SetupPlan {
  program_id: number;
  runner: { org_id: number; role: 'llo' | 'pm' | 'other' };
  orgs: Array<{ slug: string; role: 'pm' | 'llo'; connect_organization_id: number }>;
  commodities: Array<{ slug: string }>;
  items: Array<{ sku: string; commodity_slug: string }>;
  supply_points: Array<{ slug: string; kind: string; connect_username?: string }>;
  suppliers: Array<{ name: string }>;
  /** The simulated FLWs' Connect usernames; one user_held point each. */
  synthetic_usernames: string[];
  /** ACE's own sign-in, from config/agent.json `email`. */
  ace_email: string;
}

export interface SetupReadback {
  runner: { org_id: number | null; your_standing: string };
  orgs: Array<{ slug: string; id?: number; connect_organization_id?: number | null }>;
  commodities: Array<{ slug: string }>;
  items: Array<{ sku: string }>;
  supply_points: Array<{ slug: string; kind: string; connect_username?: string | null }>;
  suppliers: Array<{ name: string }>;
  team: Array<{ email: string; role: string }>;
  /**
   * True when the runner is Dimagi. Labs keeps no team list for it: Dimagi's
   * members are everyone with a Dimagi address, and `programme_team_list`
   * REFUSES ("Dimagi's team is everyone with a Dimagi address; it is not kept
   * as a list" — live, program 10602, 2026-10-18; fixture
   * `test/skills/supply-chain-setup-qa/fixtures/labs-program-10602-readback.json`).
   */
  team_by_domain?: boolean;
  checks: Array<{ category: string; kind?: string; subject?: unknown }>;
}

/** The addresses labs counts as members of the Dimagi org (connect-labs `utils/dimagi_user.py`). */
export const DIMAGI_ORG_DOMAINS = ['@dimagi.com', '@dimagi-ai.com', '@dimagi-associate.com'];
const DIMAGI_TEAM_REFUSAL = /Dimagi's team is everyone with a Dimagi address/;

/** The raw replies of the QA's reads, as labs returns them. */
export interface RawReadback {
  programme_runner_get: { org_id: number | null; your_standing: string; org_name?: string | null };
  org_list: { value: Array<Record<string, unknown>> };
  commodity_list: { value: Array<Record<string, unknown>> };
  item_list: { value: Array<Record<string, unknown>> };
  supply_point_list: { value: Array<Record<string, unknown>> };
  supplier_list: { value: Array<Record<string, unknown>> };
  /**
   * The reply, or `{error}` with the text of a refused call. Live labs answers
   * `{org_id, org_name, members: [...]}` (programme 361, 2026-10-20, ace#3261);
   * `{value: [...]}` and a bare array are still accepted.
   */
  programme_team_list:
    | { members?: Array<Record<string, unknown>>; value?: Array<Record<string, unknown>>; error?: string; org_id?: number | null; org_name?: string | null }
    | Array<Record<string, unknown>>;
  checks_list: { checks?: Array<Record<string, unknown>> };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Normalise the raw labs replies into {@link SetupReadback}. Labs writes an
 * unset username as `""`, not null, and wraps lists in `{value: [...]}`.
 */
export function normalizeReadback(raw: RawReadback): SetupReadback {
  const team = raw.programme_team_list;
  const teamRows = Array.isArray(team) ? team : (team.members ?? team.value ?? []);
  const teamError = Array.isArray(team) ? '' : (team.error ?? '');
  return {
    runner: { org_id: raw.programme_runner_get.org_id, your_standing: raw.programme_runner_get.your_standing },
    orgs: raw.org_list.value.map((o) => ({
      slug: str(o.slug),
      id: typeof o.id === 'number' ? o.id : undefined,
      connect_organization_id: typeof o.connect_organization_id === 'number' ? o.connect_organization_id : null,
    })),
    commodities: raw.commodity_list.value.map((c) => ({ slug: str(c.slug) })),
    items: raw.item_list.value.map((i) => ({ sku: str(i.sku) })),
    supply_points: raw.supply_point_list.value.map((p) => ({
      slug: str(p.slug),
      kind: str(p.kind),
      connect_username: str(p.connect_username) || null,
    })),
    suppliers: raw.supplier_list.value.map((s) => ({ name: str(s.name) })),
    team: teamRows.map((t) => ({ email: str(t.email), role: str(t.role) })),
    team_by_domain: DIMAGI_TEAM_REFUSAL.test(teamError) || undefined,
    checks: (raw.checks_list.checks ?? []).map((c) => ({ category: str(c.category), kind: str(c.kind), subject: c.subject })),
  };
}

interface Doc {
  plan: SetupPlan;
  readback: SetupReadback;
}

function parse(artifact: string): Doc | QACheckResult {
  try {
    const doc = JSON.parse(artifact) as Doc;
    if (!doc || typeof doc !== 'object' || !doc.plan || !doc.readback) {
      return { pass: false, detail: 'artifact must be {plan, readback}', auto_fix_hint: 'Re-read labs and rebuild the {plan, readback} document.' };
    }
    return doc;
  } catch (e) {
    return { pass: false, detail: `artifact is not JSON: ${(e as Error).message}`, auto_fix_hint: 'Rebuild the {plan, readback} document as JSON.' };
  }
}

function withDoc(artifact: string, fn: (d: Doc) => QACheckResult): QACheckResult {
  const d = parse(artifact);
  return 'pass' in d ? d : fn(d);
}

function missing<T>(planned: T[], present: Set<string>, key: (t: T) => string): string[] {
  return planned.map(key).filter((k) => !present.has(k));
}

export function checkRunnerStanding(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const s = readback.runner.your_standing;
    return s === 'programme' || s === 'operator'
      ? { pass: true }
      : {
          pass: false,
          detail: `ACE's standing is '${s}'; tenders, awards, contracts and payments need 'programme'`,
          auto_fix_hint: 'Re-run supply-chain-setup Step 1 (the runner gate). If it halts with a [BLOCKER], resolve that; do not retry the writes.',
        };
  });
}

export function checkRunnerMatchesPlan(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) =>
    readback.runner.org_id === plan.runner.org_id
      ? { pass: true }
      : {
          pass: false,
          detail: `labs says runner org ${readback.runner.org_id}; the plan recorded ${plan.runner.org_id}`,
          auto_fix_hint: "Record the runner labs actually has in the plan and run state. Never move an existing runner.",
        },
  );
}

export function checkOrgsBound(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const bySlug = new Map(readback.orgs.map((o) => [o.slug, o]));
    const bad = plan.orgs
      .filter((o) => bySlug.get(o.slug)?.connect_organization_id !== o.connect_organization_id)
      .map((o) => `${o.slug} (${o.role})`);
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `not bound to their Connect org: ${bad.join(', ')}`,
          auto_fix_hint: 'Re-run supply_chain_org_upsert for each with connect_organization_id set; membership of a labs org is read from Connect only when it is bound.',
        };
  });
}

export function checkPlannedRecordsReadBack(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const gaps = [
      ...missing(plan.commodities, new Set(readback.commodities.map((c) => c.slug)), (c) => c.slug).map((s) => `commodity ${s}`),
      ...missing(plan.items, new Set(readback.items.map((i) => i.sku)), (i) => i.sku).map((s) => `item ${s}`),
      ...missing(plan.supply_points, new Set(readback.supply_points.map((p) => p.slug)), (p) => p.slug).map(
        (s) => `supply point ${s}`,
      ),
      ...missing(plan.suppliers, new Set(readback.suppliers.map((s) => s.name)), (s) => s.name).map((s) => `supplier ${s}`),
    ];
    return gaps.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `planned but not in labs: ${gaps.join('; ')}`,
          auto_fix_hint: 'Re-run the matching supply-chain-setup steps; their source refs are deterministic, so records that did land are replayed, not duplicated.',
        };
  });
}

export function checkUserHeldPointsNamed(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const usernames = new Set(plan.synthetic_usernames);
    const held = readback.supply_points.filter((p) => p.kind === 'user_held');
    const bad = held.filter((p) => !p.connect_username || !usernames.has(p.connect_username)).map((p) => p.slug);
    const covered = new Set(held.map((p) => p.connect_username).filter(Boolean) as string[]);
    const uncovered = plan.synthetic_usernames.filter((u) => !covered.has(u));
    if (bad.length === 0 && uncovered.length === 0) return { pass: true };
    return {
      pass: false,
      detail: [
        bad.length ? `user_held points without a simulated username: ${bad.join(', ')}` : '',
        uncovered.length ? `simulated FLWs with no user_held point: ${uncovered.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
      auto_fix_hint: "Upsert one kind=user_held point per simulated FLW, naming that FLW's connect_username.",
    };
  });
}

export function checkSuppliersSynthetic(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan }) => {
    const bad = plan.suppliers.map((s) => s.name).filter((n) => !n.trim().endsWith(SYNTHETIC_SUFFIX));
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `suppliers without the ${SYNTHETIC_SUFFIX} marker: ${bad.join(', ')}`,
          auto_fix_hint: `Name every invented supplier with syntheticName() (lib/supply-chain-ref.ts). A supplier is a company shared across programs, so a real-looking name leaks beyond this run.`,
        };
  });
}

export function checkTeamHasAceAdmin(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    if (readback.team_by_domain) {
      const ok = DIMAGI_ORG_DOMAINS.some((d) => plan.ace_email.toLowerCase().endsWith(d));
      return ok
        ? { pass: true, detail: 'runner is Dimagi; membership is by address, no team list exists' }
        : {
            pass: false,
            detail: `runner is Dimagi, whose members are Dimagi addresses only; ${plan.ace_email} is not one`,
            auto_fix_hint: 'Run as an identity with a Dimagi address, or declare a different runner before any write.',
          };
    }
    const me = readback.team.find((t) => t.email.toLowerCase() === plan.ace_email.toLowerCase());
    return me?.role === 'admin'
      ? { pass: true }
      : {
          pass: false,
          detail: me ? `${plan.ace_email} is on the team as '${me.role}', not admin` : `${plan.ace_email} is not on the running org's team`,
          auto_fix_hint: 'supply_chain_programme_team_add({email, role: "admin"}). Without admin, ACE cannot fix the team later.',
        };
  });
}

export function checkNoRegistryConflicts(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const conflicts = readback.checks.filter((c) => c.category === 'conflict');
    return conflicts.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `checks_list reports ${conflicts.length} conflict(s): ${conflicts.map((c) => c.kind ?? '?').join(', ')}`,
          auto_fix_hint: 'Read each conflict in checks_list; at setup time only registry records exist, so the conflict is in a record this skill wrote. Correct that record and re-read.',
        };
  });
}

export const CHECKS: QACheck[] = [
  { id: 'runner_standing_programme', type: 'static', description: "ACE's standing in the programme is programme (or operator)", run: checkRunnerStanding },
  { id: 'runner_matches_plan', type: 'static', description: 'The runner labs reports is the one the plan recorded', run: checkRunnerMatchesPlan },
  { id: 'orgs_bound', type: 'static', description: 'pm_org and llo_org labs orgs are bound to their Connect org ids', run: checkOrgsBound },
  { id: 'planned_records_read_back', type: 'static', description: 'Every planned commodity, item, supply point and supplier reads back', run: checkPlannedRecordsReadBack },
  { id: 'user_held_points_named', type: 'static', description: 'One user_held point per simulated FLW, each naming that username', run: checkUserHeldPointsNamed },
  { id: 'suppliers_synthetic', type: 'static', description: 'Every invented supplier carries the [Synthetic] marker', run: checkSuppliersSynthetic },
  { id: 'team_has_ace_admin', type: 'static', description: "ace@ is an admin of the running org's team", run: checkTeamHasAceAdmin },
  { id: 'no_registry_conflicts', type: 'static', description: 'checks_list shows no conflict after setup', run: checkNoRegistryConflicts },
];
