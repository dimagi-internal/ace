---
name: clone-to-new-workspace
description: >
  Copy a completed ACE run into another ace-web workspace and rebuild its
  assets in that workspace's own HQ space, Connect orgs and Labs scope, so it
  can be reviewed there without exposing anything else. No invites or
  redirects (that is `release`). Use before an external review.
disable-model-invocation: false
---

# clone-to-new-workspace

`/ace:clone-to-new-workspace <opp>/<run-id> --to <workspace> [--from <workspace>]`

While ACE iterates, every run is built in shared tenants (one HQ project space,
one Connect org pair, one OCS team, Dimagi-only Labs). Granting an outsider
access there exposes every run. This skill makes a copy of one run whose assets
live ONLY in the target workspace's areas — the end state the partner would have
if they had built and configured it themselves.

Nothing outside Drive can be *moved* (a Connect opportunity's holding org is
fixed at creation; an OCS clone stays in its team), so the copy's assets are
**rebuilt**. The source run is never modified.

Spec: ace-web `docs/specs/2026-09-28-clone-and-release-design.md` § E.

## What this does NOT do

- **Invite anyone.** Reviewers are invited last, by `release`, after everything
  is set up — nobody should see a half-built clone.
- **Redirect the source's links.** Also `release`.
- **Create a Connect org or an OCS team.** No API exists; the preflight lists
  them as manual steps.

## Inputs

- `<opp>/<run-id>` — the source run.
- `--from <workspace>` — source workspace; default `$ACE_WEB_WORKSPACE`.
- `--to <workspace>` — target workspace. Its **default tenancy** (ace-web
  Workspace Settings / `PATCH /api/workspaces/<slug>` `default_tenancy`) says
  where the rebuilt assets go.
- `--keep-shared connect` — **interim exception** (Jon, 2026-09-29): partner
  Connect orgs can't be created yet, so the clone KEEPS the source's Connect
  program + opportunity in the shared orgs instead of re-running Phase 4. The
  target tenancy's Connect orgs are then the shared ones
  (`ace-pm-org` / `ace-nm-org`), which Step 1.3 would otherwise refuse. Use it
  only until per-partner org creation exists.

Auth: `ACE_WEB_BASE_URL` + `ACE_WEB_PAT_TOKEN` (same as `fork-run`). The PAT's
owner must be an **owner of both** workspaces.

## Step 1 — Preflight (creates nothing)

Collect every problem, then stop and print them all if there are any. Do not
start Step 2 with a failed preflight.

1. **Source run.** `GET ${ACE_WEB_BASE_URL}/api/w/<from>/opps/<opp>/runs` must
   list `<run-id>`. Read the source `run_state.yaml`
   (`resolve_opp_path` → `drive_read_file`) and keep its
   `phases.commcare-setup.products.apps`, `phases.connect-setup.products.connect`,
   `phases.ocs-setup.products.ocs_chatbot` (its `public_url` is reported),
   `phases.synthetic-data-and-workflows.products.synthetic`. A run without
   `products.apps.learn.hq_app_id` / `deliver.hq_app_id` cannot be cloned past
   the ace-web step — say so.
2. **Target tenancy.** `GET ${ACE_WEB_BASE_URL}/api/workspaces/<to>` →
   `default_tenancy`. Every field the source run has products for must be set:
   `hq_domain` (apps), `connect_pm_org` + `connect_holding_org` (Connect),
   `labs_allowed_domains` (Labs — must name the partner's domain, not only
   Dimagi's). `ocs_team` is not needed (see 4d). A missing field is a setup
   item: "workspace owner: set default_tenancy.<field>".
3. **Not a shared tenancy.** Compare with the SOURCE opp's tenancy
   (`GET …/api/w/<from>/opps/<opp>/tenancy`). A target field equal to the
   source's (e.g. `hq_domain: connect-ace-prod` in both) defeats the purpose —
   refuse it and name the field. **Exception:** with `--keep-shared connect`,
   equal `connect_pm_org` / `connect_holding_org` are accepted (say so in the
   report); every other field still must differ.
4. **Per system, one-time setup the target needs:**
   - **HQ:** `commcare_list_apps(domain: <hq_domain>)` succeeds → exists and ACE
     is a member. A "not found" is fine — Step 3 creates it. Any other error
     (forbidden) is a setup item: "add ace@dimagi-ai.com to HQ project
     <hq_domain> as admin".
   - **Connect:** `connect_list_programs(organization_slug: <connect_pm_org>)`
     succeeds, and the holding org accepts `connect_list_opportunities`. A
     failure is a setup item: "Connect staff: create program-manager org
     <connect_pm_org> / org <connect_holding_org> and make ace@dimagi-ai.com an
     admin; the holding org needs an accepted program application".
   - **OCS: nothing.** The bot is not rebuilt (see 4d).
5. **Already cloned?** `GET …/api/w/<from>/opps/<opp>/runs/<run-id>/clones` —
   a `done` clone into `<to>` means resume (Step 3 onward, skipping finished
   `clone.<system>` entries in the TARGET run_state), not a second copy.

## Step 2 — Copy the run into the target workspace (ace-web)

```bash
curl -sS -X POST -H "Authorization: Bearer $ACE_WEB_PAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"to_workspace\": \"<to>\"}" \
  "${ACE_WEB_BASE_URL%/}/api/w/<from>/opps/<opp>/runs/<run-id>/clone"
```

Blocking (~150 ms per file; minutes on a large run). `201` → the run now exists
at `<to>`'s Drive root as `<opp>/runs/<run-id>/`, and the target opp has the
target's default tenancy. `409` → already copied: go to Step 3 (resume). On a
client timeout, poll `…/clones` — never re-POST blindly.

## Step 3 — Bind this session to the NEW opp

```bash
"$CLAUDE_PLUGIN_ROOT/bin/ace-bind" <to>/<opp>
```

From here the tenancy guard refuses any write outside the target's tenancy —
so a mistake cannot rebuild into the shared tenants. Reading FROM the source
(`upstream_domain`, the source products) is allowed. **Never** clear or rebind
to the source to get a write through; a refusal here means a wrong argument.

## Step 4 — Rebuild, one system at a time

Each step writes its result to the TARGET run's `run_state.yaml` under a root
`clone:` block (`update_yaml_file`), so a rerun skips finished steps:

```yaml
clone:
  from: {workspace: <from>, opp: <opp>, run: <run-id>}
  hq: {status: done, domain: <hq_domain>, learn_app_id: …, deliver_app_id: …}
  connect: {status: not-done, reason: …}
```

Then rewrite the matching `phases.<phase>.products` in the TARGET run_state so
the Workbench and every later skill see the new assets, not the shared ones.

### 4a. HQ

1. If Step 1 found no `<hq_domain>`: `commcare_create_domain(hr_name:
   <hq_domain>)`. The returned `domain` MUST equal `<hq_domain>` — if HQ derived
   a different slug, stop and report it (the tenancy is then wrong).
2. For `learn` and `deliver`: `commcare_linked_app_copy(upstream_domain:
   <source products.apps.<k>.domain>, upstream_app_id: <source hq_app_id>,
   downstream_domain: <hq_domain>, name: <source app name>, linked: false)`.
   Unlinked: no Pro Edition needed; the copy keeps camera-only and grid-menu
   settings. **A timeout does not mean it failed** — `commcare_list_apps` on
   `<hq_domain>` and match by name before any retry.
3. `commcare_make_build` then `commcare_release_build` for each new app.
3b. **Mint the opportunity's HQ key, restricted to this space:**
   `commcare_create_api_key(domain: <hq_domain>, name: "ace-clone-<hq_domain>")`
   → `{key_ref: "hq-key:ace-clone-<hq_domain>", key_last4, id}`. The partner's
   Connect opportunity will hold THIS key, not ACE's all-spaces
   `ACE_HQ_API_KEY` — a Connect org admin can attach any stored key id to
   their own opportunity, so the partner's must reach only the partner's
   space. The plaintext is stored owner-only on this machine and never
   returned; only the reference travels. On a RESUME where Step 4b has not run
   yet and the local key file is missing, pass `replace_existing: true`
   (rotation is safe: nothing uses the key yet). Record `clone.hq.key: {ref,
   id, last4}` — never the key.
4. Rewrite `phases.commcare-setup.products.apps` in the target run_state:
   `domain`, and per app `hq_app_id`, `hq_url`, `domain`, `build_status`.
   Keep `nova_app_id` / `nova_url` (same Nova source).
5. **First live use:** a cross-space unlinked copy was only live-tested inside
   one space (2026-09-01). The first clone verifies it; report what happened.

**Not in v1:** HQ mobile workers — no tool creates them. Report it as a manual
step.

### 4b. Connect — re-run Phase 4 in the target's orgs

**With `--keep-shared connect`: skip this step.** Keep the target run's copied
`products.connect` and `opp.yaml` `connect:` block as they are (they name the
source program and opportunity in the shared orgs), and record
`clone.connect: {status: kept-shared, pm_org, holding_org, opportunity_id}`.
Report it loudly: the Connect opportunity still points at the SOURCE HQ apps
(`connect-ace-prod`), while the partner's HQ access is to the copies in
`<hq_domain>` — identical content, different project space. The minted
`hq-key:` (3b) is unused until the Connect step runs for real. `release`
treats `kept-shared` as a shared tenant (only `--allow-shared connect` grants
it).

Otherwise:

Connect cannot move an opportunity (its holding org is fixed at creation), so
the clone gets its own program and opportunity, built by the SAME Phase 4 skills
that built the source — not a hand-rolled copy of them. Requires 4a (the
opportunity must point at the rebuilt HQ apps).

1. **Preflight already proved** both orgs exist with ace@ as admin and the
   holding org can hold opportunities (Step 1.4). Connect org creation for a
   partner is outside ACE — a missing org is a setup item, never guessed.
2. **Clear the copied Connect state in the TARGET only.**
   - Target `opp.yaml`: delete the `connect:` block. It names the SOURCE
     program, and `connect-program-setup` reuses whatever program is recorded
     there — which would put the clone's opportunity back in the shared org.
     (The session is bound in enforce mode, so the guard would refuse those
     writes anyway; clearing it avoids the detour.)
   - Target `run_state.yaml`: set `phases.connect-setup` to
     `{status: pending, products: {}}`.
3. **Dispatch the Phase 4 agent** (`Agent(connect-setup)`) against
   `<to>/<opp>/<run-id>`, passing this `connect_orgs` block instead of the
   preflight's:

   ```yaml
   connect_orgs:
     status: ok
     pm_org: <tenancy.connect_pm_org>
     nm_org: <tenancy.connect_holding_org>
     source: tenancy
   ```

   and tell it to use `api_key: hq-key:ace-clone-<hq_domain>` (from 4a step
   3b) for BOTH `learn_app` and `deliver_app` in `connect_create_opportunity`
   (and in `connect_preflight_learn_app_user`) instead of `${ACE_HQ_API_KEY}`.

   With `nm_org ≠ pm_org` this is the normal PM→NM shape: the program is
   created in the partner's PM org, the holding org is invited and accepted,
   and the opportunity — payment units, verification rules, dates, the ACE
   test user — is created HELD by the partner's org, pointing at the apps 4a
   rebuilt. It also re-composes the build memo from the clone's own products.
4. Read back `connect_get_opportunity(holding_org, <new id>)`: its
   `learn_app` / `deliver_app` `cc_domain` must be `tenancy.hq_domain`. Record
   `clone.connect: {status: done, program_id, opportunity_id, pm_org,
   holding_org}`. A Phase 4 halt is `NOT DONE` with its reason — never fall
   back to the source opportunity.

### 4c. Labs — widen the run's own labs-only opps

A run's Phase 7 labs assets (its synthetic opps, their program, registry and
dashboards) were created for that run alone — nothing else lives in them. So
the Labs step does NOT rebuild them: it lets the target tenancy's domain see
them, and both runs keep pointing at the same labs assets.

1. From the source `products.synthetic`, collect every labs-only opp id:
   `cascade.partners[].opportunity_id` and `labs_opp_id` (skip ids < 10000 —
   those are real-backed opps, gated by Connect membership; report them as
   `NOT DONE — real-backed, needs the Connect step`).
2. For each id: `synthetic_set_allowed_domains(opportunity_id, allowed_domains:
   <tenancy.labs_allowed_domains>)`. Dimagi staff keep access regardless (labs
   treats Dimagi-internal users as operators), so the list is just the
   partner's domain(s). The tenancy guard checks every domain is in the bound
   tenancy. A `PERMISSION_DENIED` means ace@ is neither the creator nor
   Dimagi-internal on that opp — report it, do not work around it.
3. Leave `products.synthetic` unchanged in the target run (same assets).
   Record `clone.labs: {status: done, opportunity_ids: [...], allowed_domains:
   [...]}`.
4. **Report the sign-in caveat:** a partner opens labs by logging in through
   Connect (HQ sign-in). Labs matches the email Connect returns, so the
   partner's Connect account must carry their `@<domain>` email — check with
   one reviewer before telling everyone it works.

Requires connect-labs with `synthetic_set_allowed_domains`
(dimagi-internal/connect-labs#2100). If the tool is missing, report
`NOT DONE — labs tool not deployed`.

### 4d. OCS — deliberately not rebuilt

The bot stays on ACE's OCS team and the copied `products.ocs_chatbot` is kept
as is. Reviewers chat with it through its public link (`public_url`), which
needs no OCS account and exposes nothing else on the team (Jon, 2026-09-28:
no OCS accounts for reviewers). OCS permissions are team-wide — there is no way
to let someone into OCS and see only one bot — so a per-partner OCS team is
only worth it when a partner takes the bot over, which is a handover step, not
a clone step. Record `clone.ocs: {status: kept, reason: public-link}` and
report the `public_url`.

## Step 5 — Report

One line per system: `created` (with ids / URLs read back — `commcare_list_apps`
on the new domain, not the call's own return value), or `NOT DONE` + reason,
plus every manual setup item. End with: "Nothing was shared with anyone. When
everything is ready, run `/ace:release <to>/<opp>/<run-id>`."
