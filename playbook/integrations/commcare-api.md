# CommCare API Integration

> **Upstream repo: [`dimagi/commcare-hq`](https://github.com/dimagi/commcare-hq).** CommCare HQ ships continuously,
> so an ACE call path that has not changed in months can break because *they* shipped.
> When something that used to work starts failing — especially with an opaque error —
> run `skills/upstream-regression-triage` before concluding it needs a live probe.

## What ACE has today

CommCare HQ is reached through the **`commcare_*` atoms on the `ace-connect` MCP**
(`mcp/connect/backends/commcare.ts`), which share the Connect session's CommCare HQ
cookies (and `ACE_HQ_API_KEY` for the read-only REST API). Signatures live in
[`docs/atom-schemas.md` § ace-connect](../../docs/atom-schemas.md); grep there for any
`commcare_` atom rather than trusting a paraphrase here. Apps themselves are
**authored in Nova** and uploaded with Nova's `upload_app_to_hq` — see
[`nova-integration.md`](nova-integration.md); the atoms below act on what is already in
HQ.

| Family | Atoms |
|---|---|
| Project spaces & plan | `commcare_create_domain`, `commcare_get_subscription`, `commcare_link_domains`, `commcare_create_api_key` (space-restricted key, returned as an `hq-key:<name>` reference) |
| Apps — list / copy / delete | `commcare_list_apps`, `commcare_linked_app_copy`, `commcare_delete_app` (soft delete) |
| Builds & releases | `commcare_make_build`, `commcare_release_build`, `commcare_download_ccz`, `commcare_validate_ccz` |
| Form-level edits in HQ | `commcare_get_form_source`, `commcare_patch_xform`, `commcare_upload_multimedia`, `commcare_set_menu_display`, `commcare_set_app_menu_display` |
| Lookup tables | `commcare_get_lookup_table`, `commcare_get_lookup_table_rows`, `commcare_create_lookup_table`, `commcare_lookup_table_append_rows` |
| Users & locations | `commcare_list_users`, `commcare_get_user`, `commcare_invite_web_user`, `commcare_list_user_fields`, `commcare_set_user_fields`, `commcare_update_user_field`, `commcare_list_location_types`, `commcare_set_location_types`, `commcare_list_locations`, `commcare_assign_user_locations` |
| Cases | `commcare_get_case` |
| Integrations (motech) | `commcare_list_connections`, `commcare_create_connection`, `commcare_create_repeater`, `commcare_list_inbound_apis`, `commcare_create_inbound_api`, `commcare_list_ucr_expressions`, `commcare_create_ucr_expression` |

Case sharing by location (owner = a worker's place) has its own evidence-tiered
reference: [`hq-case-sharing.md`](hq-case-sharing.md).

There is **no ACE atom for aggregate submission analytics on HQ.** For worker activity on
a Connect opportunity use `connect_get_deliver_progress` / `connect_get_learn_progress`
(ace-connect) or connect-labs `explorer_describe` / `explorer_query` (rows returned to an
agent only for synthetic opportunities) — see [`connect-labs.md`](connect-labs.md).
(An earlier version of this doc pointed at a `scout-data` MCP; it was never wired into
`plugin.json`.)

## Builds and releases — the mechanics

A Connect opportunity reads an app's form schema and Connect markers from its **released
build**, not from the draft and not from Nova. So every app change — first build or a
later edit — ends with a release. The procedure, its drift check and its failure modes
live in [`skills/app-release`](../../skills/app-release/SKILL.md); the platform facts are:

- **`commcare_make_build` versions the HQ DRAFT. It does not pull from Nova.** A Nova edit
  made after the last `upload_app_to_hq` is absent from the build, and the build still
  reports success (ace#1643). Re-upload first.
- **A re-upload to an existing HQ app updates it in place** — the HQ app id stays stable
  (`skills/app-deploy`). Settings Nova cannot carry (camera-only photo capture, grid menu
  display) are HQ-side and must be **re-applied after every re-upload**
  (`skills/app-hq-settings`), before the build.
- **Release is a separate toggle on a build** (`commcare_release_build`); a made-but-
  unreleased build is invisible to Connect.
- **The order for an edit is therefore fixed:** Nova edit + `save_work` → `upload_app_to_hq`
  → re-apply HQ settings → `commcare_make_build` → `commcare_release_build` → verify the
  CCZ (`commcare_download_ccz` / `commcare_validate_ccz`, `skills/app-release-qa`).
- HQ hands back 40-hex SHA-1 form uids after a re-upload; both widths are accepted
  (`lib/hq-unique-id.ts`, ace#1644).
- The CommCare HQ build/release endpoints are internal web routes, not a public API; the
  verified URLs and a rediscovery probe are in `skills/app-release § Endpoints`.

What a live Connect opportunity does with a new release is a Connect question — see
[`connect-api.md` § Changing a live opportunity](connect-api.md#changing-a-live-opportunity).

## Changing a live app — what you can and cannot do

| Change | How | Limit |
|---|---|---|
| Edit forms, fields, logic, case config | Nova (`/nova:edit`, private work → `save_work`) then the release order above | Editing an English string demotes its translation (translate LAST — `nova-integration.md`) |
| Patch one form's XML in HQ only | `commcare_patch_xform` | Lost on the next Nova re-upload — prefer the Nova edit |
| Add or replace media | Nova media channel (`app-media-coverage`); `commcare_upload_multimedia` for HQ-only assets | HQ-only media is lost on a Nova re-upload |
| Lookup-table rows | `commcare_lookup_table_append_rows` (append); Nova `replace_lookup_rows` for a Nova-owned table | No HQ row update/delete atom |
| Users / locations for case sharing | `commcare_*` user + location atoms | See `hq-case-sharing.md` |
| Delete an app | `commcare_delete_app` (soft; restorable in HQ admin) | — |

## New project spaces — set them to "Test or Demo Project"

Every new HQ project space — a partner's space for `clone-to-new-workspace`,
or the interview master/downstream pair; ACE creates each with
`commcare_create_domain` — starts
on **CommCare Free Edition**, where the REST API is closed (every `/api/` call
answers 401 *"Your current subscription does not have access to this
feature"*; ace#2552). Web views still work (app copy, build, release, a
reviewer's browser access), but a Connect opportunity reading the apps, a
space-restricted HQ key, linked spaces and data forwarding do not.

**The fix is one setting on the space itself** (Gillian Javetski, accounts —
2026-10-02; operator decision, Jon 2026-10-02):

1. **ACE creates the space** with `commcare_create_domain` (`hr_name` at most
   25 characters; record the returned `domain`, since HQ derives the slug).
   The creator is the space's Admin, so no invitation is needed; read
   `/a/<space>/settings/users/my_role/` back (`is_domain_admin: true`). Never
   ask an operator to create a space or invite ace@ to it (owner, 2026-10-15,
   ace#3014: *"you should create it and make yourself admin, you just tell me
   to fix the subscription after you've created it (that's how this should
   work in general)"*). For a clone, step 2 is then the only HQ item on the
   operator checklist, whose URLs come from a single source:
   `npx tsx scripts/clone-setup-checklist.ts print --workspace <ws> --hq-domain <slug>`
   (`lib/clone-setup-checklist.ts`). Use that script rather than copying a URL
   from here.
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

## Staging

There is no ACE staging project space and no sandbox switch in the `commcare_*` atoms
(the `ACE_SANDBOX` routing an earlier version described was never built). Test work goes
into a separate project space created with `commcare_create_domain`, set to Test or Demo
as described above.

## Related learnings

- `docs/learnings/2026-09-02-household-dual-group-membership.md` — a household case can sit in two groups (two named child indices)
- `docs/learnings/2026-09-04-vsla-group-running-ledger.md` — a group case can carry a running ledger, but the property reads as text
