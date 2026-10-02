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

`/ace:clone-to-new-workspace <opp>/<run-id> --to <workspace> [--from <workspace>] [--hq-domain <slug>] [--labs-domain <@domain>] [--co-owner <email>] [--keep-shared connect]`

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
  a missing Connect org as a setup item (or use `--keep-shared connect`).
- **Put the new HQ space on a paid plan.** A space ACE creates starts on Free
  Edition (REST API closed). The agreed path is accounts' `ace-enterprise`
  Enterprise subscription, converted per space by a Dimagi HQ **superuser**
  ("Test or Demo Project"). ace@ is not a superuser, so 4a asks for it as one
  exact setup item and reads the result back.

Everything else a clone needs is ACE's own job, not a note to a human: a
missing target workspace, its Drive root, its default tenancy and its HQ
project space are all created here (Step 0 and 4a).

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
- `--hq-domain <slug>` — the target's HQ project space when Step 0 has to set
  it. Default `connect-ace-<to>` (≤ 25 chars — HQ's cap).
- `--labs-domain <@domain>` — the partner's email domain(s), comma-separated,
  when Step 0 has to set `labs_allowed_domains`. No default: derive it from the
  reviewers' addresses on the thread that asked for the clone (e.g. the ace@
  thread's `@sparkmicrogrants.org` recipients), and stop if you cannot.
- `--co-owner <email>` — a human to invite as an owner of a workspace Step 0
  creates (default: the operator who asked, e.g. `jjackson@dimagi.com`), so
  the workspace is not visible to ace@ alone.

Auth: `ACE_WEB_BASE_URL` + `ACE_WEB_PAT_TOKEN` (same as `fork-run`). The PAT's
owner must be an **owner of both** workspaces.

## Step 0 — Ensure the target workspace and its default tenancy

A partner workspace is set up here, by ACE — not handed to a human. Skip any
part that already holds.

1. `GET ${ACE_WEB_BASE_URL}/api/workspaces` (ace@'s PAT). If `<to>` is listed,
   go to 5.
2. **Drive root.** Workspace roots live under `ACE/_workspaces/<to>/` in the
   ACE Shared Drive folder: `drive_create_folder(name: "_workspaces",
   parentFolderId: $ACE_DRIVE_ROOT_FOLDER_ID)` then `drive_create_folder(name:
   <to>, parentFolderId: <_workspaces id>)` (both find-or-create). Why there:
   the service account is shared on the `ACE` folder, not the Shared Drive
   itself, so it cannot create a sibling of `ACE`; ace-web and ACE use the
   SAME service account (`ace-service-account@connect-labs`), so anything ACE
   creates here ace-web can write; `_`-prefixed folders are skipped by
   `sweep-drive`, and ace-web lists as opps only folders holding `idea.md` /
   `opp.yaml` / `run_state.yaml` / `runs`, so `_workspaces` never shows up as
   a `dimagi-team` opp. Drive visibility is Dimagi-only either way — reviewers
   are never given Drive access.
3. `POST ${ACE_WEB_BASE_URL}/api/workspaces` `{"slug": "<to>", "name":
   "<To>", "drive_root_folder_id": "<folder id>"}` → ace@ is its owner. **The
   returned `slug` must equal `<to>`**: ace-web silently suffixes (`<to>-2`)
   when the slug is taken by a workspace ace@ cannot see. If it differs, stop
   and report both slugs — do not clone into the suffixed one.
4. **Co-owner.** `POST …/api/workspaces/<to>/members/invite` `{"email":
   <co-owner>, "role": "owner"}` and report the accept link
   (`${ACE_WEB_BASE_URL}/invite/<token>`). This is a Dimagi colleague, not a
   reviewer, so it is not held back to `release`.
5. **Default tenancy.** `GET …/api/workspaces/<to>` → `default_tenancy`. Fill
   ONLY the fields that are empty (never overwrite an owner's value), with
   `PATCH …/api/workspaces/<to>` `{"default_tenancy": {...merged}}`:
   - `hq_domain`: `--hq-domain`, default `connect-ace-<to>`;
   - `connect_pm_org` / `connect_holding_org`: with `--keep-shared connect`,
     the SOURCE opp's values (`GET …/api/w/<from>/opps/<opp>/tenancy`);
     otherwise leave empty — Step 1.4 then names the Connect setup item;
   - `labs_allowed_domains`: `--labs-domain` (with the leading `@`);
   - `ocs_team`: leave empty (not used — 4d).
   Read it back and print it. A `403` means ace@ is a member but not an owner of
   an existing `<to>` — that IS a human item ("an owner of `<to>` makes
   ace@dimagi-ai.com an owner").

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
   - **HQ:** nothing to check up front. `commcare_list_apps` cannot answer
     "does this space exist": HQ returns the same `HQ_API_NOT_IN_PLAN` 401 for
     a space whose plan has no REST API and for one that does not exist
     (observed 2026-09-29 on a made-up slug; ace#2551). 4a.1 attempts the
     create instead, and that answer is authoritative. (On an existing space,
     `commcare_get_subscription` tells the two apart: a plan, or a 404 naming
     "does not exist or ace@ is not a member".)
   - **Connect:** `connect_list_programs(organization_slug: <connect_pm_org>)`
     succeeds, and the holding org accepts `connect_list_opportunities`. A
     failure is a setup item: "Connect staff: create program-manager org
     <connect_pm_org> / org <connect_holding_org> and make ace@dimagi-ai.com an
     admin". (No program application is needed up front: Phase 4 creates the
     program, then sends and accepts the holding org's application itself —
     4b.) With `--keep-shared connect` this check is skipped: the shared orgs
     are the ones every run already writes to.
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

`202` → the copy has started on ace-web's side (ace-web#824): poll `GET
…/api/w/<from>/opps/<opp>/runs/<run-id>/clones` every ~30 s until that
record's `status` is `done` (the run now exists at `<to>`'s Drive root as
`<opp>/runs/<run-id>/` and the target opp has the target's default tenancy)
or `error` (report it; re-POST replaces the partial run). Budget ~2.4 s per
file — the first real clone, 347 files, took ~14 min. `files_copied` rising
means it is alive. `409` → already copied, or a copy still in progress: go to
Step 3 (resume) once `…/clones` says `done`. Never re-POST while a record is
`copying` and still progressing. Comms-logs are not copied (internal; ACE
routes inbound mail by them). An older ace-web answers `201` after copying
in-request — then treat a 504 as "still copying" and poll the same way.

Steps 3–4 do not depend on the Drive copy finishing except where they write
the TARGET `run_state.yaml`; wait for `done` before 4's first write.

**Drive links are ace-web's job, and you verify them.** Once `done`, ace-web
has rewritten every source Drive id in the target `run_state.yaml` /
`decisions.yaml` to its copy and given each copy its original's
anyone-with-link role (ace-web#829). Read-back before Step 4: list the SOURCE
run folder's file ids and grep the TARGET `run_state.yaml` for them — any hit
other than a comms-log file (deliberately not cloned) means the rewrite did
not run; stop and report it rather than hand-patching, because the page would
send reviewers to the source workspace's documents. (First Spark clone,
before #829: 99 ids / 125 occurrences, and 26 copies without their sharing —
fixed by hand then.)

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

Before the first system step, also point the TARGET run at its own page: the
copied `run_state.yaml` still carries the SOURCE's top-level
`ace_web_summary_url` (ace-web copies files verbatim). `update_yaml_file(merge:
"two-level", patch: {ace_web_summary_url:
"${ACE_WEB_BASE_URL}/opps/<to>/<opp>/runs/<run-id>/summary"})` — every reply,
README and `release` email leads with that link, and the source's would send a
reviewer to a workspace they cannot open.

### 4a. HQ

1. `commcare_create_domain(hr_name: <hq_domain>)` — attempt it; a "taken" /
   already-exists error is the skip (the space exists), not a failure. The
   returned `domain` MUST equal `<hq_domain>` — if HQ derived a different slug,
   stop and report it (the tenancy is then wrong). A forbidden on an existing
   space ace@ is not in is a setup item: "add ace@dimagi-ai.com to HQ project
   <hq_domain> as admin".
1b. **Plan → Enterprise (ace-enterprise).** `commcare_get_subscription(domain:
   <hq_domain>)`. A space ACE just created reads `edition: Free`
   (`is_paid_edition: false`; connect-ace-spark, 2026-09-29, ace#2552), and
   Free has no REST API. Accounts set up the `ace-enterprise` subscription for
   exactly these spaces (Gillian Javetski, 2026-10-02). Each space is moved
   onto it by a **Dimagi HQ superuser**, never by ace@: HQ gates the page with
   `require_superuser`, and as ace@ it redirects to `/no_permissions/`. So when
   the read is Free, the step is the operator's. Print it verbatim, never
   paraphrased: `node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs"
   "$ACE_ROOT/scripts/release-check.ts" hq-flip-steps --domain <hq_domain>`.
   It prints the exact URL
   (`https://www.commcarehq.org/a/<hq_domain>/settings/project/internal_subscription_management/`),
   **Subscription Type → Test or Demo Project → Update**, and the read-back
   page. Its home is `/ace:release` Step 0.4, where the operator does it and
   release-check blocks until it is done (`hq-plan-free`).

   Mechanism and what NOT to do instead: `playbook/integrations/commcare-api.md
   § New project spaces`. Record `clone.hq.plan: {edition, is_paid_edition}`
   from the read, never from the request.
   - **Connect will be rebuilt (no `--keep-shared connect`):** 3b and 4b need
     the API. Do 2–3 (web views, work on Free), then **stop** before 3b with
     the setup item. A rerun resumes there: re-read
     `commcare_get_subscription` and continue only once it is paid.
   - **`--keep-shared connect`:** nothing in the clone needs the API. Continue.
     Step 5's release-check reports the `hq-plan-free` blocker, and the
     operator does the step during `/ace:release` (Step 0.4).

   Then `commcare_list_apps(domain: <hq_domain>)`: `200` → `clone.hq.api:
   enabled`; `HQ_API_NOT_IN_PLAN` → `clone.hq.api: not-in-plan`. On a space
   that reads paid, `not-in-plan` is a defect to report, not a setup item. The
   copy, build, release and reviewers' web access are web views and work
   either way. `clone.hq.api` decides 3b and is reported in 4b and Step 6.
2. For `learn` and `deliver`: `commcare_linked_app_copy(upstream_domain:
   <source products.apps.<k>.domain>, upstream_app_id: <source hq_app_id>,
   downstream_domain: <hq_domain>, name: <source app name>, linked: false,
   build_id: <the source's released build id, when products.apps.<k> records
   one>)`. Copy the RELEASED build the source run was reviewed on, not "latest
   saved", which may carry later edits.
   Unlinked: no Pro Edition needed; the copy keeps camera-only and grid-menu
   settings. The atom reads the new id from HQ's redirect, so it works on a
   `not-in-plan` space. **A timeout does not mean it failed** — before any
   retry, look: `commcare_list_apps` on an `enabled` space, else the HQ project
   dashboard (`/a/<hq_domain>/dashboard/project/`, session auth) lists every
   app id. A blind retry makes a duplicate.
3. `commcare_make_build` then `commcare_release_build` for each new app.
3b. **Mint the opportunity's HQ key, restricted to this space** — skip it, and
   record `clone.hq.key: {status: skipped, reason}`, when `--keep-shared
   connect` (no opportunity will use it) or `clone.hq.api: not-in-plan` (a key
   restricted to a space without API access reaches nothing). Otherwise:
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
5. Cross-space unlinked copy is live-verified (connect-ace-prod →
   connect-ace-spark, 2026-09-29: Learn at latest, Deliver at its released
   build, both then built and released).

**Not in v1:** HQ mobile workers — no tool creates them. Report it as a manual
step.

### 4b. Connect — re-run Phase 4 in the target's orgs

**Needs `clone.hq.api: enabled`.** Connect reads the apps it is pointed at
through HQ with the opportunity's key, so 4b runs only after 4a.1b's
Enterprise flip has been read back as paid. 4a stops before 3b otherwise.
No clone has yet run 4b end to end on an ace-enterprise space. Record what
Connect returns on the first one, so the next clone knows.

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
   - Target `opp.yaml`: `update_yaml_file(merge: "two-level", patch:
     {connect: null})`. It names the SOURCE program, and
     `connect-program-setup` reuses whatever program is recorded there — which
     would put the clone's opportunity back in the shared org. (The session is
     bound in enforce mode, so the guard would refuse those writes anyway;
     clearing it avoids the detour.) `update_yaml_file` has no delete; `null`
     is the clear.
   - Target `run_state.yaml`: `update_yaml_file(merge: "two-level", patch:
     {phases: {connect-setup: {status: pending, products: {}}}})`.
     **Not `deep`**: a deep merge of `products: {}` changes nothing and the
     source's Connect products survive in the clone. `two-level` replaces the
     `connect-setup` child wholesale and leaves the other phases alone.
     Read it back and confirm `products` is empty.
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

## Step 5 — Release-check the clone (report, do not block)

Run `Skill(release-check)` on `<to>/<opp>/<run-id>` — the CLONE, in the target
workspace — so the clone tells you at once whether it is releasable. It writes
`release-check_verdict.yaml` + `release-check_report.md` into the cloned run.
NOT READY does not undo or fail the clone; its blockers go into the report below
under "Before `/ace:release`", each with its owner and fix.

## Step 6 — Report

One line per system: `created` (with ids / URLs read back — `commcare_list_apps`
on the new domain, or the HQ project dashboard on a `not-in-plan` space; not the
call's own return value) and the HQ space's plan (`commcare_get_subscription`:
edition, or the 4a.1b superuser setup item if it is still Free), or `NOT DONE` + reason, plus the Drive-link read-back
(source ids remaining in the target run_state: expected 0 outside comms-logs),
plus every manual setup item, plus Step 5's release-check verdict and its
blockers. End with: "Nothing was shared with anyone. When
everything is ready, run `/ace:release <to>/<opp>/<run-id>`."
