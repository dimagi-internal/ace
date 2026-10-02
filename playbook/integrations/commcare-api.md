# CommCare API Integration

> **Upstream repo: [`dimagi/commcare-hq`](https://github.com/dimagi/commcare-hq).** CommCare HQ ships continuously,
> so an ACE call path that has not changed in months can break because *they* shipped.
> When something that used to work starts failing — especially with an opaque error —
> run `skills/upstream-regression-triage` before concluding it needs a live probe.

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

## New project spaces — the ace-enterprise Enterprise subscription

Every HQ project space ACE creates (`commcare_create_domain` — a partner's
space from `clone-to-new-workspace`, the interview master/downstream pair) starts
on **CommCare Free Edition**, where the REST API is closed (every `/api/` call
answers 401 *"Your current subscription does not have access to this
feature"*; ace#2552). Web views still work (app copy, build, release, a
reviewer's browser access), but a Connect opportunity reading the apps, a
space-restricted HQ key, linked spaces and data forwarding do not.

**The path (Gillian Javetski, accounts — 2026-10-02):** Dimagi set up the
`ace-enterprise` project space for this use case. To put a new space on an
Enterprise plan:

1. Create the space as usual (`commcare_create_domain`).
2. Open **`https://www.commcarehq.org/a/<new-space>/settings/project/internal_subscription_management/`**
   (the same page Gillian linked under `ace-enterprise`, on the new space's own
   URL), choose **"Test or Demo Project"**, and press **Update**. HQ moves the
   space to the default Enterprise plan version, `do_not_invoice`, service
   type `internal`, under the billing account *"Dimagi Internal Test Account
   for Project <space>"* (`DimagiOnlyEnterpriseForm`,
   `corehq/apps/domain/forms.py`). No billing follow-up is needed — Gillian:
   "Enterprise is much easier".
3. Read it back: `commcare_get_subscription(domain)` → `edition` no longer
   `Free`, `is_paid_edition: true`. Then `commcare_list_apps(domain)` answers
   200.

**Step 2 is superuser-only, and ace@ is not one.** `InternalSubscriptionManagementView`
is `@require_superuser`; as ace@ the page 302s to `/no_permissions/`
(observed 2026-10-02 on both `ace-enterprise` and `connect-ace-spark`), and
ace@ is not a member of `ace-enterprise` either (its dashboard 404s). So it is
an **operator step, done during `/ace:release`** (Step 0.4) by whoever runs
the release (operator decision, Jon 2026-10-02). `release-check` blocks on it
(`hq-plan-free:<space>`, owner *HQ superuser (operator)*), and the fix it shows
is the exact URL and clicks. ACE then verifies with `commcare_get_subscription`.
Wording lives in `lib/hq-enterprise-flip.ts`, printed by `scripts/release-check.ts
hq-flip-steps --domain <space>`. A clone that rebuilds Connect needs it
earlier: 4a stops before the API-dependent steps and prints the same text. Never route around it: no other plan change
(self-serve upgrade, trial) is the agreed path, and anything billable needs
accounts' involvement.

**Not this path:**
- **APS / a paid subscription** through `ace-enterprise`'s subscription
  management tool. Possible, but accounts then has to make sure it isn't
  billed. Enterprise is enough for everything ACE does.
- **Linking to `ace-enterprise`** (`/a/ace-enterprise/settings/project/domain_links/`)
  is for pushing content from `ace-enterprise` into a downstream space. It does
  not change the downstream's plan, and clones use unlinked copies, so ACE does
  not need it.

The form's own banner says Test or Demo spaces are *"internal Dimagi test
space[s], not in use by a partner"*. Accounts made `ace-enterprise` for ACE's
partner review spaces, so this use is sanctioned. A space that moves to
partner **production** use is a different subscription conversation, outside
ACE.

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

- **Staging project space:** TBD — confirm with Cal's team (likely `ace-staging`)
- **How it works:** MCP server reads `ACE_SANDBOX=true` environment variable and targets the staging project space instead of the production ACE domain
- **Data isolation:** Staging project space is separate from production — app uploads, builds, and publishes only affect staging
- **Limitations:** scout-data analytics may not be available for the staging project space
