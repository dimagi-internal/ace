# Connect `LearnModule.slug` / `DeliverUnit.slug` 50-char Trap (Phase 4 HTTP 500 Root Cause)

**Status:** Open upstream (commcare-connect `SlugField()` defaults to `max_length=50` on both columns). Mitigated client-side in ACE by an `app-release` Step 6 projection gate + `pdd-to-{learn,deliver}-app` brief-template REQUIRED clauses.

**Origin:** `leep-paint-collection` run `20260517-1515` Phase 4 — `connect_create_opportunity` returned HTTP 500 (empty body). Phase 4 subagent bisected cleanly to the new Learn app's CCZ. A first investigation (CCZ-markers diff) was inconclusive — both old and new CCZs had identical Connect-marker shape. The actual cause was found in the Connect server-side Sentry event (issue `7456141696`) once the operator could pull the traceback.

## What looked like the bug (prior framings, in order of refutation)

1. **`commcare-form-patch` over-stripping (turmeric 20260513-0616 echo).** Hypothesized first because the post-patch Learn CCZ greps `connect_markers.assessment: 0` — same shape as the prior over-strip. Refuted by CCZ-diff investigation: both the working OLD Learn (`ce236fd…`) and the broken NEW Learn (`920a3d37…`) project the same marker counts (6 modules, 0 assessments, 0 deliver, 0 task, `collision_count: 0`). `commcare-form-patch` was correctly scoped to the assessment-wrapper regex; module markers preserved.
2. **`time_estimate: NULL` violating the `IntegerField` NOT NULL constraint.** Hypothesized from reading the `sync_learn_modules_and_deliver_units` + `extract_modules` code path: `app_xml.py:108` yields `time_estimate=None` if `<learn:time_estimate>` is missing, and the `LearnModule.objects.update_or_create` INSERT would then violate. Refuted by the Sentry event: `time_estimate: 20` was correctly populated. The `update_or_create` reached its INSERT cleanly.

## What the bug actually is

Postgres column-width mismatch at the slug-derivation boundary:

| Field | Model (`opportunity/models.py`) | Slug source |
|---|---|---|
| `LearnModule.slug` (line 252) | `models.SlugField()` (default `max_length=50`) | `extract_modules` (`app_xml.py:104`) — reads `<learn:module id="…">` attribute |
| `DeliverUnit.slug` (line 514) | `models.SlugField()` (default `max_length=50`) | `extract_deliver_unit` (`app_xml.py:117`) — reads `<learn:deliver id="…">` attribute |

The `<learn:module id="…">` attribute is emitted by Nova's `compile_app` as `module_<index>_<slugify(connect.learn_module.name)>`. For the LEEP module 6 name `"Stage 2: Sample Preparation, Drying, Bagging, Shipment"`, this produced slug `module_6_stage_2_sample_prep_drying_bagging_shipment` — **52 chars**, two past the column limit. Nova's slugifier abbreviated "Preparation" → "prep" but the name was still too long.

Failure path inside Connect's POST `/api/programs/<id>/opportunities/` handler:

1. `ManagedOpportunityCreateSerializer.create()` calls `ManagedOpportunity.objects.create(...)` inside `transaction.atomic()` → success.
2. `sync_learn_modules_and_deliver_units(opportunity)` runs in the same atomic block (`program/api/views.py:100`).
3. Inside the sync, `LearnModule.objects.update_or_create(app=learn_app, slug="module_6_stage_2_sample_prep_drying_bagging_shipment", defaults={time_estimate: 20, ...})` issues the `INSERT INTO opportunity_learnmodule (...slug, name, description, time_estimate) VALUES (...)`.
4. Postgres raises `psycopg2.errors.StringDataRightTruncation: value too long for type character varying(50)` → Django wraps as `django.db.utils.DataError`.
5. `program/api/views.py:102` only catches `(CommCareHQAPIException, AppNoBuildException, httpx.RequestError, httpx.TimeoutException, httpx.ConnectError)` — `DataError` bubbles up.
6. Django returns HTTP 500 with no actionable response body. The atomic block rolls back the `ManagedOpportunity` row, so no opp is created and no trace remains except the Sentry event.

## Proof

Sentry event `7456141696` (project `commcare-connect`, production, 2026-05-17 15:50Z) captured the full chain — three exceptions in the order Django re-raises them:

1. `LearnModule.DoesNotExist` (from `update_or_create`'s `.get()` probe — expected miss, not the cause)
2. `psycopg2.errors.StringDataRightTruncation: value too long for type character varying(50)`
3. `django.db.utils.DataError: value too long for type character varying(50)`

The INSERT params in the traceback are unambiguous:

```
slug:        'module_6_stage_2_sample_prep_drying_bagging_shipment'   (52 chars)
name:        'Stage 2: Sample Preparation, Drying, Bagging, Shipment'
description: 'Area preparation, 1-Pot vs 2-Pot method, pre-labelling stirrers and lids, safety equipment, cross-contamination avoidance, drying timeline, dual-bagging, WOHL shipment packaging, and special protocols for tints and spray paints.'
time_estimate: 20
```

`time_estimate: 20` rules out the prior NOT-NULL hypothesis. The slug length (52) is the actual offender.

## Why prior framings missed it

- **CCZ-marker bisect missed it** because the slug-length issue isn't visible in `connect_markers` (the count of `<learn:module>` elements) or in `projected_connect_state.collisions` (the slug-collision check). The pre-fix MCP projection captured the slug values but didn't compare against the column-width limit.
- **The 2026-05-12 generalized serializer-vs-model length probe** (still pending, see `boundary-probe-registry.md`) would NOT have caught this, because the slug is NOT sent through any serializer field — it's derived server-side from the CCZ's `<learn:module id>` attribute inside `extract_modules`. The probe's premise ("scan DRF `CharField.max_length` vs model `CharField.max_length` mismatches") is structurally blind to extract paths.

## Fixes shipped (ACE side)

ACE PR (this commit): four-layer defense against recurrence.

1. **`mcp/connect/backends/commcare.ts`** — `simulateConnectSync` projection extended with `slug_length_limit: number` (constant 50), `max_slug_length: number`, and `oversized_slugs: { deliver_units, learn_modules, task_units, assessments }`. Each oversized array lists the full `ProjectedRecord`s (slug + first_seen_in form). New constant `SLUG_LENGTH_LIMIT = 50` for lock-step bumping when the upstream Connect column widens.
2. **`test/mcp/connect/unit/connect-sync-projection.test.ts`** — five new tests covering (a) every projection exposes the new fields, (b) `learn_module` slugs > 50 flagged (the leep-paint regression as fixture), (c) `deliver_unit` slugs > 50 flagged, (d) empty projection sensible defaults, (e) 50-char slugs do NOT trigger (boundary inclusive).
3. **`skills/app-release/SKILL.md` § Step 6** — gate extended from `collision_count === 0 && per-type > 0` to ALSO require every `oversized_slugs.*` array empty. `[BLOCKER]` brief MUST list each offender as `<type>: <slug> (<length> chars, in <first_seen_in>)`. Concrete remediation guidance: keep `connect.learn_module.name` / `connect.deliver_unit.name` ≤ 40 chars.
4. **`skills/pdd-to-learn-app/SKILL.md` + `skills/pdd-to-deliver-app/SKILL.md`** — new REQUIRED clause in each brief template instructing the Nova architect to keep module/deliver-unit names ≤ 40 chars, with the exact rationale (Nova prefix + slugify + Connect column limit) and a removal criterion tied to the upstream Connect PR widening the column.

The four layers are defense-in-depth: brief templates upstream prevent most occurrences, `app-release` Step 6 is the structural backstop that catches anything that slips past (e.g., operator-driven manual Nova edits). The MCP projection is the data source for both.

## Fix needed upstream (commcare-connect)

`opportunity/models.py:252` and `opportunity/models.py:514`:

```python
# Before
slug = models.SlugField()             # implicit max_length=50

# After
slug = models.SlugField(max_length=255)
```

Plus migration. The 50-char default has no operational justification (slug strings are tiny in storage cost) and traps every CCZ whose module names slugify past 50. Connect PR to follow.

Removal criterion for the ACE-side preventers: drop the brief-template REQUIRED clauses and bump `SLUG_LENGTH_LIMIT` (and any test fixtures relying on it) in lock-step with the Connect column widening.

## Generalization (Vellum-as-source-of-truth)

**The HQ-side authoring source of truth for Connect blocks is the Vellum plugin at `dimagi/Vellum:src/commcareConnect.js`.** That file is the spec Nova's `compile_app` should mirror — and it makes a key separation Nova currently elides: the Connect slug (`<learn:module id="…">`) comes from the form's `nodeID` field (an explicit user-supplied identifier), NOT from a slugified display name. The `name` element is a SEPARATE field that holds the human-readable label.

From `src/commcareConnect.js:117-173` (Learn Module spec):

```javascript
ConnectLearnModule: {
  rootName: "module",
  childNodes: [
    {id: "name", writeToData: true},
    {id: "description", writeToData: true},
    {id: "time_estimate", writeToData: true},
  ],
  mugOptions: { spec: {
    nodeID: { lstring: 'Module ID' },        // ← slug; user-supplied directly
    name:   { lstring: 'Name', required: true },
    description: { ... required ... },
    time_estimate: {
      ... required ...,
      validationFunc: mug => /^\d+$/.test(mug.p.time_estimate) ? 'pass' : 'Must be an integer',
      help: 'Estimated time to complete the module in hours.',
    },
  } }
}
```

And the emitter at `dataChildFilter` (lines 89-115):

```javascript
getExtraDataAttributes: () => ({
  "xmlns": CCC_XMLNS,
  "id": mug.p.nodeID,    // ← the slug comes from nodeID, NOT a slugified name
})
```

The Vellum test fixture `tests/static/commcareConnect/learn_module.xml` confirms:

```xml
<module xmlns="http://commcareconnect.com/data/v1/learn" id="module_1">
  <name>module 1</name>
  <description>...</description>
  <time_estimate>2</time_estimate>
</module>
```

Two distinct values: `id="module_1"` (short, code-like, picked as the form's nodeID) and `<name>module 1</name>` (display label, can be long). Vellum-authored apps don't have the slug-length problem because the user picks a short stable identifier for the nodeID and writes their descriptive title in `name`.

**Nova's behavior diverges.** Nova's `compile_app` derives the Connect `id` as `module_<idx>_<slugify(name)>` when the architect doesn't set `connect.learn_module.id` explicitly — conflating two fields Vellum keeps separate. The architect-brief REQUIRED clauses (this learning doc → `pdd-to-{learn,deliver}-app/SKILL.md`) instruct the architect to ALWAYS set `id` explicitly, mirroring what a human Vellum author naturally does.

**Other Vellum-prescribed rules Nova should mirror:**

| Vellum rule | Source | Currently in Nova/ACE? |
|---|---|---|
| `time_estimate` is in **hours**, not minutes | `src/commcareConnect.js:158` ("Estimated time to complete the module in hours") + Connect's `LearnModule.time_estimate` docstring | NOW in `pdd-to-learn-app/SKILL.md` brief template (added 0.13.275) — previously not specified; an architect on the LEEP run set 10-20 (intending minutes) which Connect would have stored as 10-20 hours |
| `time_estimate` MUST match `^\d+$` (positive integer only) | `src/commcareConnect.js:155` (`validationFunc`) | Nova's API schema says `"type": "number"` (allows decimals) — narrower validator should be on the Nova side |
| `connect.deliver_unit.entity_id` / `entity_name` are OPTIONAL XPath fields | `src/commcareConnect.js:240, 249` (`presence: 'optional'`) | Nova has them but the `update_form` deliver_unit runtime auto-fills broken defaults (`voidcraft-labs/nova-plugin#1`) — known upstream bug |
| `relevantAttr` (XPath) for conditional display of the Connect block itself | `src/commcareConnect.js:27-40` (`logicSection`), applied to every Connect mug type | Not exposed in Nova — no current PDD needs it, low priority |
| New mug type `ConnectWorkAreaUpdate` — FLW-driven work-area issue reporting (status, reason, additional_details, photo_evidence) | `src/commcareConnect.js:321-402` | Not in Nova's vocabulary at all — possible new Connect feature we haven't surfaced. File a spec doc when relevant. |

**Why this matters operationally.** Once the architect sets `id` explicitly, the brief's ≤40-char-name fallback becomes a defense-in-depth safety net rather than the primary rule. After commcare-connect#1195 widens the columns to 255 (or whatever), drop the ≤40-char fallback — but KEEP the explicit-id rule, because it's not a workaround. It's a cleanliness invariant matching Vellum's slug/name separation and stays correct regardless of upstream column width.

## Two failure shapes, one bug class

The 2026-05-12 `short_description` 50-char trap and this 2026-05-17 slug-length trap are **the same shape of bug at different boundaries**:

| | `short_description` trap | `slug` trap |
|---|---|---|
| Column | `Opportunity.short_description` `CharField(max_length=50)` | `LearnModule.slug` / `DeliverUnit.slug` `SlugField()` (default 50) |
| Value source | DRF serializer field, caller-supplied | Server-extracted from CCZ XML in `extract_modules` / `extract_deliver_unit` |
| Wire visibility | Yes — in the POST body | No — derived inside the view |
| Failure shape | Postgres `DataError` → uncaught → HTTP 500 empty body | Postgres `DataError` → uncaught → HTTP 500 empty body |
| Pre-fix preventer | None | None |
| Post-fix preventer | `mcp/connect-server.ts:218,276` Zod `max(50)` cap | `app-release` Step 6 projection gate + architect brief constraints |

The class is "Postgres column-width violation → uncaught DRF view exception → opaque 500." The boundary-probe-registry's pending **Generalized serializer-vs-model length probe** would catch the wire-visible half (`short_description` shape) but not the extract-path half (`slug` shape). A truly general probe needs to walk all `Char`/`SlugField` columns in commcare-connect's `models.py` AND know which are caller-fed (Zod cap on the MCP atom) vs derived from CCZ extract (CCZ-projection gate on the producer skill). The probe is still open as a follow-up.

A narrower-but-shippable next probe: extend `program/api/views.py:102`'s `except` clause to catch `DataError` and `IntegrityError` and return `HTTP 400 Bad Request` with the offending column name in the body. That converts every future trap of this shape (any column, any path) from "opaque 500" to "actionable 400." Independent of the slug-column fix; would have surfaced this bug in seconds instead of an hour-long bisect. Worth filing as a Connect issue alongside the slug max_length PR.

## See also

- `docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md` — sibling trap, same class.
- `docs/learnings/2026-05-12-connect-uncaught-domain-exceptions.md` — the broader "narrow except clause" pattern.
- `docs/learnings/2026-05-12-boundary-probe-registry.md` — registry entry added under Shipped probes.
- `skills/app-release/SKILL.md` § Step 6 — the gate.
- `mcp/connect/backends/commcare.ts` — the projection (`simulateConnectSync`, `SLUG_LENGTH_LIMIT`).
- `test/mcp/connect/unit/connect-sync-projection.test.ts` — slug-length describe block.
