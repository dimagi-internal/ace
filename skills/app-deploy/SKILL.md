---
name: app-deploy
description: >
  Upload Nova-built Learn + Deliver apps to CommCare HQ as draft
  builds via /nova:upload_to_hq. Captures HQ app IDs and writes a deploy summary.
disable-model-invocation: true
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
   That's the HQ project space ACE expects Nova to be bound to. Nova
   reads the actual HQ project space from whichever HQ API key is
   saved on its settings page (`https://commcare.app/settings`); ACE
   cannot pass a domain at upload time. If `ACE_HQ_DOMAIN` is unset or
   empty, default to `connect-ace-prod` (the canonical CRISPR-Connect
   project space) with an `[INFO]` note in the gate brief — do not
   pause to ask. Only halt if the env loader returned an explicit
   non-empty value that looks malformed.

   When invoking `/nova:upload_to_hq`, Nova prints "Confirms target
   domain with the user before uploading." Watch for that confirmation
   line — if Nova reports a domain other than `ACE_HQ_DOMAIN`, abort the
   upload (Nova's settings have the wrong API key bound) and surface the
   mismatch to the operator with a pointer to update Nova settings.

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

3. **Upload Learn app.** Run:

   ```
   /nova:upload_to_hq <learn_app_id>
   ```

   Capture from the response:
   - HQ application ID
   - HQ application URL (typically
     `https://www.commcarehq.org/a/<domain>/apps/view/<app_id>/`)
   - Build status (`success` / `errored` / `pending`)
   - Any warnings

4. **Upload Deliver app.** Same shape — `/nova:upload_to_hq <deliver_app_id>`.

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
   two-level `update_yaml_file` merge replaces the whole block cleanly.

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
   `merge: 'two-level'` on the current run's `run_state.yaml`. The
   two-level merge replaces `products:` wholesale under
   `phases.commcare-setup` — that's the intended shape because this
   skill owns the entire block.

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
- Write the intended Nova invocations and the `nova_app_id` values
  resolved from the summaries to `comms-log/dry-run-app-deploy.md`.
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/runs/<run-id>/3-commcare/app-deploy_gate-brief.md` covering build status, Connectify flags, and workaround-path warnings for the Phase 3→4 gate | ACE team (PM scout, internal-admin lens) |
| 2026-04-27 | Switch from manual HQ-UI upload to `/nova:upload_to_hq` via the Nova plugin. Inputs are now `nova_app_id` values read from the app summaries. New pre-flight check compares Nova's bound HQ project space against `ACE_HQ_DOMAIN`. Gate brief drops the workaround-path WARN and adds a domain-mismatch BLOCKER. | ACE team |
| 2026-04-29 | Carve out app release into the new `app-release` skill (Step 2.5 of Phase 3). This skill now ends at "draft uploaded" — release is a separate, permission-sensitive step. Reason: Connect's `Sync Deliver Units` only enumerates units from released builds, so unreleased apps silently break Phase 4's payment-unit config. (0.10.1) | ACE team |
