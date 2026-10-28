/**
 * Multi-role builds: one Learn app, one Deliver app and one Connect
 * opportunity PER WORKER ROLE, in one `/ace:run`.
 *
 * ## Why one opportunity per role
 *
 * Connect computes Learn completion over EVERY `learn_module` in an
 * opportunity and completes only at 100%, so a Learn module gated to one role
 * still counts against every other role's workers — they can never finish
 * Learn and Deliver never unlocks (kaduna-graduation/20261015-1411: 9/14 =
 * 64.3%, ace#3036; `config/platform-constraints.yaml`). Connect also allows one
 * ACTIVE opportunity per Learn or Deliver app id, and one `DeliverUnit` per
 * (holding org, released Deliver app) (ace#573). So a two-role program needs
 * two Learn apps, two Deliver apps and two opportunities.
 *
 * ## The run_state shape (additive)
 *
 * ~37 files read `phases.commcare-setup.products.apps.{learn,deliver}` and
 * `phases.connect-setup.products.connect.opportunity` as single objects. Those
 * keep holding the PRIMARY role (the first role the PDD lists). The other roles
 * sit beside them, same inner shape:
 *
 *   phases.commcare-setup.products.apps.worker_roles      [primary, extra, ...]   (keys)
 *   phases.commcare-setup.products.apps.roles.<key>       {label, learn, deliver}
 *   phases.connect-setup.products.connect.primary_role    <key>
 *   phases.connect-setup.products.connect.role_opportunities.<key>
 *                                                         {label, opportunity, ace_test_user, postcondition, ...}
 *
 * A single-role run writes none of these keys and behaves exactly as before.
 * Contract for the skills: `skills/_worker-roles.md`.
 */

/** A role key: lowercase snake_case, as used under `apps.roles.<key>`. */
export const ROLE_KEY_RE = /^[a-z][a-z0-9_]*$/;

export interface WorkerRole {
  /** `apps.roles.<key>` / `role_opportunities.<key>` — lowercase snake_case. */
  key: string;
  /** Human label as the PDD writes it, first letter capitalised (`Coach`, `Enumerator`). */
  label: string;
}

export class WorkerRolesError extends Error {}

/** Normalise a PDD role name to its key: `Independent enumerator` → `independent_enumerator`. */
export function roleKey(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!ROLE_KEY_RE.test(key)) {
    throw new WorkerRolesError(`worker role "${name}" does not normalise to a usable key (got "${key}")`);
  }
  return key;
}

function roleLabel(name: string): string {
  const t = name.trim().replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Parse the PDD's `worker_roles` cell (`coach, enumerator`) into roles, PDD order kept. */
export function parseWorkerRoles(cell: string | undefined | null): WorkerRole[] {
  if (cell === undefined || cell === null) return [];
  const names = cell
    .split(/[,;]/)
    .map((s) => s.replace(/`/g, '').trim())
    .filter((s) => s !== '');
  const seen = new Map<string, string>();
  const roles: WorkerRole[] = [];
  for (const n of names) {
    const key = roleKey(n);
    if (seen.has(key)) {
      throw new WorkerRolesError(`worker_roles lists "${seen.get(key)}" and "${n}", which share the key "${key}"`);
    }
    seen.set(key, n);
    roles.push({ key, label: roleLabel(n) });
  }
  return roles;
}

export interface WorkerRoleInput {
  /** PDD § Program Parameters `worker_roles` (comma-separated). */
  worker_roles?: string | null;
  /** PDD § Program Parameters `opportunity_structure` (`single` | `per-role`). */
  opportunity_structure?: string | null;
  /** PDD § Program Parameters `learn_module_visibility`. */
  learn_module_visibility?: string | null;
}

export interface WorkerRolePlan {
  /** True when this run builds a Learn + Deliver pair and an opportunity per role. */
  multi_role: boolean;
  /** Every declared role, PDD order. Empty when the PDD names none. */
  roles: WorkerRole[];
  /** The role the top-level `apps.{learn,deliver}` / `connect.opportunity` hold (roles[0]); null when none declared. */
  primary: WorkerRole | null;
  /** Roles built BESIDE the primary (`apps.roles.<key>`); empty on a single-role run. */
  extra: WorkerRole[];
  /** One sentence a phase summary can quote. */
  reason: string;
}

const ALL_WORKERS = /^(all[- ]?workers|all|every[- ]?worker|everyone|ungated)$/i;

/**
 * Decide whether this run is multi-role.
 *
 * Multi-role iff the PDD lists two or more `worker_roles` AND it did not choose
 * one shared opportunity. One shared opportunity is chosen by
 * `opportunity_structure | single`, or — with no structure row — by
 * `learn_module_visibility | all-workers` (one Learn app every role completes,
 * the only single-opportunity shape `idea-to-pdd-qa § platform_constraints`
 * passes). Anything else with two roles is per-role: that is the shape the
 * platform-constraints rule prescribes for role-specific training.
 */
export function planWorkerRoles(input: WorkerRoleInput): WorkerRolePlan {
  const roles = parseWorkerRoles(input.worker_roles ?? undefined);
  const primary = roles[0] ?? null;
  const single = (reason: string): WorkerRolePlan => ({ multi_role: false, roles, primary, extra: [], reason });
  if (roles.length < 2) {
    return single(
      roles.length === 0
        ? 'The PDD lists no worker_roles: one Learn + Deliver pair and one opportunity.'
        : `The PDD lists one worker role (${roles[0].label}): one Learn + Deliver pair and one opportunity.`,
    );
  }
  const names = roles.map((r) => r.label).join(', ');
  const structure = (input.opportunity_structure ?? '').trim().toLowerCase();
  if (/^single/.test(structure)) {
    return single(`The PDD lists ${roles.length} roles (${names}) but opportunity_structure is single: one shared opportunity.`);
  }
  if (structure === '' && ALL_WORKERS.test((input.learn_module_visibility ?? '').trim())) {
    return single(
      `The PDD lists ${roles.length} roles (${names}) with learn_module_visibility all-workers and no opportunity_structure: ` +
        'one Learn app every role completes, one shared opportunity.',
    );
  }
  return {
    multi_role: true,
    roles,
    primary,
    extra: roles.slice(1),
    reason:
      `The PDD lists ${roles.length} roles (${names})` +
      (structure ? ` with opportunity_structure ${structure}` : ' and does not choose one shared opportunity') +
      `: one Learn + Deliver pair and one opportunity per role; ${roles[0].label} is the primary role.`,
  };
}

// ─── Phase 3: which role apps still need building (resume) ─────────

/** How far one app of one role has got. `ready` = built, deployed and released. */
export type RoleAppStage = 'build' | 'deploy' | 'release' | 'ready';

export interface RoleBuildState {
  role: WorkerRole;
  primary: boolean;
  learn: RoleAppStage;
  deliver: RoleAppStage;
}

export interface RoleBuildPlan {
  roles: RoleBuildState[];
  /** The roles with at least one app short of `ready`, primary first. Empty = precondition holds. */
  todo: RoleBuildState[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function stage(entry: unknown, released: Record<string, boolean>): RoleAppStage {
  const e = (entry ?? {}) as Record<string, unknown>;
  if (!str(e.nova_app_id)) return 'build';
  const hq = str(e.hq_app_id);
  if (!hq) return 'deploy';
  return released[hq] === true ? 'ready' : 'release';
}

/**
 * Phase 3's restore-not-adapt precondition: EVERY declared role has a released
 * Learn + Deliver pair. Given the plan, `phases.commcare-setup.products` as
 * run_state has it, and which HQ app ids are released (keyed by `hq_app_id`,
 * read from each `app-release_summary.md` — the owner of release state,
 * ace#1636), say per role what is still owed.
 *
 * On a resume after a primary-only Phase 3 the primary comes back `ready` and
 * only the new role is in `todo` — so the phase builds just that role's apps.
 */
export function planRoleBuilds(
  plan: WorkerRolePlan,
  commcareProducts: unknown,
  released: Record<string, boolean>,
): RoleBuildPlan {
  const apps = ((commcareProducts as any)?.apps ?? {}) as Record<string, any>;
  const primaryRole: WorkerRole = plan.primary ?? { key: 'primary', label: 'Primary' };
  const states: RoleBuildState[] = [
    { role: primaryRole, primary: true, learn: stage(apps.learn, released), deliver: stage(apps.deliver, released) },
  ];
  for (const role of plan.extra) {
    const entry = apps.roles?.[role.key] ?? {};
    states.push({ role, primary: false, learn: stage(entry.learn, released), deliver: stage(entry.deliver, released) });
  }
  return { roles: states, todo: states.filter((s) => s.learn !== 'ready' || s.deliver !== 'ready') };
}

/**
 * The Phase 4 entry guard: which of the PDD's extra roles Phase 3 has NOT
 * recorded a deployed pair for. Non-empty means Phase 3 must run again before
 * Phase 4 — the normal shape when the PDD gained a role after a single-role
 * Phase 3 finished (smallholder-seasonal/20261028-1636): that Phase 3 never
 * wrote `apps.worker_roles`, so without this check Phase 4 would read a
 * single-role run and create one opportunity.
 *
 * Also non-empty when `apps.worker_roles` disagrees with the PDD's role list,
 * because then the fence is checking the wrong roles. Release state is Phase
 * 3's to restore (`planRoleBuilds`); this only reads `products`.
 */
export function rolesOwedByPhase3(plan: WorkerRolePlan, commcareProducts: unknown): string[] {
  if (!plan.multi_role) return [];
  const apps = ((commcareProducts as any)?.apps ?? {}) as Record<string, any>;
  const recorded = Array.isArray(apps.worker_roles) ? apps.worker_roles : [];
  const wanted = plan.roles.map((r) => r.key);
  const listMatches = recorded.length === wanted.length && wanted.every((k, i) => recorded[i] === k);
  return plan.extra
    .filter((r) => {
      const pair = apps.roles?.[r.key];
      return !listMatches || !str(pair?.learn?.hq_app_id) || !str(pair?.deliver?.hq_app_id);
    })
    .map((r) => r.key);
}

// ─── Phase 4: per-role opportunities ───────────────────────────────

/**
 * The opportunity name on a MULTI-ROLE run, every role including the primary:
 * `"<run_id> · <Role> · <PDD display name>"`. The run-id still leads (the
 * `INVALID_OPP_NAME_PREFIX` rule, ace#755); the role follows it so it lands on
 * the tile's first line too. A single-role run keeps `"<run_id> · <display>"`.
 */
export function roleOpportunityName(runId: string, role: WorkerRole, displayName: string): string {
  return `${runId} · ${role.label} · ${displayName.trim()}`;
}

/**
 * The Phase 6 tile matcher for a role's opportunity on a multi-role run. The
 * plain run-id matcher (`.*<run_id>.*`) would match every role's tile — the
 * test user is invited to all of them — so a multi-role run records this as
 * `opportunity.tile_token` and Phase 6 passes it as `OPP_RUN_ID`.
 */
export function roleTileToken(runId: string, role: WorkerRole): string {
  return `${runId} · ${role.label}`;
}

/** The names a role's Step 4.0 must NOT treat as a run-id collision: its sibling roles' opportunities. */
export function siblingOpportunityNames(
  runId: string,
  plan: WorkerRolePlan,
  displayName: string,
  self: WorkerRole,
): string[] {
  if (!plan.multi_role) return [];
  return plan.roles.filter((r) => r.key !== self.key).map((r) => roleOpportunityName(runId, r, displayName));
}

/** Extra roles (from Phase 3's `apps.worker_roles`) that Phase 4 has no opportunity URL for yet. */
export function missingRoleOpportunities(commcareProducts: unknown, connectProducts: unknown): string[] {
  const keys = extraRoleKeys(commcareProducts);
  const ro = ((connectProducts as any)?.connect?.role_opportunities ?? {}) as Record<string, any>;
  return keys.filter((k) => !str(ro[k]?.opportunity?.url));
}

/** `apps.worker_roles.slice(1)` when Phase 3 recorded a multi-role build, else []. */
export function extraRoleKeys(commcareProducts: unknown): string[] {
  const wr = (commcareProducts as any)?.apps?.worker_roles;
  if (!Array.isArray(wr) || wr.length < 2) return [];
  return wr.slice(1).filter((k): k is string => typeof k === 'string' && k !== '');
}
