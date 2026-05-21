# CommCare HQ REST vs Playwright Backend Probe Report

**Date:** 2026-05-21  
**Scope:** ~30 new MCP atoms for Connect Interviews automation  
**Output:** Per-endpoint REST vs Playwright recommendation  

---

## Methodology

This probe examined CommCare HQ source code at `/dimagi/commcare-hq` to classify each atom as:

- **REST**: Clean JSON endpoint found (Tastypie Resource, DRF @action, or dedicated API view)
- **Playwright**: Admin-only HTML form view (no REST counterpart)
- **Hybrid**: Both REST and HTML views available
- **Out of Scope**: Feature flag / ACL / out-of-band workflow

Indicators for REST: `/a/<domain>/api/v0.X/`, Tastypie Resource classes, `@api_view`, `@require_api`, `@json_response`, DRF `@action`  
Indicators for admin-only: `BaseDomainView`, `BaseAdminView`, rendered templates only, no API decorator

---

## Per-Atom Recommendations

| # | Atom | Endpoint(s) | Method | Auth | Recommendation | Notes |
|---|------|-------------|--------|------|-----------------|-------|
| 1 | `commcare_get_domain_features` | `/a/<domain>/api/v0.5/domain/` | GET | API Key | REST | Feature property access; no dedicated endpoint found but domain metadata available via API |
| 2 | `commcare_set_domain_feature` | Messaging > Privileges (admin UI) | POST | Web Form | **Playwright** | Feature toggle is admin-only form in Project Settings; no REST API found |
| 3 | `commcare_list_connections` | Connections admin view | GET | Web Form | **Playwright** | ConnectionSettingsListView inherits BaseAdminView; no REST endpoint |
| 4 | `commcare_create_connection` | Connections admin view | POST | Web Form | **Playwright** | ConnectionSettingsDetailView is HTML form-only; no REST API |
| 5 | `commcare_list_form_forwarders` | Data Forwarding admin view | GET | Web Form | **Playwright** | FormForwarder list rendered via admin view; no REST endpoint found |
| 6 | `commcare_create_form_forwarder` | Data Forwarding admin view | POST | Web Form | **Playwright** | Repeater creation requires admin form submission |
| 7 | `commcare_list_form_repeaters` | Data Forwarding admin view | GET | Web Form | **Playwright** | ConfigurableRepeaterView is admin-only; no direct REST API |
| 8 | `commcare_create_form_repeater` | Data Forwarding admin view | POST | Web Form | **Playwright** | Repeater CRUD is admin UI only |
| 9 | `commcare_list_ucr_expressions` | Data > Expressions admin view | GET | Web Form | **Playwright** | UCR expression list is admin UI; linked_domain views are read-only data pushes |
| 10 | `commcare_list_inbound_apis` | Inbound API admin view | GET | Web Form | **Playwright** | ConfigurableAPIListView inherits BaseAdminView; no REST API |
| 11 | `commcare_create_inbound_api` | Inbound API admin view | POST | Web Form | **Playwright** | Inbound API configuration requires admin form |
| 12 | `commcare_list_user_fields` | Users > Edit User Fields | GET | Web Form | **Playwright** | User field list rendered via admin view; no dedicated REST endpoint |
| 13 | `commcare_create_user_field` | Users > Edit User Fields | POST | Web Form | **Playwright** | User field creation is admin UI only |
| 14 | `commcare_user_field_add_choice` | Users > Edit User Fields | PATCH | Web Form | **Playwright** | Field choice updates via admin form; no REST API |
| 15 | `commcare_get_lookup_table` | `/a/<domain>/api/v0.5/fixture/<table_id>/` | GET | API Key | REST | LookupTableResource implemented in Tastypie; v0.5 REST endpoint confirmed |
| 16 | `commcare_create_lookup_table` | `/a/<domain>/api/v0.5/fixture/` | POST | API Key | REST | LookupTableResource POST supported |
| 17 | `commcare_get_lookup_table_rows` | `/a/<domain>/api/v0.5/fixture_item/` | GET | API Key | REST | LookupTableItemResource available as Tastypie endpoint |
| 18 | `commcare_lookup_table_append_rows` | `/a/<domain>/api/v0.5/fixture_item/` | POST | API Key | REST | LookupTableItemResource supports bulk POST |
| 19 | `commcare_list_conditional_alerts` | Messaging > Conditional Alerts (admin UI) | GET | Web Form | **Playwright** | Conditional alert list is admin view; no REST API found |
| 20 | `commcare_create_conditional_alert` | Messaging > Conditional Alerts (admin UI) | POST | Web Form | **Playwright** | Conditional alert creation is admin form only |
| 21 | `commcare_linked_app_push` | Linked Domain > Service RMI | POST | API Key | REST | DomainLinkRMIView.as_view() provides RMI entry point; push is RMI-based service call |
| 22 | `commcare_linked_app_copy` | `/a/<domain>/api/v0.5/` (app_manager) | POST | API Key | **Hybrid** | Linked domain copy via RMI service call (REST-backed); also available as admin form |
| 23 | `commcare_get_case` | `/a/<domain>/api/v0.5/case/` | GET | API Key | REST | CaseResource in Tastypie v0.5 API |
| 24 | `commcare_bulk_case_update` | `/a/<domain>/api/v0.5/case/` | POST | API Key | REST | CaseResource supports bulk import |
| 25 | `commcare_bulk_user_update` | `/a/<domain>/api/v0.5/user/bulk/` | POST | API Key | REST | BulkUserResource in v0.5 API handles bulk upload |
| 26 | `commcare_get_user` | `/a/<domain>/api/v0.5/user/` | GET | API Key | REST | CommCareUserResource in Tastypie v0.5 |
| 27 | `commcare_list_users` | `/a/<domain>/api/v0.5/user/` | GET | API Key | REST | CommCareUserResource GET list endpoint |
| 28 | `commcare_update_user_field` | `/a/<domain>/api/v0.5/user/<user_id>/` | PATCH | API Key | REST | CommCareUserResource supports PATCH (user data fields) |
| 29 | `commcare_get_feature_flags` | `/a/<domain>/api/v0.5/domain/` | GET | API Key | REST | Domain metadata endpoint; feature flag list read-only |
| 30 | `commcare_list_app_releases` | `/a/<domain>/api/v0.5/application/` | GET | API Key | REST | ApplicationResource in v0.5; releases metadata available |

---

## Summary

### Backend Breakdown

**REST-capable atoms:** 14  
- Users: `get_user`, `list_users`, `update_user_field`, `bulk_user_update`
- Cases: `get_case`, `bulk_case_update`
- Lookup tables: `get_lookup_table`, `create_lookup_table`, `get_lookup_table_rows`, `lookup_table_append_rows`
- Domain: `get_domain_features`, `get_feature_flags`
- Linked apps: `linked_app_copy` (RMI), `linked_app_push` (RMI)
- App releases: `list_app_releases`

**Playwright-only atoms:** 15
- Domain features: `set_domain_feature` (admin toggle)
- Connections: `list_connections`, `create_connection` (admin UI)
- Data forwarding: `list_form_forwarders`, `create_form_forwarder`, `list_form_repeaters`, `create_form_repeater`
- UCR expressions: `list_ucr_expressions` (read-only via admin UI; linked_domain push only)
- Inbound APIs: `list_inbound_apis`, `create_inbound_api`
- User fields: `list_user_fields`, `create_user_field`, `user_field_add_choice`
- Conditional alerts: `list_conditional_alerts`, `create_conditional_alert`

**Reused atoms (no probe needed):** 9
- Connect platform atoms (existing): `connect_get_opportunity`, `connect_list_payment_units`, `connect_create_opportunity`, `connect_update_opportunity`, `connect_activate_opportunity`, `connect_list_delivery_types`
- CommCare atoms (existing): `commcare_list_apps`, `commcare_release_build`

---

## Key Findings

### 1. Tastypie API Layer Is Primary REST Surface

CommCare HQ exposes a comprehensive Tastypie-based REST API at `/a/<domain>/api/v0.5/` (and v0.4, v0.6) covering:

- **User management:** CommCareUserResource, WebUserResource, GroupResource, BulkUserResource
- **Case operations:** CaseResource (supports CRUD + bulk import)
- **Lookup tables:** LookupTableResource, LookupTableItemResource (fixture system)
- **Domain metadata:** DomainResource (feature flags, properties)
- **Applications:** ApplicationResource (lists apps + releases metadata)

All use API Key authentication and return JSON.

### 2. Admin-Only Surface Is Substantial (15 atoms)

The following cannot be automated via REST and require Playwright:

1. **Domain configuration** (1 atom):
   - Feature flag toggling (admin settings form)

2. **Connections & forwarding** (6 atoms):
   - Connection CRUD (ConnectionSettingsListView / ConnectionSettingsDetailView)
   - Form forwarder CRUD (no REST API; admin view only)
   - Form repeater CRUD (ConfigurableRepeaterView admin-only)

3. **User field management** (3 atoms):
   - List/create/update user fields (admin form, no REST)
   - Field choices (admin form, no REST)

4. **Inbound APIs** (2 atoms):
   - Inbound API configuration (ConfigurableAPIListView/DetailView admin-only)

5. **Conditional alerts** (2 atoms):
   - Create/list conditional alerts (admin form in Messaging module)

6. **UCR expressions** (1 atom):
   - List read-only; creation pushed via linked_domain RMI from master domain

### 3. Linked Domain RMI Is REST-Capable

Linked domain operations (`commcare_linked_app_copy`, `commcare_linked_app_push`) route through `DomainLinkRMIView.as_view()` which is an RMI service endpoint. This **is REST-capable** (uses `/linked_domain/service/` with JSON payloads) but requires auth + domain link setup beforehand.

### 4. Data Forwarding Layer Has No REST API

Despite being core to the Interviews workflow:
- Form forwarders (repeaters)
- Connections (repeater targets)
- Conditional alerts (triggered on data)

...are all **admin UI only**. No REST endpoints found.

---

## Recommendations for ACE Implementation

### Immediate (V1)

Build Playwright atoms for:
1. **Domain bootstrap** (1): `set_domain_feature`
2. **Connections & forwarding** (6): All connection + repeater + inbound API atoms
3. **User fields** (3): Field list/create/choice management
4. **Conditional alerts** (2): Alert CRUD

These 12 atoms form a critical path and have no REST alternative.

### REST atoms (14) are lower risk:
- Use standard MCP Tastypie pattern (existing `commcare_list_users`, `commcare_list_apps` templates)
- All use v0.5 API + API Key auth
- Payload shapes are stable (Tastypie Resource definitions)

### Deferred (V2)

- **UCR expressions**: Currently linked_domain-only; no direct creation API needed yet
- **Feature flag auditing**: Out-of-band (admin-only toggle); verification only via read endpoint

---

## Appendix: Surface Area Summaries

### Users Module
- **REST:** `/a/<domain>/api/v0.5/user/` (list, get, bulk import)
- **Admin UI:** Edit User Fields form (no REST for field metadata CRUD)

### Fixtures (Lookup Tables)
- **REST:** `/a/<domain>/api/v0.5/fixture/` (table CRUD), `/a/<domain>/api/v0.5/fixture_item/` (row CRUD)
- Status: Full REST coverage ✓

### Motech (Data Forwarding)
- **Admin UI:** ConnectionSettingsListView, FormForwarder views, ConfigurableAPIListView
- **Status:** No REST API found; Playwright required for all repeater/connection/inbound-API CRUD

### Messaging
- **Admin UI:** Conditional Alert views
- **Status:** No REST API for conditional alert CRUD

### Linked Domains
- **REST:** `/linked_domain/service/` RMI endpoint (POST for push/copy operations)
- Status: RMI-based (JSON-friendly) but requires setup ✓

### App Manager
- **REST:** `/a/<domain>/api/v0.5/application/` (list + metadata), release builds available
- **Status:** List/get only (no direct create via REST; creation is via form builder)

---

**Report Generated:** 2026-05-21  
**Atoms Probed:** 30 (15 reads + 15 writes)  
**REST-capable:** 14  
**Playwright-required:** 15  
**Existing (reuse):** 9

---

## Verification Addendum (2026-05-21, post-probe spot-check)

Three of the "Playwright-required" classifications were spot-checked against `dimagi/commcare-hq` source. Two were confirmed; one needs correction.

### Conditional alerts — bulk CSV path exists (CORRECTION)

`corehq/messaging/scheduling/urls.py` includes:

```
url(r'^conditional/download/$', DownloadConditionalAlertView.as_view(), ...)
url(r'^conditional/upload/$',   UploadConditionalAlertView.as_view(),   ...)
```

This means `create_conditional_alert` and `list_conditional_alerts` should be implemented as **CSV upload / download** (not per-alert form Playwright). The endpoints are still Django views, not Tastypie REST, but they accept a single CSV POST and return a CSV — much closer to REST in shape and far less brittle than form-scraping.

Reclassify:
- `commcare_list_conditional_alerts` → **CSV-export-style HTTP** (driveable via `page.request.get()` + CSV parse, not full Playwright)
- `commcare_create_conditional_alert` → **CSV-import-style HTTP** (single POST with CSV body, no form interaction needed)

### Connections — confirmed Playwright

`corehq/motech/urls.py`: `ConnectionSettingsDetailView` is plain Django form view, `test_connection_settings` is a separate POST. No REST. Subagent's call stands.

### User Fields — confirmed form-driven, but cleaner than expected

`UserFieldsView` extends `CustomDataModelMixin`. The form accepts hidden JSON-encoded fields (`data_fields`, `profiles`, `require_profile`) — meaning a script can POST a single form-encoded request with JSON payloads in named fields, without needing to drive the rich UI widgets. Still classified Playwright (uses Django form auth), but at the same complexity as the conditional-alert CSV path, not full element-by-element scraping.

### Effective updated counts

The 30-atom split is approximately:

- **REST (clean Tastypie/RMI):** 14 atoms — unchanged
- **HTTP-driveable but not REST** (CSV uploads, hidden-JSON forms): ~6 atoms (conditional alerts × 2, user fields × 3, inbound APIs maybe — needs further probe)
- **True form-Playwright** (must drive UI widgets): ~9 atoms — connections, data forwarding (form forwarders + repeaters), feature toggle

This matters for V1 budget: the "HTTP-driveable" tier is roughly 30-50% the implementation cost of full UI-driving Playwright. Adjust the build plan accordingly.

The remaining Playwright-required atoms (connections, repeaters) are the bulk of the admin form work — that's still a substantial chunk, but smaller than the 15-atom headline.
