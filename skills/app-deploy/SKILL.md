---
name: app-deploy
description: >
  Upload Learn and Deliver app JSONs to the CRISPR-Connect domain on CommCare HQ,
  build, and publish the apps.
---

# App Deploy

Upload the generated Learn and Deliver apps to CommCare HQ and publish them.

## Process

1. **Read app files** from `ACE/<opp-name>/apps/` via Google Drive MCP.

2. **Upload to CCHQ:**
   - Target domain: CRISPR-Connect domain (pre-configured with feature flags and API keys)
   - Upload Learn app JSON
   - Upload Deliver app JSON

3. **Build apps** on CCHQ — trigger the build process for both apps.

4. **Publish apps** — make them available for mobile deployment.

5. **Write deployment summary** to `ACE/<opp-name>/deployment-summary.md`:
   - App IDs on CCHQ
   - Build status
   - Published URLs
   - Domain and project details

6. **Write the gate brief** to `ACE/<opp-name>/gate-briefs/app-deploy.md` using the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`. See `## Gate Brief` below for the exact fields this skill populates.

## Gate Brief

The gate brief at `ACE/<opp-name>/gate-briefs/app-deploy.md` gives the admin
a fast read on whether both apps are actually live before Phase 3 starts
building Connect opps on top of them.

- **Artifact Under Review:** path `ACE/<opp-name>/deployment-summary.md`;
  summary is "Learn + Deliver apps deployed to <domain>"
- **What to Check** (emit these 4 items verbatim):
  - Both `learn_app_id` and `deliver_app_id` are populated and resolve to
    built releases on CCHQ (not just drafts)
  - The Connectify feature flags (Learn Module, Assessment Score,
    Deliver Unit, Entity ID) are present on the forms the admin named in
    the PDD's Learn/Deliver specs
  - The published URLs return a CCZ and not a 404 / redirect
  - The domain matches the one the PDD's LLO targets can access
- **Auto-Surfaced Concerns:** one line per item:
  - `[BLOCKER]` if either app's build status is anything other than
    `success` (e.g., `errored`, `pending`, `missing`)
  - `[WARN]` if the deploy ran via the Current Workaround (human-assisted
    upload) rather than the built API — this is expected today but should
    surface so the admin knows to sanity-check manually
  - `[INFO]` if any non-blocking cosmetic fields are empty (e.g., the
    short description)
- **Recommended Disposition:** `Approve` if both apps built successfully
  and URLs resolve; `Reject` if either app failed to build; `Approve with
  caveats` if deploy ran through the workaround path

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- CommCare: TBD — app upload API or CommCare CLI wrapper

## Current Workaround (CommCare app upload not yet automated)
1. Read the app JSON/CCZ files from GDrive
2. Provide the user with:
   - The CRISPR-Connect domain URL
   - Instructions to upload each app via the HQ UI
   - What settings to verify after upload
3. Ask the user to confirm both apps are uploaded and built
4. Write the deployment summary with the app IDs the user provides

## Mode Behavior
- **Auto:** Deploy (or guide manual deploy), notify admin group, proceed
- **Review:** Present deployment summary, wait for verification before proceeding

## Dry-Run Behavior
When `--dry-run` is active:
- Write the intended API calls (app upload, build, publish) and app package references to `comms-log/dry-run-app-deploy.md`
- Do not upload, build, or publish apps on CCHQ
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/gate-briefs/app-deploy.md` covering build status, Connectify flags, and workaround-path warnings for the Phase 2→3 gate | ACE team (PM scout, internal-admin lens) |
