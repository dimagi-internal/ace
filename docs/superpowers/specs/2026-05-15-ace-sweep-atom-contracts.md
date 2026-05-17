# Sweep atom contracts — research findings

**Status:** research complete; ready to implement
**Date:** 2026-05-15
**Parent spec:** `2026-05-15-ace-sweep-design.md`
**Phasing:** referenced as "follow-up atoms" in `2026-05-15-ace-sweep-pr1-foundation-and-drive.md`

PR 1 (`/ace:sweep` foundation + Drive) and PR 2 (per-system sweep skills in report-only mode) shipped. Each "report-only" item in the coverage matrix can be promoted to "auto-execute" by shipping a focused atom-building PR. This doc captures the exact upstream contract for each atom so an implementer can build it without re-research.

## Decision matrix (per atom)

| Atom | Transport | Backend file | Auth | Method | Endpoint |
|---|---|---|---|---|---|
| `connect_delete_unaccepted_flw_invites` | HTML form POST | `mcp/connect/backends/playwright.ts` | session cookie | POST | `/a/<org_slug>/opportunity/<opp_id>/delete_invites/` |
| `ocs_archive_chatbot` | HTML form POST | `mcp/ocs/backends/playwright.ts` | session cookie + CSRF | POST | `/a/<team_slug>/chatbots/<pk>/delete/` |
| `ocs_archive_collection` | HTTP DELETE method | `mcp/ocs/backends/playwright.ts` | session cookie + CSRF | DELETE | `/a/<team_slug>/documents/collection/<pk>/delete/` |
| `ocs_archive_pipeline` | HTTP DELETE method | `mcp/ocs/backends/playwright.ts` | session cookie + CSRF | DELETE | `/a/<team_slug>/pipelines/<pk>/delete/` |
| `ocs_delete_collection_file` | HTML form POST | `mcp/ocs/backends/playwright.ts` | session cookie + CSRF | POST | `/a/<team_slug>/documents/collections/<pk>/files/<file_id>/delete` |
| `commcare_list_apps` | JSON REST | `mcp/connect/backends/commcare.ts` | session cookie (TaskPie `allow_session_auth=True`) | GET | `/a/<domain>/api/v0.4/application/` |
| `commcare_delete_app` | HTML form POST | `mcp/connect/backends/commcare.ts` | session cookie + CSRF | POST | `/a/<domain>/apps/delete_app/<app_id>/` |
| `labs_delete_record` | REST in local-tool proxy | `mcp/connect-labs-server.ts` | OAuth2 Bearer (LABS_MCP_TOKEN) | POST | `/export/labs_record/` body: `[{id}]` |

The `labs_delete_record` atom is the only one that doesn't fit cleanly in an existing MCP server file — the labs MCP is a stdio JSON-RPC proxy. It needs **local-tool routing**: intercept `tools/list` to append our local tool, intercept `tools/call` for `labs_delete_record` and make the REST call directly, forward everything else.

## Contract details (per atom)

### `connect_delete_unaccepted_flw_invites`

- **URL pattern (urls.py):** `path("<slug:opp_id>/delete_invites/", views.delete_user_invites, name="delete_user_invites")`
- **Full URL:** `/a/<org_slug>/opportunity/<opp_id>/delete_invites/` (`<opp_id>` is the opportunity UUID slug)
- **Method:** POST
- **CSRF:** view is `@csrf_exempt` — token not required, but safe to send for compatibility
- **Form body:** `user_invite_ids=<int>&user_invite_ids=<int>...` (Django `getlist("user_invite_ids")`; integer auto-PKs from the `UserInvite` model)
- **Permissions:** `@org_member_required` + `@opportunity_required`
- **Behavior:** filters to `id__in=invite_ids` AND `opportunity=request.opportunity` AND excludes `status=accepted`. Hard-deletes matched rows plus their `OpportunityAccess` records.
- **Response on success:** HTTP 200 with `HX-Redirect` header pointing to worker_list
- **Response on empty list:** HTTP 400 (`HttpResponseBadRequest`)
- **List source:** `connect_list_invites` already exposes these — each invite's `id` is the integer this atom expects.

**Implementation outline:**
```typescript
// playwright.ts — direct POST, no CSRF scrape needed
deleteUnacceptedFlwInvites: ConnectClient['deleteUnacceptedFlwInvites'] = async ({
  organization_slug, opportunity_id, user_invite_ids,
}) => {
  if (user_invite_ids.length === 0) {
    return { deleted: 0 };  // no-op; don't even call the endpoint
  }
  const urlPath = `/a/${organization_slug}/opportunity/${opportunity_id}/delete_invites/`;
  const form: Record<string, string | number> = {};
  user_invite_ids.forEach((id, i) => { form[`user_invite_ids_${i}`] = id; });
  // ⚠️ Django expects repeated key, not indexed — use page.request.post's `multipart` or build query body manually
  const res = await this.request.post(urlPath, { form, headers: { Referer: `${this.opts.baseUrl}${urlPath}` } });
  if (res.status() !== 200) throw await httpErrorFor(res, urlPath, 'POST');
  return { deleted: user_invite_ids.length };
};
```

⚠️ Open question: Playwright's `request.post({form: ...})` may not support repeated keys; verify with a test or use `data: 'user_invite_ids=1&user_invite_ids=2'` (URL-encoded string body).

### `ocs_archive_chatbot` / `_collection` / `_pipeline` / `_collection_file`

All four follow the same pattern but vary in HTTP method:

| Atom | Method | Trailing slash | Success status |
|---|---|---|---|
| `ocs_archive_chatbot` | POST | yes | 302 (HTMX `HX-Redirect`) |
| `ocs_archive_collection` | DELETE | yes | 200 (empty body) |
| `ocs_archive_pipeline` | DELETE | yes | 200 (empty body) |
| `ocs_delete_collection_file` | POST | no (!) | 200 (empty body) |

- **CSRF:** all four require token; scrape from a GET to the resource's detail page (e.g. `/a/<slug>/chatbots/<pk>/`).
- **Permissions:** `LoginAndTeamRequiredMixin` + `PermissionRequiredMixin(permission_required=...)`.
- **Soft-delete:** chatbot/collection/pipeline set `is_archived=True` via `.archive()`. Collection file is HARD-deleted via async task.

**View source references:**
- chatbot: `apps/experiments/views/experiment.py:archive_chatbot` — `@require_POST` + `@login_and_team_required` + `@permission_required("experiments.delete_experiment")`
- collection: `apps/documents/views.py:DeleteCollection` — `View.delete()` method, calls `collection.archive()`
- pipeline: `apps/pipelines/views.py:DeletePipeline` — `View.delete()` method, calls `pipeline.archive()`
- collection file: `apps/documents/views.py:delete_collection_file_view` — `@require_POST` + `@transaction.atomic()`

### `commcare_list_apps`

- **JSON REST.** Reuses the PlaywrightSession cookie jar (session cookie path) since the same auth covers `commcare_delete_app`.
- **URL:** `GET /a/<domain>/api/v0.4/application/` (TaskPie resource defined in `corehq/apps/api/resources/v0_4.py:ApplicationResource`). The unscoped `/api/v0.4/application/?domain=<domain>` form returns 404 from Django URL routing even though TaskPie accepts a `domain` query param — the resource is mounted only under the `/a/<domain>/` prefix.
- **Response (JSON):** `{ objects: [{ id, name, version, is_released, built_on, modules, versions }], meta: {...} }`
- **Auth:** `LoginAndDomainAuthentication(allow_session_auth=True)` — session cookies work. API key (`Authorization: ApiKey ...`) also works on this resource if needed.
- **For sweep:** we only need `id`, `name`, `doc_type`. The domain is fixed by the URL path.

### `commcare_delete_app`

- **HTML form POST.** Cannot use API key — requires session cookie + CSRF (`@require_can_edit_apps` + Django middleware).
- **URL:** `POST /a/<domain>/apps/delete_app/<app_id>/`
- **CSRF flow (mirror `commcare_make_build`):**
  1. GET `/a/<domain>/apps/` to populate `csrftoken` cookie.
  2. Extract token from cookie jar.
  3. POST `/a/<domain>/apps/delete_app/<app_id>/` with `X-CSRFToken` header.
- **Form body:** empty (app_id comes from URL).
- **Decorators:** `@no_conflict_require_POST` + `@require_can_edit_apps`.
- **Response on success:** HTTP 302 redirect to domain dashboard (`HttpResponseRedirect(reverse(DomainDashboardView.urlname, args=[domain]))`).
- **Soft-delete:** sets `Application.doc_type` to `Application-Deleted`, creates `DeleteApplicationRecord` for undo. Restore via `undo_delete_app/<record_id>/`.

### `labs_delete_record`

- **REST with OAuth2 Bearer** — same token (`LABS_MCP_TOKEN`) the proxy already uses for `/mcp/`, but hits a different endpoint.
- **URL:** `POST /export/labs_record/` (NB: HTTP method is POST despite "delete" semantics; the view is a `ListCreateAPIView` with a custom `delete()` method — but the dispatching is by POST verb with the operation implied by the call shape)
- **Body:** `[{"id": <int>}]` — array of `{id}` objects (single-object form also accepted; the view normalizes).
- **Auth header:** `Authorization: Bearer ${LABS_MCP_TOKEN}` (standard `oauth2_provider` + `TokenHasScope` with `required_scopes = ["export"]`).
- **No type discriminator needed** — lookup is by primary key alone (`LabsRecord.objects.filter(pk__in=ids).delete()`).
- **Permissions:** OAuth2 "export" scope + record-scope check (`_check_edit_permissions()` walks opportunity_id/program_id/organization_id from the request data, but for delete the scope check is on the record being deleted — non-owner-with-scope can delete; hard-delete, no audit trail).
- **Response on success:** HTTP 200, empty body.

**Proxy implementation:**
The labs MCP proxy (`mcp/connect-labs-server.ts`) currently forwards every JSON-RPC frame unchanged. To add `labs_delete_record` as a LOCAL tool:

1. Define the tool schema once at module scope:
   ```typescript
   const LOCAL_TOOLS = [{
     name: 'labs_delete_record',
     description: 'Hard-delete a LabsRecord by primary key. Covers solicitations, funds, reviews, and responses (all backed by the same LabsRecord table; type discriminator not required).',
     inputSchema: {
       type: 'object',
       properties: { id: { type: 'integer' } },
       required: ['id'],
     },
   }];
   ```
2. In the frame handler:
   - If `method === 'tools/list'`: forward upstream as usual, then in the response merge `LOCAL_TOOLS` into `result.tools`.
   - If `method === 'tools/call'` and `params.name === 'labs_delete_record'`: do NOT forward. Make a direct REST call:
     ```typescript
     const res = await fetch(`${LABS_BASE_URL}/export/labs_record/`, {
       method: 'POST',
       headers: {
         'Authorization': `Bearer ${token}`,
         'Content-Type': 'application/json',
       },
       body: JSON.stringify([{ id: params.arguments.id }]),
     });
     ```
     Return an MCP `tools/call` result frame.
   - Otherwise: forward unchanged.
3. `LABS_BASE_URL` defaults to `https://labs.connect.dimagi.com` (strip the `/mcp/` suffix from `LABS_MCP_URL` if set).

## Per-PR file inventory (8 PRs, or N bundled-PR variants)

Each atom PR touches these files:

**Single Connect atom (`delete_unaccepted_flw_invites`):**
- `mcp/connect/capability-map.ts` — add capability
- `mcp/connect/client.ts` — add method signature
- `mcp/connect/backends/playwright.ts` — implementation
- `mcp/connect/backends/composite.ts` — passthrough to playwright
- `mcp/connect/backends/rest.ts` — stub
- `mcp/connect-server.ts` — register MCP tool
- `test/mcp/connect/unit/playwright-fallbacks.test.ts` — add test cases (or new file)
- `skills/sweep-connect/SKILL.md` — promote FLW invites from report-only to auto-delete
- `agents/sweep.md` — update coverage matrix

**Each OCS archive atom** follows the same 9-file pattern in `mcp/ocs/`. The 4 archive atoms could ship as one PR (all touch the same files; differ only in URL/method).

**HQ atoms (list_apps + delete_app):**
- `mcp/connect/backends/commcare.ts` — both implementations
- `mcp/connect-server.ts` — register both MCP tools
- `test/mcp/connect/unit/` — new test files
- `skills/sweep-hq/SKILL.md` — promote from stub to operational
- `agents/sweep.md` — update coverage matrix

**Labs atom:**
- `mcp/connect-labs-server.ts` — extend with local-tool routing
- `test/mcp/connect-labs/` — new test file (does this dir exist? check)
- `skills/sweep-labs/SKILL.md` — promote LabsRecord types from report-only to auto-delete
- `agents/sweep.md` — update coverage matrix

## Recommended ship order

1. **`connect_delete_unaccepted_flw_invites`** — smallest, well-researched, demonstrates the pattern.
2. **`labs_delete_record`** — single-file proxy extension; high value (covers 4 product types with one atom).
3. **`commcare_delete_app` + `commcare_list_apps`** — promotes HQ from stub to operational.
4. **4 OCS archive atoms** — bundle into one PR since they all touch the same OCS MCP files and follow the same pattern.

## Out of scope

- `connect_delete_opportunity` — no upstream view exists. Would require a Django PR to commcare-connect first.
- HQ build / multimedia delete — no upstream support at all. Permanent gap; document in sweep report.
- Connect program / payment unit delete — no upstream support. Permanent gap; admin-UI link only.
