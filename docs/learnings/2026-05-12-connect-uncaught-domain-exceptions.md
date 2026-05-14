# commcare-connect View-Handler Audit: Uncaught Domain Exceptions → Opaque 500

**Date:** 2026-05-12
**Status:** Audit complete. Two new instances filed upstream (CI-662, CI-664). Class-level upstream fix recommended.

Audit of `commcare-connect` view handlers for the *uncaught domain exception → opaque 500* class — the same shape as CI-659 (`short_description` length mismatch).

## Methodology

Read every view handler in `commcare-connect`'s automation API surface (`commcare_connect/opportunity/api/views/*.py`, `commcare_connect/program/api/views.py`, `commcare_connect/users/api/views.py`, `commcare_connect/users/views.py`) plus the URL router (`config/api_router.py`) to enumerate endpoints exposed via REST. For each handler: identified the called helpers one level deep, cross-checked the exceptions those helpers raise against the handler's `try/except` clauses, and flagged gaps where domain exceptions (`CommCareHQAPIException`, `AppNoBuildException`, `django.db.DataError` inside `transaction.atomic()`, raw `httpx.*` from unwrapped calls) can bubble. DRF serializer `max_length` was cross-checked against the underlying model `CharField` constraint for the CI-659 mismatch shape.

## Known instances (already filed)

- **CI-659** — `Opportunity.short_description`: DRF serializer `CharField(max_length=255)` vs model `CharField(max_length=50)`. Postgres `DataError` inside `transaction.atomic()` falls through the view's narrow `except` on `httpx.*`/`CommCareHQAPIException`/`AppNoBuildException`. ACE mitigation: Zod `max(50)` cap in `mcp/connect-server.ts` (commit `e5aceb1`, 0.13.177).

## New instances found in this audit

| Instance | Location | Gap class | Severity | Upstream ticket |
|---|---|---|---|---|
| `ManagedOpportunityCreateView.short_description` length mismatch | `commcare_connect/program/api/serializers.py:131` vs `commcare_connect/opportunity/models.py:92` | `DataError` in `transaction.atomic()` not caught by view's narrow `except` (`program/api/views.py:102-108`) | **HIGH** — ACE's managed-opp creation path; masked client-side today by the Zod cap, but any other automation-API consumer hits it | [CI-662](https://dimagi.atlassian.net/browse/CI-662) |
| `sync_deliver_units` subclass-vs-parent drift | `commcare_connect/opportunity/views.py:2009` | `except AppNoBuildException` only — parent `CommCareHQAPIException` and raw `httpx.RequestError`/`TimeoutException`/`ConnectError` from `get_form_xml_for_app` (`app_xml.py:77`, unwrapped `httpx.get`) bubble | Low — HTMX/internal Connect UI endpoint, not on ACE's automation-API surface. Filed for class-level fix coverage; the leaf-vs-parent catch is the canonical *subclass-vs-parent exception drift* shape | [CI-664](https://dimagi.atlassian.net/browse/CI-664) |

## Pattern characteristics — what makes a view handler vulnerable

- **Narrow `except` tuple frozen at the time of writing.** Catches `httpx.RequestError`/`TimeoutException`/`ConnectError` (the visible network failures) but not the higher-level domain exceptions (`CommCareHQAPIException`, `AppNoBuildException`) that helpers wrap them in. The `httpx.*` clauses become decoys: code looks defensive but skips the actual exception class that fires in practice.
- **`transaction.atomic()` block with no Postgres `DataError` catch.** Any DRF serializer `max_length` that exceeds the underlying model `max_length` (or any other column constraint mismatch) → `DataError` raised inside the atomic block → bubbles past the view's domain-exception catches → HTTP 500.
- **Helper called outside `try/except` entirely.** A helper that raises a domain exception is called bare — trivially fixable, easy to miss in code review (the helper *looks* like it returns a bool).
- **Subclass-vs-parent exception drift.** `AppNoBuildException(CommCareHQAPIException)` — handlers that `except AppNoBuildException` only catch the leaf case; other `CommCareHQAPIException` instances raised by the same call chain (e.g., `get_form_xml_for_app` → `extract_*` parsing failures, or auth failures) bubble. The narrow catch reads as defensive but ignores the parent class.
- **Schema validation that runs *before* DB constraints.** DRF's `is_valid(raise_exception=True)` enforces serializer rules and returns a clean 400, masking the fact that the *next* layer (Django model save into Postgres) has stricter rules. Any field where serializer-cap > model-cap is a latent CI-659.

## ACE-side mitigation pattern

The canonical ACE-side preventer is the `short_description.max(50)` Zod cap in `mcp/connect-server.ts:218,276` (commit `e5aceb1`, 0.13.177). It turns "intermittent HTTP 500 with no body" into a deterministic Zod validation error before the network round-trip, with a description block citing the upstream mismatch and pointing at the learning doc.

These class-level preventers are tracked in `docs/learnings/2026-05-12-boundary-probe-registry.md` (landed in PR #252). The registry's **Pending probes** table already calls for a *generalized* serializer-vs-model length probe — a static scan over commcare-connect's `models.py` + `serializers.py` surfacing every `CharField` where the DRF `max_length` exceeds the model `max_length`. Building that probe would catch every future CI-659-shaped instance for free. CI-662 is one such instance discovered manually; an automated probe would have found it without an audit pass.

## Recommendation for the commcare-connect team

All instances filed (CI-662, CI-664) — and the underlying class — are eliminable with a single change: add a DRF exception handler (`REST_FRAMEWORK.EXCEPTION_HANDLER`) or a base `APIView` mixin that catches `CommCareHQAPIException`, `AppNoBuildException`, and `django.db.DataError` uniformly, logs with `logger.exception`, and converts to a structured 4xx/5xx response (e.g., 502 for upstream-HQ failures, 400 for `DataError` with a field hint extracted from the Postgres error message). Every handler that currently *does* catch these (the canonical `ManagedOpportunityCreateView`) would still work; every handler that *doesn't* would inherit the correct behavior. This eliminates the class — future drift between serializer caps and model caps, or new helpers that raise `CommCareHQAPIException`, would surface as actionable structured responses, not opaque 500s.

Until that class-level fix lands, ACE will continue shipping per-atom Zod caps and pre-flight probes as new instances surface — see the registry for the cadence.

## Re-audit cadence

Re-run this audit on every new ACE-discovered instance of the class — append a row to the table above, file a CI ticket, link both directions. The audit costs ~30 minutes of reading; the upstream-fix lobbying is the slow part.
