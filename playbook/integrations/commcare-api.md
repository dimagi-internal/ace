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

## New project spaces — set them to "Test or Demo Project"

Every new HQ project space — a partner's space for `clone-to-new-workspace`
(created by the operator, below), or one ACE creates with
`commcare_create_domain` (the interview master/downstream pair) — starts
on **CommCare Free Edition**, where the REST API is closed (every `/api/` call
answers 401 *"Your current subscription does not have access to this
feature"*; ace#2552). Web views still work (app copy, build, release, a
reviewer's browser access), but a Connect opportunity reading the apps, a
space-restricted HQ key, linked spaces and data forwarding do not.

**The fix is one setting on the space itself** (Gillian Javetski, accounts —
2026-10-02; operator decision, Jon 2026-10-02):

1. Create the space. **For a clone, the operator does this** (operator
   decision, Jon 2026-10-02), together with steps 2 and the ace@ invite, from
   one checklist whose URLs come from a single source:
   `npx tsx scripts/clone-setup-checklist.ts print --workspace <ws> [--hq-domain <slug>]`
   (`lib/clone-setup-checklist.ts`: create at
   `https://www.commcarehq.org/register/domain/`, demo mode, invite
   `ace@dimagi-ai.com` as Admin at `/a/<space>/settings/users/web/invite/`).
   ace@ then joins by itself — `clone-setup-checklist.ts accept-invites` finds
   the HQ invitation in ace@'s mailbox, accepts it with ACE's HQ session
   (`/a/<space>/settings/users/join/<uuid>/`), and reads
   `/a/<space>/settings/users/my_role/` back (`is_domain_admin: true`). Use
   that script rather than copying a URL from here. Elsewhere, ACE creates the
   space with `commcare_create_domain`.
2. A Dimagi HQ superuser opens
   **`https://www.commcarehq.org/a/<space>/settings/project/internal_subscription_management/`**,
   chooses **Subscription Type → Test or Demo Project**, and presses **Update**.
   HQ moves the space to the default Enterprise plan, `do_not_invoice`,
   service type `internal`, under a billing account of its own, *"Dimagi
   Internal Test Account for Project <space>"* (`DimagiOnlyEnterpriseForm`,
   `corehq/apps/domain/forms.py`). Nothing is billed and nothing else is needed.
3. Read it back: `commcare_get_subscription(domain)` → `edition` no longer
   `Free`, `is_paid_edition: true`. Then `commcare_list_apps(domain)` answers
   200.

**The `ace-enterprise` project space is NOT part of this.** The switch does not
attach the space to `ace-enterprise` or its billing account. Grouping a space
under `ace-enterprise`, so it appears in that account's Enterprise Console
(`/a/ace-enterprise/enterprise/dashboard/`, which has no add-space button),
would mean an accounts admin moving the subscription to that billing account in
`/hq/accounting/` ("Transfer Subscription To"). It brings no capability ACE
needs, so ACE does not do or ask for it. Likewise linking spaces from
`ace-enterprise` (`/a/ace-enterprise/settings/project/domain_links/`) only
pushes content and does not change a plan. A paid plan (APS) would need
accounts to stop it being billed. Don't use any of these as substitutes.

**Step 2 is superuser-only, and ace@ is not one.** `InternalSubscriptionManagementView`
is `@require_superuser`; as ace@ the page 302s to `/no_permissions/`
(observed 2026-10-02 on `connect-ace-spark`). So it is an **operator step**:
for a clone, done at setup (checklist item 1b) and verified before anything is
rebuilt; `/ace:validate-release-readiness` (step 5) re-checks it, walks the
operator through it when run interactively, and is the fallback. It
blocks on it (`hq-plan-free:<space>`, owner *HQ superuser (operator)*) with the
exact URL and clicks as its fix, and ACE verifies with
`commcare_get_subscription`. Wording lives in `lib/hq-enterprise-flip.ts`,
printed by `scripts/release-readiness.ts hq-flip-steps --domain <space>` and used by
the clone checklist.

The form's banner calls Test or Demo spaces *"internal Dimagi test space[s],
not in use by a partner"*. Accounts sanctioned this for ACE's partner
**review** spaces. A space moving to partner production use is a separate
subscription conversation, outside ACE.

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
