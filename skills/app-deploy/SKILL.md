---
name: app-deploy
description: >
  Upload Nova-built Learn + Deliver apps to CommCare HQ as draft
  builds via /nova:upload_to_hq. Captures HQ app IDs and writes a deploy summary.
disable-model-invocation: false
---

# App Deploy

Upload the Nova-generated apps to CommCare HQ and capture the resulting
HQ app IDs and URLs. The actual upload is performed by Nova
(`/nova:upload_to_hq`); this skill orchestrates the inputs, the
pre-flight, and the artifact writeback.

**Scope:** this skill uploads apps as **draft builds**. Nova does not
release apps by design. Connect's deliver-unit sync only reads released
builds, so `app-release` must run after this skill before any Connect
payment-unit configuration. See `skills/app-release/SKILL.md` for the
release flow + the App Editor permission prerequisite.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 3 | `3-commcare/pdd-to-learn-app_summary.md` | `nova_app_id` for Learn app |
| Phase 3 | `3-commcare/pdd-to-deliver-app_summary.md` | `nova_app_id` for Deliver app |

## Products

- `3-commcare/app-deploy_summary.md` — HQ app IDs + URLs for both apps
- `run_state.yaml.phases.commcare-setup.products.apps` — consolidated Learn + Deliver app handoff (name, nova_app_id, nova_url, hq_app_id, hq_url, build_status) written as a single atomic block at the end of Phase 3. This skill is the **sole writer** of `products.apps`; readers (ace-web summary, downstream phases) see the block populated once both apps are deployed.
<!-- 0.13.116: legacy `3-commcare/app-deploy_gate-brief.md` removed.
Pause-time summary at the Phase 3→4 Pause Point is composed by the
orchestrator from per-skill QA + eval verdicts. -->


## Process

1. **Read app summaries** from GDrive (paths in `## Inputs` above).
   Extract `nova_app_id` from each frontmatter. These are the inputs to
   `/nova:upload_to_hq`.

2. **Pre-flight check.** Read `ACE_HQ_DOMAIN` (and `ACE_HQ_BASE_URL`,
   default `https://www.commcarehq.org`) from the loaded environment.
   That's the HQ project space ACE uploads each app to. If
   `ACE_HQ_DOMAIN` is unset or empty, default to `connect-ace-prod` (the
   canonical ACE project space) with an `[INFO]` note in the
   gate brief — do not pause to ask. Only halt if the env loader
   returned an explicit non-empty value that looks malformed.

   Nova's `/nova:upload_to_hq` takes the target project space as an
   explicit trailing argument (Nova plugin ≥ the
   voidcraft-labs/nova-plugin#12 release). ACE always passes
   `ACE_HQ_DOMAIN` — naming the space IS the upload confirmation, so
   Nova goes straight to the upload with no interactive prompt and no
   need to pre-verify Nova's bound domain. There is no longer a
   "watch the confirmation line / abort on mismatch" step; correctness
   is enforced at upload time by the `domain_not_authorized` handling in
   Steps 3–4 below.

2.5. **XML-escape lint.** Before uploading, walk every form on the Learn
   and Deliver Nova apps and verify no field has unescaped XML
   metacharacters in `label`, `hint`, or `option` text. Specifically,
   look for raw `<`, `>`, or `&` (not part of a valid `&amp;`/`&lt;`/
   `&gt;`/`&apos;`/`&quot;` entity, and not part of a markdown-fenced
   code block). XForm XML is the upload target; an unescaped `<` will
   pass Nova's own `validate_app` ({"success":true}) but get rejected
   by CCHQ's build with `Error on line N column M: not well-formed`.

   Procedure:

   1. Load every form in both apps with
      `get_form({app_id, moduleUuid, formUuid})` — one call per
      `(moduleUuid, formUuid)`. Nova is **uuid-addressed** since
      2026-07-31 and no tool accepts an index param (see
      `playbook/integrations/nova-integration.md § The 2026-07-31
      uuid-addressing migration`); resolve the whole map with ONE
      `get_app({app_id})` per app — its blueprint prints `[uuid …]` on
      every module, form, and field — or read the uuids off the build
      summary's `nova_uuids:` frontmatter if `pdd-to-*-app` wrote one.
   2. For each field, scan `label`, `hint`, and option `label`s with the
      regex:
      ```
      /(?:&(?!(amp|lt|gt|apos|quot|#\d+|#x[0-9a-f]+);))|<(?![/!?a-zA-Z])|(?<!\\)>(?!\s)/i
      ```
      (A simpler heuristic that catches the common cases: any literal
      `<`, `>`, `&` that isn't part of a recognized XML entity.)
   3. For each hit, fix via `edit_field` —
      replace `<` with `&lt;`, `>` with `&gt;`, `&` (not in an entity)
      with `&amp;`. Document each change in
      `ACE/<opp-name>/app-summaries/{learn,deliver}-app-summary.md` under
      a `## XML-escape lint fixes` section.
   4. Note: this is a **class-level preventer**, not a one-time
      workaround. The turmeric e2e hit it on q10 with `(<2kg)` /
      `(>10kg)` in the field label. Filed as
      `docs/issues/nova-validate-app-misses-xml-escapes.md`. Until Nova
      auto-escapes on `add_field`/`edit_field` (or `validate_app`
      rejects), every Phase 3 run does this lint.

   If the lint is skipped (e.g. Nova MCP unauthed at this point), log
   `app-deploy-xml-lint: skipped-nova-unauthed` in `run_state.yaml` and add
   a `[WARN]` to the gate brief.

3. **Upload Learn app.** Run (always pass the target project space as
   the trailing argument):

   ```
   /nova:upload_to_hq <learn_app_id> <ACE_HQ_DOMAIN>
   ```

   Capture from the response:
   - HQ application ID
   - HQ application URL (typically
     `https://www.commcarehq.org/a/<domain>/apps/view/<app_id>/`)
   - Build status (`success` / `errored` / `pending`)
   - Any warnings

   **Handle `domain_not_authorized`.** If Nova returns
   `error_type: domain_not_authorized`, the HQ API key saved in Nova's
   settings can't reach `<ACE_HQ_DOMAIN>`. Nova's `message` lists every
   space the key CAN reach — surface that as a `[BLOCKER]` (do not
   silently upload to a different space) with the reachable-spaces list
   and a pointer to either fix `ACE_HQ_DOMAIN` or re-mint/re-paste an HQ
   key that reaches it. Other error types (`hq_not_configured`,
   `hq_upload_failed`) are also `[BLOCKER]`s — surface Nova's `message`.

4. **Upload Deliver app.** Same shape — `/nova:upload_to_hq <deliver_app_id> <ACE_HQ_DOMAIN>` — including the `domain_not_authorized` handling.

4.5. **Verify HQ feature flags for the target space** (ace#1048). Some
   CommCare capabilities only work when a **domain feature flag** is on, and
   an app that works in a space where a flag happens to be enabled silently
   does not in one where it isn't. Ask Nova, per app, against the space we
   just uploaded to:

   ```
   get_app_hq_feature_flags({ app_id: <nova_app_id>, domain: <ACE_HQ_DOMAIN> })
   ```

   Use the **Nova** `app_id` (not the HQ app id). Run it for **both** apps.
   The tool is read-only and never enables anything.

   Branch on `feature_flag_requirements.verification`:

   | result | disposition |
   |---|---|
   | `verified`, `missing_flags` empty | `[PASS]` — record and move on |
   | `verified`, `missing_flags` non-empty | **`[BLOCKER]`** — the app needs a flag the target space does not have |
   | `not_checked` / any `unverified_flags` | **`[WARN]`** — record as explicitly UNVERIFIED |

   On `missing_flags`: surface each flag's `label`, `slug`, and the
   `reasons[]` naming the app configuration that caused the requirement. Then
   **branch on WHERE the requirement came from** — the two cases have opposite
   remedies, and emitting the wrong one costs a redeploy (ace#1195):

   - **The capability traces to something the PDD asked for** → operator
     action. Tell the operator to contact `support@dimagi.com` naming the
     project space (Nova returns `support_email` + `docs_url` for exactly
     this). **Do NOT strip, downgrade, or rebuild the app to dodge the flag** —
     Nova's contract states this result "must never cause an agent to remove,
     undo, or avoid requested app functionality." The app stays as built; a
     human enables the flag.
   - **The capability does NOT trace to the PDD** — it came from default
     module authoring rather than a stated requirement → **`[BLOCKER]` BUILD
     DEFECT.** Do not send the operator to support. Name the capability to
     remove and halt for remediation. Per
     `_app-component-library.md § connect-supported-capabilities-only`, the
     only flag an ACE app may depend on is `commcare_connect`; anything else is
     outside the capability budget. **Many HQ flags are frozen or deprecated,
     meaning HQ's own source instructs staff not to enable them for new
     projects** — so "email support" is not merely slower, it asks a human to
     override a stated policy for a capability the app never needed.

   The canonical instance: case-search inputs on a Deliver menu require
   `search_claim` (+ `case_search_advanced` for fuzzy matching), both frozen.
   A case LIST needs no flag and is what the worker actually uses. If no PDD
   line asked for case search, the fix is `remove_search_input`, not a support
   ticket.

   On unverified: say so plainly rather than substituting a guess. An
   unverified result is not a pass — it is an open question that Phase 9 must
   close before partner handoff.

   If the tool is unavailable (older Nova plugin — see Step 0a's
   `nova_plugin_current`), log `app-deploy-flag-check: skipped-tool-unavailable`
   and add a `[WARN]`. Do not halt.

4.6. **Clean up superseded HQ apps (`deployment.left_behind`).** CommCare HQ
   has no atomic app-update API, so **every** `upload_app_to_hq` creates a fresh
   HQ application document. When an app is uploaded more than once in a run —
   an XForm escape fix, a Connect-marker patch, a Step 4g screen split, any
   build-rejection iteration — Nova returns the previous HQ app id(s) in
   `deployment.left_behind`, and they keep sitting on the project space.

   Nova's own `upload_to_hq` guidance stops at *naming* them, which is the right
   boundary for Nova (it will not delete a user's app). It is the wrong boundary
   for ACE: the superseded draft is ours, it was created seconds ago, nothing
   references it, and leaving it behind means every re-upload silently adds an
   orphan for `/ace:sweep hq` to reconcile later. Observed live on
   hh-poverty-targeting/20260812-2034, where a Step 4g split re-uploaded the
   Deliver app and left `07f9b7c8…` stranded.

   So: for each id in `deployment.left_behind`, call

   ```
   commcare_delete_app({ domain: <ACE_HQ_DOMAIN>, app_id: <left-behind id> })
   ```

   This is HQ's own **soft** delete (it flips `doc_type` to `<original>-Deleted`
   and writes a `DeleteApplicationRecord`), so the app stays restorable from
   HQ's deleted-applications list — the operation is reversible, which is why it
   is safe to do automatically. Record every deleted id in the Step 5 summary
   under `<app>_superseded_hq_app_id`.

   **Guard rails.** Only delete ids that came back in THIS call's
   `left_behind` — never an id read from an artifact, and never the id you just
   uploaded to. If a delete fails, log `[WARN] orphan-cleanup-failed: <id>`,
   name it in the summary so `/ace:sweep hq` can finish the job, and **continue**
   — a failed cleanup must never halt a successful deploy.

   **The re-upload itself still needs surfacing, loudly.** The new HQ app id is
   what Phase 4 wires into the Connect opportunity at create time
   (`connect_create_opportunity`), and Connect's edit form does not expose those
   fields — so an opportunity created against a stale id needs
   delete-and-recreate to repoint. Whenever `left_behind` is non-empty, the
   Step 5 summary MUST carry an explicit "this app was re-uploaded — use the id
   above" callout, not just the changed frontmatter value.

5. **Write the deployment summary** to
   `ACE/<opp-name>/runs/<run-id>/3-commcare/app-deploy_summary.md`:

   ```yaml
   ---
   hq_base_url: <ACE_HQ_BASE_URL>
   hq_domain: <ACE_HQ_DOMAIN>
   learn_app_id: <hq-app-id>
   learn_app_url: <hq-app-url>
   learn_build_status: <success|errored|pending>
   learn_nova_app_id: <nova-app-id>
   deliver_app_id: <hq-app-id>
   deliver_app_url: <hq-app-url>
   deliver_build_status: <success|errored|pending>
   deliver_nova_app_id: <nova-app-id>
   uploaded_at: <ISO-8601>
   # Present only when this app was uploaded more than once in the run.
   # One entry per id returned in `deployment.left_behind` and soft-deleted
   # in Step 4.6 — see the re-upload callout that step requires.
   learn_superseded_hq_app_id: [<hq-app-id>, …]
   deliver_superseded_hq_app_id: [<hq-app-id>, …]
   hq_feature_flags:
     domain: <ACE_HQ_DOMAIN>
     verification: <verified|not_checked>
     learn_missing: [<slug>, …]        # [] when clean
     learn_unverified: [<slug>, …]
     deliver_missing: [<slug>, …]
     deliver_unverified: [<slug>, …]
     checked_at: <ISO-8601>
   ---
   ```

   Body: human-readable narrative including any Nova warnings and a
   link to each HQ app.

6. **Write the `products.apps` block to `run_state.yaml`** as one atomic
   patch. This skill is the sole writer of `products.apps`, so the
   `deep` `update_yaml_file` merge replaces the `apps` block cleanly
   while preserving sibling phase keys (`status`, `started_at`, `steps`).

   For each app, read the friendly name from the source summary's
   frontmatter (`title`), the `nova_app_id` from the same summary, and
   the HQ details from this skill's upload response. Construct the Nova
   preview URL from the `nova_app_id` directly — Nova's working route
   is `/build/<id>`, not the legacy `/apps/<id>` URL that the upstream
   summaries' frontmatter still carries (which 404s).

   ```yaml
   phases:
     commcare-setup:
       products:
         apps:
           learn:
             name: <from learn summary frontmatter `title`>
             nova_app_id: <from learn summary frontmatter `nova_app_id`>
             nova_url: https://commcare.app/build/<nova_app_id>
             hq_app_id: <from Step 3 upload response>
             hq_url: <from Step 3 upload response>
             build_status: <success | errored | pending>
           deliver:
             name: <from deliver summary frontmatter `title`>
             nova_app_id: <from deliver summary frontmatter `nova_app_id`>
             nova_url: https://commcare.app/build/<nova_app_id>
             hq_app_id: <from Step 4 upload response>
             hq_url: <from Step 4 upload response>
             build_status: <success | errored | pending>
   ```

   Apply via `mcp__plugin_ace_ace-gdrive__update_yaml_file` with
   `merge: 'deep'` on the current run's `run_state.yaml`. This patch is
   rooted at `phases.commcare-setup.products` — a *partial* patch of the
   `commcare-setup` phase child. `two-level` would replace the entire
   `commcare-setup` child wholesale, silently dropping any sibling keys
   already set on it (`status`, `started_at`, `halt_reason`, `steps` —
   e.g. when the orchestrator set `status: in_progress` on resume before
   this write). `deep` recursively merges `apps` under `products` while
   preserving every sibling at every depth. This skill is still the sole
   writer of `products.apps`, but it does NOT own the rest of the phase
   block, so it must not clobber it. See the CLAUDE.md gotcha
   (`update_yaml_file two-level merge replaces a phase child WHOLESALE`)
   and jjackson/ace#572 / #587.

<!-- 0.13.116: gate-brief write step + ## Gate Brief section removed.
At the Phase 3→4 Pause Point, the orchestrator composes the
pause-time summary from this skill's eval verdict
(`app-release-eval`) + downstream `app-connect-coverage` verdict +
the deploy/release status fields in `app-deploy_summary.md`. The
producer no longer authors a separate gate-brief artifact. -->

## MCP Tools Used

- **Google Drive MCP:** `drive_read_file`, `drive_create_file`
- **Nova plugin slash commands:** `/nova:upload_to_hq`, `/nova:show`
- **Nova MCP:** `get_app_hq_feature_flags` (Step 4.5 — read-only; never enables a flag)
- **ace-connect MCP:** `commcare_delete_app` (Step 4.6 — soft-deletes a
  superseded HQ app returned in `deployment.left_behind`; reversible from HQ's
  deleted-applications list)

## Mode Behavior
- **Auto:** Pre-flight, upload, write summary, notify admin, proceed.
- **Review:** Same, but pause at the Phase 3→4 Pause Point (per
  `agents/ace-orchestrator.md § Pause Points`); orchestrator presents
  the per-skill verdicts.

## Dry-Run Behavior
When `--dry-run` is active:
- Run the pre-flight (it's read-only) and report the result.
- Do NOT call `/nova:upload_to_hq` (this writes to a live HQ project
  space).
- Write the intended Nova invocations (including the resolved
  `<ACE_HQ_DOMAIN>` trailing argument) and the `nova_app_id` values
  resolved from the summaries to `comms-log/dry-run-app-deploy.md`.
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/runs/<run-id>/3-commcare/app-deploy_gate-brief.md` covering build status, Connectify flags, and workaround-path warnings for the Phase 3→4 gate | ACE team (PM scout, internal-admin lens) |
| 2026-04-27 | Switch from manual HQ-UI upload to `/nova:upload_to_hq` via the Nova plugin. Inputs are now `nova_app_id` values read from the app summaries. New pre-flight check compares Nova's bound HQ project space against `ACE_HQ_DOMAIN`. Gate brief drops the workaround-path WARN and adds a domain-mismatch BLOCKER. | ACE team |
| 2026-04-29 | Carve out app release into the new `app-release` skill (Step 2.5 of Phase 3). This skill now ends at "draft uploaded" — release is a separate, permission-sensitive step. Reason: Connect's `Sync Deliver Units` only enumerates units from released builds, so unreleased apps silently break Phase 4's payment-unit config. (0.10.1) | ACE team |
| 2026-05-29 | Pass the target project space explicitly: `/nova:upload_to_hq <app_id> <ACE_HQ_DOMAIN>` (Nova plugin voidcraft-labs/nova-plugin#12). Naming the space skips Nova's interactive confirmation, so hands-off runs go straight to upload. Pre-flight no longer watches the confirmation line; the domain-mismatch BLOCKER is now driven by Nova's `domain_not_authorized` error at upload time (which enumerates the reachable spaces). | ACE team |
| 2026-08-01 | **Migrated the Step 2.5 XML-escape lint's form load to uuid addressing (ace#1132).** It read "one call per `(moduleIndex, formIndex)`"; Nova's 2026-07-31 redeploy accepts no index param on any of its 63 tools, so the lint named an uncallable operation and would have skipped silently. Now `get_form({app_id, moduleUuid, formUuid})`, with the uuid map resolved from ONE `get_app({app_id})` per app (or off the build summary's `nova_uuids:` frontmatter). Enforced by `test/skills/nova-uuid-addressing.test.ts`. | ACE team |
| 2026-08-13 | **Step 4.6 — clean up `deployment.left_behind` instead of only naming it.** HQ has no atomic app-update API, so every `upload_app_to_hq` mints a fresh application document; Nova returns the superseded id(s) in `deployment.left_behind`. Nova's own guidance stops at naming them, which is the right boundary for Nova (it will not delete a user's app) and the wrong one for ACE — the superseded draft is ours, seconds old, unreferenced, and leaving it behind means every re-upload silently adds an orphan for `/ace:sweep hq`. Observed on hh-poverty-targeting/20260812-2034, where a screen-split re-upload stranded `07f9b7c8…`. Now soft-deleted via `commcare_delete_app` (HQ's own reversible delete — restorable from the deleted-applications list, which is why it is safe automatically), with guard rails: only ids from THIS call's `left_behind`, never one read from an artifact, never the id just uploaded to; a failed delete is a `[WARN]` named in the summary for sweep to finish, never a halt. Adds `{learn,deliver}_superseded_hq_app_id` to the summary frontmatter and REQUIRES an explicit re-upload callout in the summary body whenever `left_behind` is non-empty — the new HQ id is what Phase 4 wires into the Connect opportunity at create time, and Connect's edit form does not expose those fields, so a stale id costs a delete-and-recreate. | ACE team |
