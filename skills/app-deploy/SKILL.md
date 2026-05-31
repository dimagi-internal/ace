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
      `get_form` (one call per `(moduleIndex,
      formIndex)`).
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
