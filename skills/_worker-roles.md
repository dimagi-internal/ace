# Multi-role runs — one Learn app, one Deliver app and one opportunity per worker role

Connect counts EVERY Learn module in an opportunity toward every worker's
completion, and completes Learn only at 100%. A module gated to one role
therefore locks every other role out of Deliver (kaduna-graduation/20261015-1411,
ace#3036; `config/platform-constraints.yaml`). Connect also allows one active
opportunity per Learn or Deliver app id, and one `DeliverUnit` per (holding org,
released Deliver app) (ace#573). So a program with two kinds of worker gets, in
ONE run: a Learn + Deliver pair per role, and an opportunity per role on the
same program, each wired to its own role's released apps.

## When a run is multi-role

`planWorkerRoles` (`lib/worker-roles.ts`) decides from the PDD's § Program
Parameters, once, at the start of Phase 3:

| `worker_roles` | `opportunity_structure` | `learn_module_visibility` | Result |
|---|---|---|---|
| absent or one role | any | any | single-role — today's run, unchanged |
| two or more | `single` | any | single-role (one shared opportunity) |
| two or more | absent | `all-workers` | single-role (one Learn app every role completes) |
| two or more | `per-role`, or absent with any other visibility | — | **multi-role** |

The FIRST role listed is the **primary role**. A PDD that means two roles must
list them in `worker_roles` (`coach, enumerator`) — a role mentioned only in
prose is not built, and Phase 3's summary says which roles it read.

## Where each role's state lives (additive)

The single-object keys every reader already uses keep holding the PRIMARY role.
The other roles sit beside them, same inner shape
(`lib/phase-products-schema.ts`):

```yaml
phases:
  commcare-setup:
    products:
      apps:
        learn:   {…}                    # PRIMARY role — unchanged
        deliver: {…}                    # PRIMARY role — unchanged
        worker_roles: [coach, enumerator]   # every role key, primary FIRST
        roles:
          enumerator:                   # each NON-primary role
            label: Enumerator
            learn:   {name, nova_app_id, nova_url, hq_app_id, hq_url, build_status}
            deliver: {name, nova_app_id, nova_url, hq_app_id, hq_url, build_status}
  connect-setup:
    products:
      connect:
        program: {…}                    # ONE program, unchanged
        opportunity: {…, tile_token}    # PRIMARY role's opportunity
        ace_test_user: {…}              # PRIMARY role's read-back
        primary_role: coach
        role_opportunities:
          enumerator:                   # each NON-primary role
            label: Enumerator
            opportunity: {id, name, url, connect_int_id, tile_token, verification}
            ace_test_user: {phone, invite_row_present, connect_user_id, status, checked_at}
            payment_units: [...]
            postcondition: {ok, checked_at, failed, phase6_blockers}
```

Role keys are `roleKey(<PDD name>)`: lowercase snake_case
(`Independent enumerator` → `independent_enumerator`).

**What the fence enforces.** Once `apps.worker_roles` is written, a terminal
Phase 3 must carry `apps.roles.<key>.{learn,deliver}.hq_app_id` for every
non-primary role, and a terminal Phase 4 must carry
`connect.role_opportunities.<key>.opportunity.url` and
`.ace_test_user.invite_row_present` for every non-primary role Phase 3 built
(`verify_phase_products` / `classifyPhaseProducts`). So write `worker_roles`
FIRST — before any role's build — or the fence cannot see the roles it owes.

## When a skill is dispatched for a role (`worker_role:` in the dispatch)

The Phase 3 and Phase 4 skills run once for the primary role exactly as on a
single-role run, then once more per extra role with a `worker_role: {key, label}`
block in the dispatch. With that block:

| The skill would normally… | For `worker_role` instead… |
|---|---|
| build from the whole PDD | build only what the PDD assigns to THIS role (its training, its forms, its payment units); content for another role is out of scope, and a module or form the PDD does not tie to a role goes to the primary |
| name the app `<display name> Learn` / `Deliver` | name it `<display name> — <Role> Learn` / `Deliver` |
| write `3-commcare/<file>` | write the SAME filename under `3-commcare/roles/<key>/` (e.g. `3-commcare/roles/enumerator/pdd-to-deliver-app_summary.md`); create that folder with `drive_create_folder(findOrCreate: true)` |
| read another Phase 3 skill's output at `3-commcare/<file>` | read it from `3-commcare/roles/<key>/<file>` |
| write `products.apps.learn` / `.deliver` (`app-deploy`) | write `products.apps.roles.<key>` with `buildRoleCommcareProducts` (`lib/commcare-products.ts`), `merge: 'deep'` |
| write `products.connect.opportunity` / `.ace_test_user` (`connect-opp-setup`) | write `products.connect.role_opportunities.<key>.{opportunity, ace_test_user, …}` |
| append `decisions.yaml` rows | append them with the role's label in the question, so a reviewer can tell the two apart |

Everything else — HQ space, Connect program, PM and holding orgs, run
workspace — is the same for every role.

## What stays single-role, and says so

These read only the primary role today. Each one names the roles it did not
cover in its own summary, so a multi-role run reports the gap rather than
skipping it silently:

- **Phase 6 device walk** (`app-screenshot-capture`) walks the primary role's
  opportunity only (`agents/qa-and-training.md § Multi-role runs`).
- **Phase 7 synthetic cascade** models the primary role's Deliver app only
  (`agents/synthetic-data-and-workflows.md § Multi-role runs`).
- **Phase 9 partner opportunity** (`llo-onboarding` → `connect-partner-opp-create`)
  builds the primary role's; each extra role is one more
  `connect-partner-opp-create` with that role's apps
  (`agents/execution-manager.md § Multi-role runs`).

`opp-closeout` covers every role's opportunity (its § Inputs).
