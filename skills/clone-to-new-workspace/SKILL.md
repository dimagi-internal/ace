---
name: clone-to-new-workspace
description: >
  Copy a completed ACE run into another ace-web workspace and rebuild its
  assets in the HQ space and Connect orgs the operator sets up from ACE's
  checklist, so it can be reviewed without exposing anything else. No
  invites (that is `release`). Use before an external review.
disable-model-invocation: false
---

# clone-to-new-workspace

`/ace:clone-to-new-workspace <opp>/<run-id> --to <workspace> [--from <workspace>] [--hq-domain <slug>] [--pm-org <slug>] [--nm-org <slug>] [--co-owner <email>] [--keep-shared connect]`

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

- **Invite anyone.** Reviewers are invited last, by `release`, after
  `validate-release-readiness` has checked and repaired everything and planned
  every grant — nobody should see a half-built clone.
- **Redirect the source's links.** That is an explicit, opt-in item of the
  release plan (`--forward-source`), and validation refuses it for a source in
  another workspace (every clone's case) unless the operator overrides it.
- **Create the HQ project space, turn on its demo mode, or flip the two
  staff-only Connect org settings.** The operator does those, from one checklist
  ACE prints at the start (Step 0.6) — operator decision, Jon 2026-10-02: *"When
  we are doing a clone, have me create the HQ space and turn on demo mode, and
  then have me manually create a PM and NM org for you to use, and give me clear
  URLs to click to do all of this efficiently."* Demo mode ("Test or Demo
  Project") is superuser-only, so a human is always on the path; doing it up
  front, in one sitting, replaces a clone that stalled midway on each item in
  turn. ACE no longer calls `commcare_create_domain` here.
  **The Connect orgs themselves are ACE's since 2026-10-07** (Step 0.6b):
  ace@ holds `all_org_profile_edit_access` (dimagi/commcare-connect#1580), so
  ACE creates `<to>-pm-test` and `<to>-nm-test` and is their Admin. That
  permission cannot set **Program manager** (`OrganizationChangeForm` drops the
  field without staff `ORG_MANAGEMENT_SETTINGS_ACCESS` — absent on ace-pm-org's
  home for ace@, live 2026-10-07) and nothing outside Django admin sets **Is
  test** (`AdminOrganizationForm`), so those two ticks stay on the checklist,
  one Django admin page per org.
- **Create an OCS team.** The bot is reviewed by its public link (4d).

What stays ACE's job: the target workspace, its Drive root and its default
tenancy (Step 0), accepting the operator's invitations to ace@ and verifying
every checklist item (Step 0.7), and every rebuild (Step 4).

## Inputs

- `<opp>/<run-id>` — the source run.
- `--from <workspace>` — source workspace; default `$ACE_WEB_WORKSPACE`.
- `--to <workspace>` — target workspace. Its **default tenancy** (ace-web
  Workspace Settings / `PATCH /api/workspaces/<slug>` `default_tenancy`) says
  where the rebuilt assets go.
- `--hq-domain <slug>` — the HQ project space the operator created (checklist
  item 1). Unknown on a first call: the checklist then suggests
  `connect-ace-<to>` (HQ caps names at 25 chars) and asks for the slug.
- `--pm-org <slug>` / `--nm-org <slug>` — the two Connect orgs: the one that
  runs the program, and the one that holds the opportunity. **Default:
  `<to>-pm-test` / `<to>-nm-test`** (naming convention, Jon 2026-10-07), which
  ACE creates itself (0.6b). Pass them only to reuse orgs that already exist.
- `--keep-shared connect` — **escape hatch only, not the default.** Keeps the
  source's Connect program + opportunity in the shared orgs instead of
  rebuilding them (4b skipped), drops the Connect items from the checklist, and
  takes the shared orgs as the target's Connect tenancy (Step 1.3 then accepts
  them). Use it only when the operator explicitly asks for it, e.g. a review
  that cannot wait for org setup. `release` then needs `--allow-shared connect`
  to grant Connect at all, and every such grant opens every ACE opportunity in
  those orgs.
- `--co-owner <email>` — a human to invite as an owner of a workspace Step 0
  creates (default: the operator who asked, e.g. `jjackson@dimagi.com`), so
  the workspace is not visible to ace@ alone.

Auth: `ACE_WEB_BASE_URL` + `ACE_WEB_PAT_TOKEN` (same as `fork-run`). The PAT's
owner must be an **owner of both** workspaces.

## Step 0 — Target workspace, operator setup, verified tenancy

The workspace is ACE's to create (0.1–0.4), and so are the two Connect orgs
(0.6b). The HQ space and the two staff-only org settings are the operator's
(0.6); ACE accepts its HQ invitation, verifies every item (0.7), and only then
writes them into the workspace's default tenancy (0.8).
Skip any part that already holds.

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
5. **Read the current tenancy.** `GET …/api/workspaces/<to>` →
   `default_tenancy`. A 403 means ace@ is a member but not an owner of an
   existing `<to>` — that IS a human item ("an owner of `<to>` makes
   ace@dimagi-ai.com an owner"). Take the slugs for the checklist from the
   flags first, then from this tenancy (`hq_domain`, `connect_pm_org`,
   `connect_holding_org`) — but never a value equal to the SOURCE opp's
   (`GET …/api/w/<from>/opps/<opp>/tenancy`): that is the shared tenancy, which
   Step 1.3 refuses (the Connect pair excepted under `--keep-shared connect`).
6. **Operator setup checklist — print it and stop.** Unless every slug is
   known AND 0.7 passes for it, print the checklist **verbatim** — the script
   is the single source of its URLs; never paraphrase or re-derive them:

   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/clone-setup-checklist.ts" print --workspace <to> \
     [--hq-domain <slug>] [--pm-org <slug>] [--nm-org <slug>] [--skip-connect]
   ```

   (`--skip-connect` only with `--keep-shared connect`.) It is one message, in
   the operator's order: (1) create the HQ space at
   `https://www.commcarehq.org/register/domain/`, turn on demo mode (Test or
   Demo Project, superuser), invite `ace@dimagi-ai.com` as Admin; (2) on each
   org's Connect Django admin page
   (`/admin/organization/organization/?q=<org>`), tick **Program manager** on
   `<to>-pm-test` and **Is test** on both — each with its exact URL. **Run 0.6b
   first** so the orgs exist when the operator opens those pages. Send it to
   the operator (in a turn: the reply on the thread that asked for the clone)
   and **stop**: no ace-web copy, no rebuild. The operator replies with the HQ
   slug (when it was unknown) and "done"; rerun with it as a flag.

   **6b. Create the two Connect orgs (ACE, no human).** Skip with `--keep-shared
   connect`.

   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/clone-setup-checklist.ts" create-orgs --workspace <to> \
     [--pm-org <slug>] [--nm-org <slug>]
   ```

   Creates `<to>-pm-test` and `<to>-nm-test` at
   `https://connect.dimagi.com/register/organization/` with ace@ as Admin
   (never ticking "Create without becoming a member" — ace@ must invite and
   create programs and opportunities there). Connect builds the slug from the
   name, so slug = name. Idempotent: an org ace@ already administers is
   `exists` (fine on a rerun). **Stop** on `taken` (that slug is someone else's
   org — never adopt it) or `suffixed` (Connect created it under another slug:
   report it; do not proceed under the suffixed slug). Connect has no org
   delete yet (#1580 defers it), so every create is permanent — never create
   probe or throwaway orgs.
7. **Accept ACE's invitations, then verify.**

   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/clone-setup-checklist.ts" accept-invites --workspace <to> \
     --hq-domain <hq> --pm-org <pm> --nm-org <nm>      # or --skip-connect
   ```

   **ace@ joins by itself.** HQ and Connect invitations both need the invitee
   to accept, and ace@ can: the script finds each invitation in ace@'s mailbox
   (gog, identity from `config/agent.json`; HQ: *"Invitation from … to join
   CommCareHQ"*, link `/a/<hq>/settings/users/join/<uuid>/`; Connect: *"… has
   invited you to join … on Connect"*, link
   `/a/<org>/organization/invite/<token>/`) and accepts it with ACE's own
   session (HQ: an authenticated POST by the invited user; Connect: an
   authenticated GET). `no-invitation` means the operator has not sent it yet
   (item 1c); `already-used` is fine — the read-backs decide. The Connect orgs
   ACE created itself need no invitation; the script only looks for one when
   ace@ is not already their Admin (orgs passed by flag that someone else made). It then
   runs the session read-backs: HQ `/a/<hq>/settings/users/my_role/` →
   `is_domain_admin: true` (the space exists and ace@ is Admin; 404 = no such
   space); Connect `/a/<org>/organization/member_table` → 200 for each org
   (ace@ is Admin — admin-gated; NOT the org home, which since #1580 answers 200
   for every org ace@ can profile-edit, i.e. all of them) and
   `/a/<pm>/program/init/` → 200 (Program manager on; 404 really means off).
   **Is test cannot be read back by ace@** (it is only on the Django admin
   page); report it as the operator's tick, not as verified. Then the MCP read-backs:
   - `commcare_get_subscription(domain: <hq>)` → `is_paid_edition: true`
     (demo mode on — item 1b);
   - `commcare_list_apps(domain: <hq>)` → 200 (`HQ_API_NOT_IN_PLAN` = still on
     Free — item 1b);
   - `connect_list_programs(organization_slug: <pm>)` and
     `connect_list_opportunities(organization_slug: <nm>)` succeed.

   The full list with the checklist item that fixes each failure:
   `clone-setup-checklist.ts verify --workspace <to> --hq-domain … --pm-org …
   --nm-org …` (`verify --live` reruns the session read-backs without accepting
   anything). **Any failure: stop**, and send the operator only the failing
   items, quoted from the checklist with the slugs filled in. Never take the
   operator's "done" as the evidence; the read-backs are.
8. **Write the default tenancy.** `PATCH …/api/workspaces/<to>`
   `{"default_tenancy": {...merged}}` with the VERIFIED slugs:
   - `hq_domain`: `<hq>`;
   - `connect_pm_org`: `<pm>`, `connect_holding_org`: `<nm>` — with
     `--keep-shared connect`, the SOURCE opp's values instead;
   - `ocs_team`: leave empty (not used — 4d).
   Never overwrite an owner's different non-empty value: if `default_tenancy`
   already names a different HQ space or org, stop and report both. Read it
   back and print it.

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
   `hq_domain` (apps), `connect_pm_org` + `connect_holding_org` (Connect). `ocs_team` is not needed (see 4d). A missing field is a setup
   item: "workspace owner: set default_tenancy.<field>".
3. **Not a shared tenancy.** Compare with the SOURCE opp's tenancy
   (`GET …/api/w/<from>/opps/<opp>/tenancy`). A target field equal to the
   source's (e.g. `hq_domain: connect-ace-prod` in both) defeats the purpose —
   refuse it and name the field. **Exception:** with `--keep-shared connect`,
   equal `connect_pm_org` / `connect_holding_org` are accepted (say so in the
   report); every other field still must differ.
4. **Per system, one-time setup the target needs:**
   - **HQ and Connect:** Step 0.7 verified them (space exists with ace@ as
     Admin, paid plan, API open; both orgs with ace@ as Admin, Program Manager
     on). On a resume, rerun `clone-setup-checklist.ts verify --live` and the
     four MCP read-backs rather than trusting an earlier pass; a failure sends
     the operator back to the named checklist item. (Existence is read from
     `my_role`, not `commcare_list_apps`: HQ answers the same
     `HQ_API_NOT_IN_PLAN` 401 for a space on Free and for one that does not
     exist — ace#2551.) No program application is needed up front: Phase 4
     creates the program, then sends and accepts the holding org's application
     itself (4b). With `--keep-shared connect` the Connect checks are skipped:
     the shared orgs are the ones every run already writes to.
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
has rewritten every source Drive id in every YAML file of the target run
(`run_state.yaml`, `decisions.yaml`, each `previews/<output>/_previews.yaml`,
the Phase 6 capture manifest, verdicts, …) to its copy, and given each copy
its original's anyone-with-link role (ace-web#829, ace-web#851) — and, since
its ace#2607 fix, every other TEXT copy too: markdown and plain files keep their
own type, and Google Docs are retargeted in place through the Docs API (link
targets and visible ids; formatting untouched). Read-back before Step 4. It
checks every text copy and every Doc's hyperlink TARGETS, not only YAML — the
YAML-only check passed a clone whose partner-facing onboarding email linked
the source's FAQ, deck and quick-reference card, and whose FLW guide hid 23
source screenshot links behind its link text (ace#2607):

```bash
npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/clone-drive-readback.ts" \
  --source <source-run-folder-id> --target <target-run-folder-id>
```

Exit 0 means clean. Exit 1 means `hits[]` lists each copied file that still names a
source file, with that file's path. `left_behind[]` lists comms-log ids, which
are expected: those files are deliberately not cloned. `provenance[]` lists ids
in the decisions log and eval/QA records — history, left as is, never a
failure. On exit 1, the rewrite did not run or did not reach those files (an
ace-web without its ace#2607 fix rewrote YAML only). Repair through the guarded atoms,
never by hand-patching text: add `--plan <scratch-dir>` and apply `plan.json` —
`action: update` → `drive_update_file(fileId, localFilePath)` (keeps a plain
file's type on an MCP ≥ ace#2215; re-check the type after on an older one),
`action: docs` → `docs_batch_update(fileId, requests)` from `requestsPath`
(link-only `updateTextStyle` + `replaceAllText`; a formatted Doc is never
written back as text) — then re-run without `--plan`. Record the hit count as
`clone.drive_ids.source_ids_remaining`. History: the first Spark clone, before
#829, had 99 ids / 125 occurrences in run_state and 26 copies without their
sharing, all fixed by hand. The second passed a run_state-only grep while
every `_previews.yaml` still named the source's frames, so ace-web showed 12
outputs with no screenshots (ace#2603). Logic: `lib/clone-readback.ts`.

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

1. **The space is the operator's** (Step 0.6, item 1) — ACE does not create
   it. Re-read it here, because 3b and 4b depend on it:
   `commcare_get_subscription(domain: <hq_domain>)` must read
   `is_paid_edition: true` (Test or Demo Project puts it on Enterprise, not
   invoiced — sanctioned by accounts, Gillian Javetski, 2026-10-02), and
   `commcare_list_apps(domain: <hq_domain>)` must answer 200. Record
   `clone.hq.plan: {edition, is_paid_edition}` and `clone.hq.api: enabled`
   from the reads, never from the operator's "done". Either read failing means
   Step 0.7 was skipped or the space changed: **stop** and send the operator
   checklist item 1b — the demo-mode step, verbatim: `npx tsx
   "$CLAUDE_PLUGIN_ROOT/scripts/release-readiness.ts" hq-flip-steps --domain
   <hq_domain>`. Mechanism and what NOT to do instead:
   `playbook/integrations/commcare-api.md § New project spaces`. On a space
   that reads paid, `HQ_API_NOT_IN_PLAN` is a defect to report, not a setup
   item. The copy, build and release below are web views either way.
2. For `learn` and `deliver`: `commcare_linked_app_copy(upstream_domain:
   <source products.apps.<k>.domain>, upstream_app_id: <source hq_app_id>,
   downstream_domain: <hq_domain>, name: <source app name>, linked: false,
   build_id: <the source's released build id>)`. Read that id from the
   source's `3-commcare/app-release_summary.md` frontmatter
   `apps.<k>_app.build_id` — app-release's contracted record — and from run_state
   `products.apps.<k>` only when the summary has none (ace#2702). Copy the
   RELEASED build the source run was reviewed on, not "latest saved", which may
   carry later edits.
   Unlinked: no Pro Edition needed; the copy keeps camera-only and grid-menu
   settings. The atom reads the new id from HQ's redirect, so it works on a
   `not-in-plan` space. **A timeout does not mean it failed** — before any
   retry, look: `commcare_list_apps` on an `enabled` space, else the HQ project
   dashboard (`/a/<hq_domain>/dashboard/project/`, session auth) lists every
   app id. A blind retry makes a duplicate.
3. `commcare_make_build` then `commcare_release_build` for each new app. Then
   **re-record the clone's release in `3-commcare/app-release_summary.md`** —
   the copied file still describes the SOURCE's builds, and it is the one
   record of release state that `validate-release-readiness` and § 4e read
   (ace#2698, ace#2702). Rewrite its frontmatter `apps.learn_app` /
   `apps.deliver_app` from THIS step's reads: `{hq_app_id: <new app id>,
   build_id: <make_build's id>, version: <its version>, is_released: true,
   released_at: <release time>}`. Never copy a value from the source's file;
   the source builds stay recorded in run_state's `clone:` block, which § 4e
   leaves alone.
3b. **Mint the opportunity's HQ key, restricted to this space** — skip it, and
   record `clone.hq.key: {status: skipped, reason}`, only with `--keep-shared
   connect` (no opportunity will use it). Otherwise (the default):
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

**This runs by default.** With the operator's orgs verified in Step 0.7, the
clone rebuilds Connect for real: the program in the partner's program org, the
opportunity held by the partner's org, reading the apps 4a copied through the
space-restricted `hq-key:` from 4a.3b. Needs `clone.hq.api: enabled` (4a.1).
No clone has yet run 4b end to end on a Test or Demo space. Record what
Connect returns on the first one, so the next clone knows.

**Escape hatch — `--keep-shared connect`: skip this step.** Only when the
operator explicitly asked for it. Keep the target run's copied
`products.connect` and `opp.yaml` `connect:` block as they are (they name the
source program and opportunity in the shared orgs), and record
`clone.connect: {status: kept-shared, pm_org, holding_org, opportunity_id}`.
Report it loudly: the Connect opportunity still points at the SOURCE HQ apps
(`connect-ace-prod`), while the partner's HQ access is to the copies in
`<hq_domain>` — identical content, different project space. To end the
exception later, rerun the clone without the flag (the checklist then asks for
the two orgs, and 3b + 4b run). `release`
treats `kept-shared` as a shared tenant (only `--allow-shared connect` grants
it).

Otherwise (the normal path):

Connect cannot move an opportunity (its holding org is fixed at creation), so
the clone gets its own program and opportunity, built by the SAME Phase 4 skills
that built the source — not a hand-rolled copy of them. Requires 4a (the
opportunity must point at the rebuilt HQ apps).

1. **Step 0.7 already proved** both orgs exist with ace@ as Admin, the
   program org has Program manager on, and the holding org answers
   `connect_list_opportunities`. ACE created them in 0.6b — a missing one means
   rerun 0.6b, never a guess.
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
   - Target `decisions.yaml`: **retire the copied Phase 4 rows before Phase 4
     re-runs** (`docs/decisions-contract.md § Re-runs`). `decisions_append_rows`
     skips an id the log already holds, so a copied row silently beats the
     rebuild's own answer — or sits live next to a reworded one. The first
     Spark clone hand-minted `-spark` ids to get around it and still left
     `program-delivery-type` and `program-currency-usd-vs-mwk` live from the
     source build. Read the file with `drive_read_file writeToPath`, then:

     ```bash
     node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/decisions-retire-for-rerun.ts" \
       --decisions <local decisions.yaml> --phase-tags 4-connect \
       --label <from-workspace> --inherited-from <from-workspace>/<run-id> --out <local out>
     ```

     and write it back with `drive_update_file localFilePath`. Each live
     `4-connect` row moves to `<id>-<from-workspace>`, marked `superseded_by:
     <id>` + `inherited_from_run`; the Phase 4 re-run then appends under the
     canonical ids. Human rulings stay live.
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
   rebuilt. Its `connect-opp-setup` re-emits the Phase 4 decision rows
   (verification-rule, latitude and ambiguity rows) against the clone's own
   products.
4. Read back `connect_get_opportunity(holding_org, <new id>)`: its
   `learn_app` / `deliver_app` `cc_domain` must be `tenancy.hq_domain`. Record
   `clone.connect: {status: done, program_id, opportunity_id, pm_org,
   holding_org}`. A Phase 4 halt is `NOT DONE` with its reason — never fall
   back to the source opportunity.

### 4c. Labs — deliberately not touched

The run's Phase 7 labs assets (synthetic opps, program, registry, dashboards)
stay exactly as they are, and both runs keep pointing at them. **The clone does
not widen who Labs shows them to.** Labs keeps its own default — Dimagi
accounts only (`@dimagi.com` / `@dimagi-ai.com`) — and `synthetic_set_allowed_domains`
is not called here. ace-web removed the workspace's `labs_allowed_domains`
setting on 2026-10-08 (Jonathan: *"just delete that setting, I don't think it
clearly means anything"*), so there is no per-partner Labs scope to rebuild or
read. No access mechanism replaces it yet: **a partner is not opened onto Labs
dashboards by a clone or a release**, and the run summary tags every Labs link
`admin only`. Do not invent one here — that is the owner's decision.

Leave `products.synthetic` unchanged in the target run. Do not write a
`clone.labs` block.

### 4d. OCS — deliberately not rebuilt

The bot stays on ACE's OCS team and the copied `products.ocs_chatbot` is kept
as is. Reviewers chat with it through its public link (`public_url`), which
needs no OCS account and exposes nothing else on the team (Jon, 2026-09-28:
no OCS accounts for reviewers). OCS permissions are team-wide — there is no way
to let someone into OCS and see only one bot — so a per-partner OCS team is
only worth it when a partner takes the bot over, which is a handover step, not
a clone step. Record `clone.ocs: {status: kept, reason: public-link}` and
report the `public_url`.

### 4e. Rewrite the copied run's references to the source's assets

4a/4b rewrite `products.*`; nothing above rewrites the PROSE. Every copied
Phase 3/5/6/7 document still names the source's HQ space, app and build ids
and versions, and its Connect program, opportunity and orgs — the partner's
LLO guide pointed at `connect-ace-prod` and an `ace-nm-org` opportunity URL
on the first Spark clone (ace#2606). Run this after 4a and 4b (and again if
either is redone); it is idempotent:

```bash
npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/clone-asset-rewrite.ts" \
  --source <source-run-folder-id> --target <target-run-folder-id> --out <scratch-dir>
```

It reads both run_states and both `3-commcare/app-release_summary.md` files
(released build ids/versions come from the summary — run_state is only the
fallback, ace#2702), pairs every asset that moved, and writes rewritten
files plus `plan.json` — it writes nothing to Drive. What it does per file
(`lib/clone-asset-refs.ts`):

- **rewrite** — ids, 8-char prefixes, the HQ space, Connect URLs/org slugs,
  the opportunity int id in context, and build versions next to their build
  or app; plus one "Copied into the `<to>` workspace for review from …" note
  at the top naming each source → copy pair.
- **note** — eval/QA records (`*_verdict*.yaml`, `*_result.yaml`) describe
  what a judge saw on the SOURCE assets, so they get the note only, never a
  rewrite.
- **left on source** (listed, untouched) — the decisions log (the source's
  Phase 4 rows are superseded by 4b's own), `4-connect/` after 4b re-authored
  it, the `clone:` block, and `phases.solicitation-management` + its folder:
  a Phase 8 solicitation on the source program is an operator decision, not a
  rewrite. Report each in Step 6.

Apply `plan.json`, then re-run the command — `changes: 0` is the read-back:

- `action: update` → `drive_update_file(fileId, localFilePath)`. It keeps a
  plain file's own type (`text/markdown`, `text/yaml`) since ace#2215 — on an
  MCP older than that fix, a `text/yaml` / `text/markdown` file comes back
  `text/plain`.
- `action: render` → `drive_create_doc_from_markdown(name, parentFolderId,
  localFilePath)` (find-or-update in place). A styled Doc (headings, bullets,
  tables) must never be written back as plain text — that flattens it. A
  render drops the Doc's inline images, so every entry with
  `reembed_screenshots: true` must have its screenshots re-embedded next:
  `scripts/embed-doc-screenshots.ts <fileId> --screenshots <id>` once per
  `plan.frames.preview_folders` entry, plus the folders
  `app-screenshot-capture_manifest.yaml` names (`drive_folders.screenshots`).
- `run_state` → `update_yaml_file(fileId, localFilePath, merge: "deep")`;
  each changed phase key is sent whole, arrays included.

**Frames are re-pointed too (ace#2697).** 4b re-runs Phase 4, and Phase 4
re-captures `4-connect/previews/<slug>/` in the partner's holding org. A
re-capture replaces the frames, so they get new ids. The guides still link and
embed the earlier frames, which show the SOURCE org's header. On
spark/spark-facilitator/20261004-1706 the LLO guide named the clone's
opportunity, but both of its Connect frames read `ace-nm-org`. The script reads
every Drive id a rewrite-class file cites, including a Doc's link targets and
the images it embeds. Each id that is no longer a live file in the target run
is paired with the live file at the same run path (`plan.frames.repointed`,
`lib/clone-frame-repoint.ts`). The links are rewritten in the plan's files.
Any Doc that embeds a stale frame becomes a `render` entry, so the re-embed
step puts the target's frames in. This only works after 4b's capture, so run
4e after 4b, as above.

- `plan.frames.foreign` lists cited images with no live counterpart in the
  target run. Cross-opp baselines under `ACE/_common/` are exempt. The script
  exits **3** and the clone is NOT DONE until each one is re-captured in the
  target, or its citation is removed by the producing skill.
- **The read-back.** Re-run the script after applying the plan. It must show
  `changes: 0` and an empty `frames.embedded_outside_run`. A Doc that still
  embeds an image outside the target run with nothing left to apply also
  exits 3.

Never hand-edit a Doc's `text/plain` export and write it back: the export
turns n newlines into 2n−1 CRLFs, so every round trip doubles the blank
lines. The script reads Docs through `docTextFromExport`, which inverts it.
Record `clone.asset_refs: {status: done, files, left_on_source,
frames_repointed}`.

## Step 5 — Validate the clone's release readiness (report, do not block)

Run `Skill(validate-release-readiness)` on `<to>/<opp>/<run-id>` — the CLONE,
in the target workspace — so the clone tells you at once what stands between it
and a release. Pass the reviewers if the operator named them; without them the
verdict is NOT READY by construction (`reviewers-missing`) and everything else
is still checked and repaired. It writes `release-readiness_verdict.yaml` +
`release-readiness_report.md` into the cloned run. NOT READY does not undo or
fail the clone; its blockers go into the report below under "Before
`/ace:release`", each with its owner and fix.

## Step 6 — Report

One line per system: `created` (with ids / URLs read back — `commcare_list_apps`
on the new domain; not the call's own return value) and the HQ space's plan
(`commcare_get_subscription`: edition), or `NOT DONE` + reason, plus the Drive-link read-back
(source ids remaining in the target run_state: expected 0 outside comms-logs),
plus 4e's rewrite (files changed, and every place left on the source on
purpose — e.g. the Phase 8 solicitation), plus every manual setup item, plus Step 5's release-readiness verdict and its
blockers. End with: "Nothing was shared with anyone. Next:
`/ace:validate-release-readiness <to>/<opp>/<run-id> --reviewers <email[:role]>,…`
— it checks and fixes everything and, when READY, shows you exactly what will
be shared and every email. Then `/ace:release <to>/<opp>/<run-id> --reviewers …`
(the same reviewers) shares exactly that, and nothing else."
