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
