# CommCare API Integration

## What Exists Today

The **connect-labs MCP** includes a set of CommCare HQ tools alongside the Connect
tools. These are production-ready today.

### App Structure Tools
- `list_apps` — list all CommCare apps for a project space
- `get_app_structure` — fetch the module/form hierarchy for an app
- `get_form_questions` — get all questions in a specific form
- `get_form_json_paths` — get the JSON path mappings for form fields (useful for
  mapping data to Connect delivery/verification rules)

### Bundled Resources
The CommCare MCP also exposes 3 resource bundles:
- **App metadata resource** — app name, version, description, build status
- **Domain metadata resource** — project space settings, user groups
- **User resource** — CommCare user lookup by username or ID

### Analytics (scout-data MCP)
The `scout-data` MCP provides analytics query access to CommCare data. Skills that need
to analyze FLW submission data or aggregate metrics should use `scout-data` rather than
the CommCare HQ API directly. This covers the `flw-data-review` skill's data needs.

---

## What Needs to Be Built

The following CommCare capabilities are not yet exposed via MCP and must be added.

### App Upload and Build
- **App upload** — programmatically upload a `.ccz` file or app JSON to CommCare HQ
- **App build** — trigger a build for an uploaded app (equivalent to clicking "Build"
  in the HQ UI)
- **App publish** — publish a built app to make it available to mobile users
- **App version check** — confirm build succeeded and get the version number

These are needed by the `app-deploy` skill. Without these, the skill falls back to
manual upload instructions.

### Form Data Access (Beyond Analytics)
- **Form submission lookup** — fetch individual form submissions by case ID or
  submission ID (for the `app-test` skill to verify test submissions)
- **Case data access** — read case property values after form submission

Note: Aggregate analytics queries are covered by the existing `scout-data` MCP.
Individual submission/case lookup may require direct CommCare REST API calls or a
new MCP tool.

---

## Manual Workaround

Skills requiring unbuilt CommCare APIs will fall back to manual upload via the HQ UI:

1. The `app-deploy` skill will generate a checklist of what needs to be done
2. It will provide the app package (from Nova) ready to upload
3. The user uploads via CommCare HQ → App Builder → Import App
4. The user triggers Build and Publish in HQ
5. The user confirms the app is live before ACE proceeds to app testing

For the `app-test` skill, manual verification steps will be included as a checklist
until automated test submission and result validation are available.

## Staging Environment

When `--sandbox` is active, ACE routes CommCare API calls to the staging project space.

- **Staging project space:** TBD — confirm with Cal's team (likely `crispr-connect-staging`)
- **How it works:** MCP server reads `ACE_SANDBOX=true` environment variable and targets the staging project space instead of the production CRISPR-Connect domain
- **Data isolation:** Staging project space is separate from production — app uploads, builds, and publishes only affect staging
- **Limitations:** scout-data analytics may not be available for the staging project space
