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
one Connect org pair, one OCS team, one set of Dimagi-only Labs programs). Granting an outsider
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
- **Turn on the HQ space's demo mode, or flip the two staff-only Connect org
  settings.** The operator does those, from one checklist ACE prints at the
  start (Step 0.6). Demo mode ("Test or Demo Project") is superuser-only, so a
  human is always on the path; doing it up front, in one sitting, replaces a
  clone that stalled midway on each item in turn. **The checklist asks only for
  what ace@ cannot do** (owner, 2026-10-15, ace#3014: *"for 1, you should create
  it and make yourself admin, you just tell me to fix the subscription after
  you've created it (that's how this should work in general). for 2, you
  shouldn't be telling me to go through django admin, there is a proper edit
  page I just need to toggle for you"*). So **ACE creates the HQ space itself**
  (Step 0.6a, `commcare_create_domain`; the creator is its Admin, so there is no
  invitation), and **ACE creates the Connect orgs itself** (Step 0.6b; ace@
  holds `all_org_profile_edit_access`, dimagi/commcare-connect#1580) and is
  their Admin. ace@'s view of an org's edit page omits **Program manager**
  (`OrganizationChangeForm` drops staff-only fields without
  `ORG_MANAGEMENT_SETTINGS_ACCESS`, live 2026-10-07), so the operator toggles
  it on the program org's edit page,
  `https://connect.dimagi.com/a/<org>/organization/` — never Django admin.
  **There is no "Is test" item**: that edit page has no Is test toggle (owner,
  live, 2026-10-15), the clone of `dimagi-team/noora-health/20261015-1129` went
  on without it, and no read-back in 0.7 ever needed it. Do not send the
  operator to Django admin for it.
- **Create an OCS team.** The bot is reviewed by its public link (4d).

What stays ACE's job: the target workspace, its Drive root, the HQ space, the
two Connect orgs and its default tenancy (Step 0), verifying every checklist
item (Step 0.7), and every rebuild — one script, `scripts/clone-run.ts`
(Steps 1–4), so the model's part after Step 0 is: run it, read it back, report.

## Inputs

- `<opp>/<run-id>` — the source run.
- `--from <workspace>` — source workspace; default `$ACE_WEB_WORKSPACE`.
- `--to <workspace>` — target workspace. Its **default tenancy** (ace-web
  Workspace Settings / `PATCH /api/workspaces/<slug>` `default_tenancy`) says
  where the rebuilt assets go.
- `--hq-domain <slug>` — the HQ project space. Normally omitted: ACE creates
  `connect-ace-<to>` (HQ caps names at 25 chars) in Step 0.6a and uses the slug
  HQ returns. Pass it only to reuse a space that already exists.
- `--pm-org <slug>` / `--nm-org <slug>` — the two Connect orgs: the one that
  runs the program, and the one that holds the opportunity. **Default:
  `<to>-pm-test` / `<to>-nm-test`** (naming convention, Jon 2026-10-07), which
  ACE creates itself (0.6b). Pass them only to reuse orgs that already exist.
- `--keep-shared connect` — **escape hatch only, not the default.** Keeps the
  source's Connect program + opportunity in the shared orgs instead of
  rebuilding them (stage `connect` skipped), drops the Connect items from the checklist, and
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

The workspace is ACE's to create (0.1–0.4), and so are the HQ space (0.6a)
and the two Connect orgs (0.6b). Only HQ demo mode and the two staff-only org
settings are the operator's (0.6); ACE verifies every item (0.7), and only then
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
   known AND 0.7 passes for it, run 0.6a and 0.6b first (so the space and the
   orgs exist when the operator opens their pages), then print the checklist
   **verbatim** — the script is the single source of its URLs; never
   paraphrase or re-derive them:

   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/clone-setup-checklist.ts" print --workspace <to> \
     --hq-domain <hq> [--pm-org <slug>] [--nm-org <slug>] [--skip-connect]
   ```

   (`--skip-connect` only with `--keep-shared connect`; `--hq-domain` is
   required — it is the slug 0.6a recorded.) It is one message asking only for
   what ace@ cannot do: (1) turn on demo mode (Subscription Type → Test or Demo
   Project, HQ superuser) at
   `https://www.commcarehq.org/a/<hq>/settings/project/internal_subscription_management/`;
   (2) on the program org's Connect edit page,
   `https://connect.dimagi.com/a/<to>-pm-test/organization/`, toggle **Program
   manager** — with its exact URL. Nothing for `<to>-nm-test`. It never asks the operator to create the space, invite ace@, or open
   Django admin. Send it to the operator (in a turn: the reply on the thread
   that asked for the clone) and **stop**: no ace-web copy, no rebuild. The
   operator replies "done"; rerun with the same flags.

   **6a. Create the HQ space (ACE, no human).** Skip when `--hq-domain` (or the
   tenancy from 0.5) names a space whose `my_role` read-back already says
   ace@ is Admin (`clone-setup-checklist.ts verify --live --workspace <to> --hq-domain <hq>` →
   `hq-admin` ok). Otherwise:
   `commcare_create_domain({hr_name: "connect-ace-<to>"})` — at most 25
   characters, cut and with no trailing hyphen
   (`suggestedHqDomain` in `lib/clone-setup-checklist.ts`). **Record the
   returned `domain`** and use it as `<hq>` from here on; HQ derives the slug
   from the name, so never assume they match. ace@ is the creator, so it is the
   space's Admin with no invitation. **Stop** on "already taken" — that name is
   someone else's space; report it and never adopt it. Every create is
   permanent, so never create probe or throwaway spaces.

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
7. **Accept any invitations, then verify.**

   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/clone-setup-checklist.ts" accept-invites --workspace <to> \
     --hq-domain <hq> --pm-org <pm> --nm-org <nm>      # or --skip-connect
   ```

   **Normally there is nothing to accept.** ACE created the HQ space (0.6a)
   and both orgs (0.6b), so it is already their Admin, and the script looks
   for an invitation only when the read-back says ace@ is NOT (a space or org
   passed by flag that someone else made). For those, ace@ joins by itself:
   the script finds the invitation in ace@'s mailbox (gog, identity from
   `config/agent.json`; HQ: *"Invitation from … to join CommCareHQ"*, link
   `/a/<hq>/settings/users/join/<uuid>/`; Connect: *"… has invited you to join
   … on Connect"*, link `/a/<org>/organization/invite/<token>/`) and accepts it
   with ACE's own session (HQ: an authenticated POST by the invited user;
   Connect: an authenticated GET). `no-invitation` means nobody invited ace@ to
   a space it did not create; `already-used` is fine — the read-backs decide,
   never the presence of an invitation. It then
   runs the session read-backs: HQ `/a/<hq>/settings/users/my_role/` →
   `is_domain_admin: true` (the space exists and ace@ is Admin; 404 = no such
   space); Connect `/a/<org>/organization/member_table` → 200 for each org
   (ace@ is Admin — admin-gated; NOT the org home, which since #1580 answers 200
   for every org ace@ can profile-edit, i.e. all of them) and
   `/a/<pm>/program/init/` → 200 (Program manager on; 404 really means off).
   There is no Is test check: the operator cannot set it on the edit page and
   nothing downstream needs it (ace#3014). Then the MCP read-backs:
   - `commcare_get_subscription(domain: <hq>)` → `is_paid_edition: true`
     (demo mode on — item 1a);
   - `commcare_list_apps(domain: <hq>)` → 200 (`HQ_API_NOT_IN_PLAN` = still on
     Free — item 1a);
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

## Steps 1–4 — run the clone script (one command, ~10 minutes)

Everything after Step 0 is ONE deterministic, idempotent, resumable script
(ace#3021). Do not drive these steps by hand, and do not dispatch the Phase 4
agent: the source run_state already records every value the rebuild needs,
so a clone needs no judgement — only the operator toggles of Step 0 do.

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/clone-run.ts" \
  --from <from> --to <to> <opp>/<run-id> [--keep-shared connect]
```

(`$ACE_ROOT` = `$CLAUDE_PLUGIN_ROOT`, the installed plugin.) Add `--plan` first
to print which stages will run without touching anything. It prints one JSON
report on stdout (progress on stderr) and exits **0** when every stage is
final, **3** when it finished with stages not done (`not_done[]`, each with its
`reason`), **2** on a usage or precondition error (nothing written).

**Resume = run the same command again.** Every stage records its result in the
TARGET run_state's root `clone:` block (`clone.<stage>.status`), and a stage
whose status is final is skipped; a stage that stopped part-way resumes from
the ids it recorded. `--only <stage,…>` runs just those, `--redo <stage,…>`
forces them (e.g. `--redo asset_refs` after a re-capture). Code:
`scripts/clone-run.ts` (I/O) over `lib/clone-run.ts` (every decision, unit
tested in `test/lib/clone-run.test.ts`).

What it does, stage by stage — the rules each one keeps:

1. **Preflight** (before any write). The source run must exist and record
   `products.apps.{learn,deliver}.hq_app_id` and a RELEASED build for each; the
   target's `default_tenancy` must name `hq_domain` (+ both Connect orgs unless
   `--keep-shared connect`), and **no field may equal the source opp's tenancy**
   (the Connect pair excepted under `--keep-shared connect`). Any gap exits 2.
2. **`ace_web`** — `POST …/runs/<run-id>/clone {to_workspace}`, then poll
   `…/clones` until `done`. An existing `done` record into `<to>` is reused, a
   record still `copying` is never re-POSTed, and `error` is reported (a rerun
   re-POSTs, which replaces the partial run). Comms-logs are not copied.
3. **Bind.** Once the copy exists the script binds THIS session to `<to>/<opp>`
   (`bin/ace-bind`, enforce) and stops if the session is already bound to any
   other opp — never clear or rebind to get a write through. Every write the
   script makes outside MCP goes through the same rules the hook applies to
   MCP calls: tenant arguments (`config/tenancy-targets.json`'s mapping,
   `checkTenantWrite`) and Drive targets (`lib/drive-tenancy-guard.ts`
   `checkDriveWrite`, inside the opp's folder). Reads FROM the source are
   never checked.
4. **`summary_url`** — the copied run_state's `ace_web_summary_url` becomes
   `${ACE_WEB_BASE_URL}/opps/<to>/<opp>/runs/<run-id>/summary` (the source's
   would send a reviewer to a workspace they cannot open).
5. **Drive ids** (`clone.drive_ids`) — `scripts/clone-drive-readback.ts`; on hits it applies its
   `--plan` (plain files rewritten keeping their type, Docs retargeted with
   link-only `docs` requests — never flattened to text) and reads back again.
   Records `clone.drive_ids.source_ids_remaining`; `left_behind` (comms-logs)
   and `provenance` (decisions log, eval records) are not failures.
6. **`hq`** (was § 4a). Requires `commcare_get_subscription(<hq>)` →
   `is_paid_edition: true` (demo mode, checklist item 1a — else not-done with
   `scripts/release-readiness.ts hq-flip-steps --domain <hq>`). For learn and
   deliver: `linked_app_copy` (unlinked) **from the source's RELEASED build id**
   — `3-commcare/app-release_summary.md` frontmatter first, run_state
   `released_build_id` only as the fallback (ace#2702), never "latest saved" —
   then `make_build` and `release_build`. **A timeout is not a failure:** every
   create is look-then-create (`lookThenCreate`) — it looks first
   (`commcare_list_apps` by name, or the recorded id), and a create that
   times out is recorded `ambiguous` and looked for again; if it still isn't
   there the stage stops WITHOUT retrying, and the next run looks before it
   does anything. Only after checking by hand: `--retry-ambiguous hq.learn`
   (or `hq.deliver`, `connect.program`, `connect.application`,
   `connect.opportunity`, `connect.payment_units`). Then **3b**: mints the
   opportunity's key **restricted to this space** (`ace-clone-<hq>`, stored
   owner-only, only `hq-key:` travels; skipped under `--keep-shared connect`;
   never rotated once the clone's opportunity uses it). Rewrites
   `phases.commcare-setup.products.apps` (domain, `hq_app_id`, `hq_url`,
   released build; Nova ids kept). HQ mobile workers are still a manual step.
7. **`release_summary`** — re-records the clone's
   `3-commcare/app-release_summary.md` frontmatter `apps.learn_app` /
   `deliver_app` from THIS clone's builds (`rewriteReleaseSummary`; never a
   value copied from the source's file). § 4e rewrites its prose.
8. **`connect`** (was § 4b) — Connect is re-built in the target's orgs with
   the SAME values the source was built with, transcribed, not re-derived
   (`connectBuildSpec`, each value's provenance in the report): run_state
   `products.connect` (opportunity name, payment units, verification rules,
   test-user phone), then the PDD numbers the run recorded
   (`products.pdd.program_parameters`: delivery type id, currency, country,
   dates, budget, passing score, submission window, duration), then read-only
   reads of the source's own program and opportunity (name, descriptions,
   the post-headroom program budget, the Learn description). Then: program in
   `connect_pm_org` → invite `connect_holding_org` → accept (the ace#2954
   authority gate: only an org ACE controls accepts for itself — an org ACE
   created in 0.6b must be in `ACE_CONNECT_CONTROLLED_ORGS`) → opportunity
   **HELD by the NM org** (`target_organization_slug`, create-time only; a
   create that lands in another org stops, there is no repair) reading the
   apps of stage `hq` through the space-restricted `hq-key:` → payment units
   (deliver units mapped by slug onto the target's, `total_budget` passed) →
   verification rules **at the PM org URL** (`form_field_rules_saved` must read
   back) → Learn passing score read back and repaired if the create discarded
   it (ace#1350) → activate → ACE test user invited and read back
   (`connect_list_flw_invites`) → `connect_get_opportunity` at the holding org
   must show both apps in `<hq>`. Writes `opp.yaml connect.program` and
   `phases.connect-setup.products.connect` (Phase 4's shape). A target whose
   `products.connect` an earlier attempt already built **in the target's
   orgs** is adopted after the same read-backs, never built twice. The copied
   Phase 4 decision rows stay valid: the values are the source's, verbatim.
   **`--keep-shared connect`** (escape hatch, only on the operator's explicit
   ask): records `clone.connect: kept-shared`; the copied products keep naming
   the source program/opportunity in the shared orgs (which read the SOURCE HQ
   apps) and `release` needs `--allow-shared connect` — report that loudly.
9. **`labs`** (§ 4c below) — `rebuildLabs` in `lib/clone-run.ts`. Labs is
   REBUILT as a COPY in the clone's own labs program (ace#3020), never widened
   in place. The copy is blocked on a labs atom gap (connect-labs#2571), so the
   stage records `not-done: labs atom gap …` and never regenerates data
   instead. Do NOT call `synthetic_set_allowed_domains` by hand (it REPLACES the
   list, ace#2713).
10. **`ocs`** (§ 4d) — kept on ACE's team; reviewers use its `public_url`
    (no OCS accounts — team-wide permissions). Recorded `kept`.
11. **`asset_refs`** (§ 4e) — `scripts/clone-asset-rewrite.ts` over the copied
    prose (HQ space, app/build ids and versions, Connect program/opportunity/
    org slugs, frames re-pointed — ace#2606, ace#2697), then the script applies
    `plan.json`: `update` keeps a plain file's type, `render` re-imports a
    styled Doc from markdown (never written back as text — that flattens it)
    and re-embeds its screenshots (`embed-doc-screenshots.ts`, the target's
    `previews/` folders), and the run_state patch merges deep. The read-back
    re-runs the rewrite: `changes: 0` and exit 0, else not-done (exit 3 =
    `frames.foreign`: a cited image with no counterpart in the target run;
    re-capture it). Left on the source on purpose and reported: the decisions
    log, eval/QA records (note only), and Phase 8's solicitation.
12. **`readme`** — the run README re-rendered from the rewritten run_state.

Then the report's `products_check` must be empty (every rewritten product
names the target tenancy), and `clone.completed_at` is set once every stage is
final. On exit 3, read each `not_done` stage's `reason`: a setup item goes to
the operator (quoted from the Step 0 checklist), a refused ambiguous create
waits a few minutes and reruns, anything else is a defect to file.

### 4c. Labs — rebuild Phase 7 in the clone's own labs program (a COPY)

Owner (Jonathan, 2026-10-16, ace#3020): *"Shouldn't the process be that we
create the report in the new prorgam and the synthetic data in the new program
by using the templatized reports and just copying the synthetic data?"* So Labs
is rebuilt the way HQ (4a) and Connect (4b) are, and the rebuild is a **copy**:
the same educators, partners, class records and findings, the same report
definitions, the same indicator registry — in a NEW program. The source run's
synthetic opps are NEVER opened to a partner: do not call
`synthetic_set_allowed_domains` on them (the tenancy guard refuses a partner
domain anyway, `config/tenancy-targets.json`, and the call REPLACES the list,
ace#2713).

**Never regenerate.** Not `synthetic_generate_from_manifest` on the saved
`7-synthetic/manifest_<xx>.yaml`, not `synthetic_clone_opp` /
`synthetic_clone_profile` / `synthetic_clone_generate` (those MEASURE a real
opp and generate new records), not a re-authored story. A copy that cannot be
made with a copying atom is `NOT DONE` naming the gap — never a regeneration
standing in for it.

Run it after the script's `connect` stage: the program's labs workspace is
linked to the Connect orgs that stage rebuilt. `$CL` is `npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/clone-labs-rebuild.ts"`.

1. **What to copy.** `$CL inspect --run-state <source run_state.yaml>` → the
   partners (label + source opp id), program, registry and what Phase 7 built
   (programme report, opp reports, weekly history, benchmarks). It refuses a
   run with no `cascade.partners`: a run without Phase 7 Labs has nothing to
   copy, and the script's `labs` stage already records `done` with that reason.
2. **The records: one labs-only copy per partner, all in ONE new program.**
   `synthetic_clone_to_labs_only({source_opportunity_id: <partner>, label:
   <partner label>, org_name: "<partners org name> (ace <to>/<opp>/<run-id>)",
   program_name: <source program name>, program_id: <new program>,
   allowed_domains: ['@dimagi.com', '@dimagi-ai.com']})` — the first partner
   WITHOUT `program_id` (its own id becomes the new program id), every later
   one with it (`program_id` is the parameter the gap below is about). It serves the source's own fixture folder (the records
   themselves, as-is) and keeps their generated-data mark. The org name MUST be
   new and carry the TARGET workspace: step 6 refuses an organisation that
   holds any other program. Read back each copy's counts against
   `products.synthetic.source.record_counts` (`synthetic_local_records_count`
   / the programme report's partner rows); a mismatch is `NOT DONE`.
   **Gap, 2026-10-16:** the deployed `synthetic_clone_to_labs_only` takes no
   `program_id` (connect-labs `mcp/tools/synthetic.py`; its
   `register_labs_only_opp` already accepts one), so partners 2..N would each
   become their own program and no programme report could span them; and no
   read atom returns a synthetic opp's fixture folder, so
   `synthetic_create_labs_only(gdrive_folder_id, program_id)` cannot stand in.
   Until that lands (connect-labs#2571), create NOTHING here — one copied
   partner is not the programme and would be an orphan to sweep: check the
   live schema (`ToolSearch` → `synthetic_clone_to_labs_only` lists
   `program_id`, or it does not), and without it record `clone.labs: {status:
   not-done, reason: "labs atom gap: synthetic_clone_to_labs_only has no
   program_id — connect-labs#2571"}`. The release then grants no Labs.
3. **The registry, copied.** `semantic_registry_get(<source registry>)` →
   save its `properties_doc`, `indicators_doc`, `deployment` as JSON; build
   the id map so far (`{<source opp>: <new opp>, …, <source program>: <new
   program>}` as `map.json`) and retarget it (`deployment.llo_map` is keyed by
   opp id):
   ```bash
   $CL remap-json --in registry.json --id-map map.json --out registry.new.json
   ```
   `semantic_registry_validate` → `semantic_registry_create({...registry.new.json,
   name: "<source registry name> (ace <to>/<opp>/<run-id>)", program_id: <new
   program>, is_shared: false})`. Add `<source registry>: <new registry>` to
   `map.json`.
4. **The reports, from their templates, configuration copied.** For each
   source report (`cascade.programme_report`, its companion `worker_review`,
   each `opp_reports[]`): `workflow_get` the source definition and keep its
   template key and `config`. Then instantiate the SAME template in the new
   program with that config: `workflow_create_from_template({template_key:
   'indicator_programme_report', program_id: <new program>, opportunity_ids:
   [new opps], registry_source: {registry_id: <new registry>}, config:
   <source config, minus scope keys that name source ids>})` (it also makes the
   companion worker review); the visits pipeline gets the source pipeline's
   schema (`pipeline_get` → `pipeline_update_schema`); the cohort on the new
   labs org (`labs_context({search: '<to>/<opp>/<run-id>'})` for its slug) and
   `benchmarks_create_opp_reports({cohort_id, template_key:
   'indicator_opp_report', source_workflow_id: <new programme report>,
   source_program_id: <new program>})`. Then the saved history over the
   SOURCE's `history` window (same weeks, same count) with
   `workflow_rebuild_history` and the benchmark publishes (`demo-data-setup`
   § C5) — these COMPUTE the saved runs from the copied records; they generate
   no data. Never `workflow_clone(linked: true)`: a linked twin reads the
   source's pipelines in the source's scope, so a reviewer without source
   access sees nothing.
5. **Verify the findings carried over.** `demo-data-setup` § C6
   (`verifyCascadeStoryLanded` against the source's `7-synthetic/cascade-story.yaml`):
   every signal the source verified lands here, from the same records. A miss
   is `NOT DONE` — a defect in the copy, never re-described.
6. **Let the clone's Connect orgs in — the labs workspace.** A labs workspace
   replaces the email-domain rule with roles: every MEMBER of a Connect org
   listed as one of its LLOs is a Network Manager (connect-labs
   `labs/workspaces.py`; `lib/labs-workspace.ts` has the citations). List the
   clone's own orgs, so a reviewer `release` adds to them as a viewer opens the
   dashboards through that grant:
   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/labs-workspace-setup.ts" --program-id <new program> \
     --llo <tenancy.connect_holding_org> --llo <tenancy.connect_pm_org>
   ```
   It turns workspace roles on, adds each LLO, and reads the settings page back;
   exit 0 only when the page lists both. Needs `/ace:labs-login`'s session
   (there is no MCP atom for workspace roles — connect-labs#2572). With `--keep-shared connect` skip this step: the shared orgs hold
   every ACE opportunity, so listing them would open these dashboards to every
   member of ACE's own orgs — record `clone.labs.workspace: {llos: []}`, and
   the release then does not grant Labs.
7. **Rewrite the target run's products.** Complete `map.json` with every
   source id the block references (workflows, runs, pipeline, cohort,
   benchmark publications), then:
   ```bash
   $CL remap --run-state <source run_state.yaml> --id-map map.json --out synthetic.json
   ```
   Exit 1 names each source id still referenced — map it, never ship a block
   that sends a reviewer to the SOURCE dashboards. Write the result as
   `phases.synthetic-data-and-workflows.products.synthetic` with
   `update_yaml_file(localFilePath, merge: "deep")` (arrays are replaced
   wholesale, so the whole block goes in one file). The DDD narrative and
   walkthrough entries keep pointing at the source's render — say so in Step 6;
   `products.ocs_coach` is not rebuilt (stage `ocs`).
8. **Read back, then record.** `labs_context({search: '<to>/<opp>/<run-id>'})`
   lists every new opp under the new program (ACE sees what it built), the
   workspace script's JSON lists both LLOs, and the programme report URL in the
   rewritten block opens. Only then record `clone.labs: {status: done,
   program_id, org_slug, opportunity_ids: [...], registry_id,
   programme_report: {workflow_id, run_id}, workspace: {llos: [<orgs>]},
   from: {program_id, opportunity_ids}, id_map_ref}`. Anything short of that is
   `NOT DONE` with its step. (The run summary still tags these dashboards
   `admin only` until ace-web#910 reads `clone.labs` — say so to the operator.)

`validate-release-readiness` grants Labs only on `clone.labs.status: done`
with `clone.connect.status: done`, and blocks when
`clone.labs.workspace.llos` lacks one of the Connect orgs it grants
(`plan-labs-workspace-llo-missing`). Release makes NO Labs call: the reviewer's
Connect org membership is the Labs grant.

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

From the script's JSON report (re-read the TARGET run_state's `clone:` block
rather than trusting memory): one line per stage — `done` with the ids / URLs
it read back (HQ apps + builds and the space's edition; Connect program,
opportunity and holding org), `kept` / `kept-shared`, or `NOT DONE` + its
`reason` (Labs reads `not-done: labs atom gap … connect-labs#2571` until that lands — § 4c); the
Drive-link read-back (`source_ids_remaining`, expected 0 outside comms-logs);
§ 4e's rewrite (files changed, and every place left on the source on purpose —
e.g. the Phase 8 solicitation); `products_check` (expected empty); the run's
wall-clock `seconds`; every manual setup item (HQ mobile workers); the OCS
`public_url`; and Step 5's release-readiness verdict and its blockers. End with: "Nothing was shared with anyone. Next:
`/ace:validate-release-readiness <to>/<opp>/<run-id> --reviewers <email[:role]>,…`
— it checks and fixes everything and, when READY, shows you exactly what will
be shared and every email. Then `/ace:release <to>/<opp>/<run-id> --reviewers …`
(the same reviewers) shares exactly that, and nothing else."


## Running the next round in a partner's workspace

A clone is how a run FIRST reaches a partner's workspace. The next round does
not need another clone: build it there directly.

1. **Feedback lands in the partner workspace.** Reviewers answer and comment on
   the clone's ace-web pages; saved answers go to that workspace's
   `<opp>/inputs/decision-overrides.yaml`, under its own Drive root.
2. **`/ace:run <ws>/<opp>`** — e.g. `/ace:run spark/spark-facilitator`. The run
   resolves the workspace's tenancy (`scripts/resolve-run-workspace.ts`),
   refuses an incomplete or shared one before writing anything, proves it can
   reach the HQ space and both Connect orgs, and builds in them. Its prior run
   is the clone, so open asks carry and the reviewers' saved answers bind at
   the decisions write boundary. Its Phase 4 opportunity holds a key minted for
   the partner's HQ space alone.
3. **`/ace:validate-release-readiness`**, then **`/ace:release`** — reviewers
   who are already members of the workspace are told about the new run there.
