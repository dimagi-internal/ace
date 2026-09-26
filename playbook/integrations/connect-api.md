# Connect Integration

> **Upstream repo: [`dimagi/commcare-connect`](https://github.com/dimagi/commcare-connect).** Connect ships continuously,
> so an ACE call path that has not changed in months can break because *they* shipped.
> When something that used to work starts failing — especially with an opaque error —
> run `skills/upstream-regression-triage` before concluding it needs a live probe.

## Two MCP servers, two domains

ACE talks to Connect through **two** MCP servers, each scoped to a distinct
domain:

1. **`connect-labs` MCP** (lives in the [`connect-labs` repo](https://github.com/dimagi-internal/connect-labs))
   — solicitations, reviews, awards, funds. Production-ready and unrelated to
   the Programs/Opportunities lifecycle ACE manages.

2. **`ace-connect` MCP** (in this repo, `mcp/connect-server.ts`) — Programs,
   Opportunities, invites, invoices. Drives the
   `connect-program-setup`, `connect-opp-setup`, `llo-onboarding`,
   `llo-launch`, and `opp-closeout` skills.

This document covers `ace-connect`. For `connect-labs`, see that repo's docs.

## What ace-connect exposes today

Twenty atomic capabilities. Eight of the authoring atoms now go through the
**REST automation API** that commcare-connect PR #1135 shipped on
2026-04-30; the remaining atoms still drive HTML form pages via Playwright
(reads, edits, verification flags, invoices). Both backends share the same
authenticated session (OAuth-via-CommCareHQ as `ace@dimagi-ai.com`) — REST
endpoints accept the Django `sessionid` cookie + CSRF token DRF's
`SessionAuthentication` enforces.

### Programs (4)

| Atom | Backend | Used by |
|---|---|---|
| `connect_create_program` | REST `POST /api/programs/` | `connect-program-setup` |
| `connect_update_program` | Playwright (no REST yet) | `connect-program-setup` |
| `connect_list_programs` | Playwright | `connect-program-setup` (idempotency check) |
| `connect_get_program` | Playwright | `connect-program-setup` |
| `connect_list_delivery_types` | Playwright | `connect-program-setup` (resolve "Nutrition" → slug/FK) |

### Opportunities (4)

| Atom | Backend | Used by |
|---|---|---|
| `connect_create_opportunity` | REST `POST /api/programs/<id>/opportunities/` | `connect-opp-setup` |
| `connect_update_opportunity` | Playwright (no REST yet) | `connect-opp-setup`, `llo-launch` |
| `connect_list_opportunities` | Playwright | `connect-opp-setup` (idempotency check) |
| `connect_get_opportunity` | Playwright | `connect-opp-setup`, `llo-launch` |

### Per-opp configuration (4)

| Atom | Backend | Used by |
|---|---|---|
| `connect_set_verification_flags` | Playwright (no REST yet) | `connect-opp-setup` |
| `connect_list_deliver_units` | Playwright | `connect-opp-setup` (also returned inline by `create_opportunity`) |
| `connect_create_payment_unit` | REST `POST /api/opportunities/<id>/payment_units/` | `connect-opp-setup` (singular wrapper) |
| `connect_create_payment_units` | REST same endpoint | `connect-opp-setup` (atomic batch — preferred) |
| `connect_list_payment_units` | Playwright | `connect-opp-setup` (verify after create) |

### Lifecycle (1)

| Atom | Backend | Used by |
|---|---|---|
| `connect_activate_opportunity` | REST `POST /api/opportunities/<id>/activate/` | `llo-launch` |

### Invites (4)

| Atom | Backend | Used by |
|---|---|---|
| `connect_send_llo_invite` | REST `POST /api/programs/<id>/applications/` | `llo-onboarding` |
| `connect_accept_program_application` | REST `POST .../accept/` | `llo-onboarding` (ACE-driven dogfood only) |
| `connect_send_flw_invite` | REST `POST /api/opportunities/<id>/invite_users/` | `connect-opp-setup` Step 7 / `llo-launch` |
| `connect_list_invites` | Playwright | `llo-onboarding` (status check) |

### Invoices (2)

| Atom | Backend | Used by |
|---|---|---|
| `connect_list_invoices` | Playwright (stub — page shape not yet probed) | `opp-closeout` |
| `connect_get_invoice` | Playwright (stub) | `opp-closeout` |

## Data model gotchas

### An unfinished opportunity has NO dashboard — Connect 302s it to the payment-unit wizard

`total_budget`, `start_date` and `program_name` are rendered on exactly one
Connect surface: the opportunity dashboard (`/a/<org>/opportunity/<id>/`). No
form carries them — the edit form's field set is `name`, `short_description`,
`description`, `currency`, `country`, `end_date`, `delivery_type`,
`delivery_level`, `learn_level`, `active`, `is_test`, `users` — so if the
dashboard does not render, those three fields are unobtainable.

For an opportunity whose setup was never finished, the dashboard **never
renders**. Upstream, `commcare_connect/opportunity/views.py`:

```python
class OpportunityDashboard(OpportunityObjectMixin, OrganizationUserMixin, DetailView):
    def get(self, request, *args, **kwargs):
        self.object = self.get_object()
        if not self.object.is_setup_complete:
            messages.warning(request, "Please complete the opportunity setup to view it")
            return redirect("opportunity:add_payment_units", org_slug=request.org.slug,
                            opp_id=self.object.opportunity_id)
```

…and `Opportunity.is_setup_complete` (models.py) is:

```python
if not (self.paymentunit_set.exists() and self.total_budget
        and self.start_date and self.end_date):
    return False
for pu in self.paymentunit_set.all():
    if not (pu.max_total and pu.max_daily):
        return False
```

Measured on `ai-demo-space` 2026-09-06, with the ACE session:

```
=== the 11 rows ace#1637 called `no_cards` ===
388851ca-… dash=302->payment_units/create pu_table=200 no_payment_units=true
…  (11 of 11 identical; 10 of the 11 have zero payment units)
=== 6 known-good rows ===
ed07d5b9-… dash=200  pu_table=200 no_payment_units=false
```

Three consequences worth knowing before you debug this again:

1. **It is not a parse bug and never was.** `ace-connect` followed the redirect
   (Playwright's default), so `parseOpportunityDashboard` was handed the
   payment-unit wizard — a page with an `<h1>` and no `<h6>label</h6><p>value</p>`
   infocards. `classifyDashboardRead` correctly called that `no_cards`; the read
   was about the wrong page. `getOpportunity` now fetches the detail page with
   `maxRedirects: 0` and reports `dashboard_read: 'setup_incomplete'`
   (ace#1637). *Enforced:* `test/mcp/connect/unit/dashboard-read-honesty.test.ts`.
2. **There is no second surface to fall back to.** `/finalize/` — the only form
   with `total_budget` — redirects to the SAME wizard, because
   `OpportunityFinalize.dispatch` bounces any opportunity with no payment units.
   Verified live: `GET …/finalize/ → 302 → …/payment_units/create`.
3. **Do NOT infer `total_budget = 0`.** `is_setup_complete` is false when ANY of
   the four is missing, and `connect_create_opportunity` sets a budget through
   the REST automation API without ever touching the form that requires payment
   units. The redirect proves the setup is unfinished; it does not prove the
   budget is null. `connect-program-setup` Step 4a therefore still counts these
   rows as unreadable — it just names them now.

The standing cost: each such row adds one `EXPECTED_OPP_BUDGET` to the Σ-unknown
target on every program sized against that org, and only finishing or deleting
the opportunity removes it. On `ai-demo-space` that is 11 rows, essentially all
of them ACE's own abandoned Phase 4 runs. `sweep-connect` deactivates orphan
opportunities but a deactivated opportunity is still listed and still unreadable.

### Deliver-unit granularity is module-level, not form-level

When `connect_create_opportunity` syncs a Deliver app from CommCareHQ, it
creates **one Connect deliver unit per Deliver app module**, not per form.
A 5-form Deliver app split across 3 modules (e.g. Stage 1: F1+F2+F3,
Stage 2: F4, Shipments: F5) lands in Connect as 3 deliver units, not 5.
Verified live 2026-05-06 against `leep-paint-collection` (see
[#106 finding 12](https://github.com/jjackson/ace/issues/106)).

Practical implications:

- `payment_unit.required_deliver_units` and `payment_unit.optional_deliver_units`
  must reason about modules-as-units. Per-form differentiation isn't
  expressible at this layer — F1's submission and F2's submission both
  count toward the same Stage-1 deliver unit.
- `verification_flags.form_field_rules.deliver_unit_id` is bound to the
  module's deliver unit. A flag like "MUAC ≤ 11.5 cm on F2" applies
  whenever ANY form in the module is submitted; you can't constrain it
  to F2 alone via `form_field_rules`. Per-form gating belongs in the
  CommCareHQ form's `<bind>` constraint logic, not in Connect's
  verification flags.
- Nova's Deliver app blueprint should map "one Connect-paid unit type"
  to "one module". If a PDD's Success Metrics distinguish between
  per-form payments (e.g. "$1 per F2 submission, $0.50 per F3
  submission"), Nova should split those into separate modules so each
  becomes its own deliver unit.

This is intentional today (mirrors how Connect models module-as-task in
its Django data model), not a limitation. Documented here so the next
maintainer doesn't try to "fix" it by attempting form-level granularity
in the verification-flags layer. If Connect ships per-form deliver units
in a future release, update this section and Nova's deliver-unit
guidance together.

### A repeated `entity_id` is PAID AGAIN — the key groups visits, it does not dedup payment

**`entity_id` decides which `CompletedWork` row a visit lands on. It does
not decide how many times that row is paid.** With the opportunity's
`duplicate` verification flag off, a second visit on an existing key is
reset to `pending`, auto-approved like any clean visit, and counted again.
ACE cannot turn that flag on: `connect_set_verification_flags` refuses
`duplicate` (ace#1013), and Connect's verification form force-sets
`duplicate = False` whenever `automatic_visit_verification` is on. So on
every ACE opportunity, **treat a repeated key as a second payment.**

Source (dimagi/commcare-connect `main` @ `3c760f279`, 2026-09-25; ace#2512):

- `form_receiver/processor.py` `process_deliver_unit`: a visit whose key
  already exists gets `status = duplicate`, but only on the NOT-over-limit
  branch. `CompletedWork.objects.get_or_create(opportunity_access, entity_id,
  payment_unit)` shares the ROW, not a single payment.
- `processor.py` `clean_form_submission`: `if opportunity_flags.duplicate:`
  flag it; **`else: user_visit.status = VisitValidationStatus.pending`**.
  Then `auto_approve_visits and status == pending and not flagged` →
  `approved` / `agree`. (`auto_approve_visits` defaults to `True`,
  `duplicate` defaults to `False`, `opportunity/models.py`.)
- `opportunity/models.py` `CompletedWork.approved_count` counts every
  approved visit per deliver unit, and `payment_accrued` is
  `approved_count * payment_unit.amount` — its own docstring says
  *"Includes duplicates"*.
- `opportunity/forms.py` `OpportunityVerificationFlagsConfigForm.save`:
  `if self.auto_verify: instance.duplicate = False`.

**What actually stops a payment on the Connect side** — nothing else does:

1. **`over_limit`** — `max_daily` on the payment unit, `max_visits` on the
   claim limit, or a claim past its end date. An `over_limit` visit is not
   approved.
2. **A verification flag.** Any flag (e.g. a `form_field_rules` row that
   `form_value_not_found`s) makes the visit `flagged`, so it is never
   auto-approved, and under `automatic_visit_verification` it is
   `rejected`. **This is how a per-entity cap is enforced:** the Deliver
   form computes a field that is `yes` only for an in-cap payable encounter
   (e.g. `payable_slot`), and Phase 4 adds a `form_field_rules` row
   requiring `yes`. A clamped index in `entity_id` is belt-and-braces for
   grouping; on its own it pays the over-cap encounter.
3. A human review rejecting the visit.

**Second consequence — non-payable records consume the caps.** The daily /
total counts filter `UserVisit` on `(opportunity_access, deliver_unit)` and
exclude only `over_limit` and `trial`. A visit that is flagged, rejected, or
merely "not payable" in the design STILL counts toward `max_daily` and
`max_visits`. So a PDD that files non-payable record kinds (committee
meetings, did-not-happen reports, over-cap encounters) on the paid
deliver unit and sizes `max_total` to the number of PAYABLE units lets the
unpaid records exhaust the cap, and later payable visits go `over_limit`.
Keep non-payable record kinds on a form with **no `deliver_unit` marker**
(the marker carries no relevance condition), or size the caps for every
record that will carry the marker. On the spark-facilitator design (~13
community + ~13 committee meetings per facilitator, `max_total` 21)
payment would have stopped around week 10.

What would falsify this: on an auto-verified ACE opportunity, two visits
with the same `entity_id`, no flags, under the caps, and
`connect_get_deliver_progress` / the `CompletedWork` showing
`approved_count` 1. Read from source; not yet observed as a live double
payment. *Enforced:* `test/skills/repeat-entity-id-payment.test.ts` fails if
skill, template or playbook prose re-asserts that a repeated key is paid
once.

### Every Connect list VIEW is paginated at 20, and the payload never says so

Connect renders its list pages through `django_tables2`, and the shared
`base_table.html` footer is the only place the pagination surfaces. A scraper
that issues one GET gets page 1 and cannot tell. This bit
`connect_list_opportunities`, whose result feeds a Sigma over `total_budget`
(dimagi-internal/ace#1590) — see `parseTablePagination` +
`test/mcp/connect/unit/list-opportunities-pagination.test.ts` for the walk and
its gate.

The contract, from upstream source (re-read it before trusting this):

| Fact | Source |
|---|---|
| `DEFAULT_PAGE_SIZE = 20`, `PAGE_SIZE_OPTIONS = [20, 30, 50, 100]` | `commcare_connect/utils/tables.py:17-18` |
| `?page_size=n` is honoured ONLY for `n` in `PAGE_SIZE_OPTIONS`; anything else silently falls back to 20 | `commcare_connect/utils/tables.py:111-116` |
| The page parameter is django-tables2 `prefixed_page_field` — per-table, not always `page` | `base_table.html`, rendered into `goToPage('<field>', n)` |
| `paginator.num_pages` is rendered as `max="<n>"` on the page input and as `of <n>` beside it | `base_table.html` |
| The footer renders ONLY when `paginator.count > DEFAULT_PAGE_SIZE`, so its absence means "20 rows or fewer", never "one page" | `base_table.html` |

The one that ruins a naive loop: **an out-of-range `page` does NOT 404.**
`django_tables2/config.py::RequestConfig.configure` runs with `silent=True`,
mapping `EmptyPage` to `paginator.page(paginator.num_pages)` — the LAST page,
HTTP 200. Walking `&page=N` until an error therefore never terminates. Stop on
the declared `num_pages`, or on a page that adds no new ids.

Not every Connect surface is a paginated table: `program_home` renders
`programs = list(programs_qs)` with no paginator
(`commcare_connect/program/views.py`), which is why `connect_list_programs`
returns a whole org in one GET.

**Still single-page as of 2026-08-23**, and liable to under-read on a large
org: `member_table` (pins `page_size=100`, no page loop), `payment_unit_table`,
`deliver_unit_table`, `workers/learn`, `workers/deliver`. Reuse
`parseTablePagination` when one of them starts mattering.

## Operator runbook

### Required env vars (all 1Password-backed in `.env.tpl`)

```
CONNECT_BASE_URL=https://connect.dimagi.com
ACE_HQ_USERNAME=op://AI-Agents/ACE - CommCareHQ/username
ACE_HQ_PASSWORD=op://AI-Agents/ACE - CommCareHQ/password
```

### Establishing a session

Two paths:

- **Automated (default):** the MCP's `PlaywrightSession.getContext()` probes
  `/accounts/login/`. If the response is 200 (anonymous), it auto-runs
  `hqOAuthLogin()` with the `.env` creds. The resulting state persists to
  `~/.ace/connect-session.json` for headless reuse.
- **Manual fallback:** run `/ace:connect-login` to open a headed Chromium
  window, sign in by hand (covers MFA / SSO edge cases the automated flow
  can't handle), and save the resulting state.

`bin/ace-doctor` checks both env-var presence and session freshness.

The REST atoms reuse the same `BrowserContext.request` and the same
session-cookie + CSRF flow as the Playwright atoms — there's no separate
token-auth path today.

### Org-admin role required

For `create_program` and other write atoms to succeed, the configured account
(`ace@dimagi-ai.com` today) must be an **Admin** in the target Connect
organization. `create_program` additionally requires that the org be a
*program-manager* org (`program_manager=True`) — the new automation API
enforces this via the `IsProgramManagerAdmin` permission. Demo/testing
happens in the configured PM org (below).

To grant admin role:
1. As an existing org admin, open `https://connect.dimagi.com/a/<org>/organization/`
2. Members tab → either change the existing member's role to `Admin` or use the
   "Add Member" form (email + role=admin)

Without admin role, ace@dimagi-ai.com's view defaults to the
network-member-side ("Apply to Program" buttons) and authoring atoms will
fail with 403.

### Which Connect orgs ACE acts in

ACE runs Connect on a program-manager / network-manager model (CLAUDE.md
§ Phases). Which orgs play those roles is a property of the **instance**, not
of ACE, so it is configuration — resolved in exactly one place,
`lib/connect-orgs.ts` (`resolveConnectOrgs(env)` → `{ pm_org, nm_org, source }`):

| Key (installed `.env`) | Role | Unset |
|---|---|---|
| `ACE_CONNECT_PM_ORG` | Program-manager org: creates programs, invites + accepts the NM org (Phase 4), sets PM-only config (verification rules), sends partner LLO invites, owns solicitations' programs. Must have Program Manager enabled. | The legacy default in `lib/connect-orgs.ts`, so an install that never set it behaves exactly as before. |
| `ACE_CONNECT_NM_ORG` | Network-manager org ACE controls. **Holds Phase 4's build/QA opportunity** (`target_organization_slug`), so every run exercises the real PM→NM flow (operator decision 2026-09-26). | `null` → Phase 4 falls back to the legacy self-managed shape (PM org holds its own opportunity; verification rules cannot be set — ace#2419). |

**Where to set them — and why not `.env.tpl`.** Put the lines in the
*installed* `.env` (`${CLAUDE_PLUGIN_DATA}/.env`). They are deliberately NOT
declared in `.env.tpl` (only documented there, commented): `bin/ace-setup
--force-env` preserves every key absent from the template in its
`# --- ACE local-only secrets ---` block, so a per-instance value survives every
re-inject and 1Password can never silently override it. Declaring them in the
template would do the opposite — the injected value would win on every setup.
MCP subprocesses read `.env` at startup, so restart Claude Code after changing
them (CLAUDE.md § MCP changes need a full Claude restart).

**How skills read it.** `/ace:doctor --preflight` emits a `connect_orgs:` block
(`status`, `pm_org`, `nm_org`, `source`); the orchestrator passes it into every
phase dispatch that acts in Connect, and skills say "the configured PM org
(`connect_orgs.pm_org`)" rather than naming a slug. A skill run outside
`/ace:run` gets the same block by running `bash bin/ace-doctor --preflight
--no-live`. The full `/ace:doctor` adds one live check: `GET
/a/<pm_org>/program/` with the ACE session (200 = the org resolves and ace@ can
read its programs; 404 = the slug does not resolve for ace@). The NM org has no
live doctor check yet — the Phase 4 invite (a 400 naming the org) is where a bad
NM slug surfaces. *Enforced:*
`test/lib/connect-orgs.test.ts`, and `test/skills/no-hardcoded-connect-org.test.ts`
fails on any org slug literal in skills/agents/commands/templates/mcp/playbook
outside its reasoned allowlist.

**An existing program's org is NOT re-derived from config.** A program an opp
already owns is reused via `opp.yaml.connect.program`; its recorded URL
(`/a/<org>/program/<id>/`) names the org it lives in, and that recorded org stays
authoritative for every call against that program. Changing
`ACE_CONNECT_PM_ORG` affects programs created from then on; it never
re-homes (and must never orphan) one that exists.

### PM→NM org-URL matrix (live, 2026-09-26)

Phase 4 in `pm-nm` mode acts on an opportunity whose program org (PM) and
holding org (NM) differ, so every opportunity-scoped atom is reachable at two
URLs. Connect's authority is `org_opportunity_access` + `is_opportunity_pm`
(`commcare_connect/program/utils.py`): the holding org AND the program org both
get ADMIN on the opportunity, but `is_opportunity_pm` — which gates PM-only
views — is `ADMIN and request.org != opportunity.organization`. The REST
automation views (`/api/opportunities/<id>/…`, `/api/programs/<id>/…`) take no
org from the URL at all and authorise an admin of either org.

**Probe objects** (throwaway, left in place, named for sweep): program
`777f9060-8f26-43bb-aad1-b8f1d7df22db` ("ACE-IT-20260926-PMNM PM→NM probe") in
the PM org `ace-pm-org`; application `68b0a689-7326-4c13-a21e-ef492db3a738`
(`ace-nm-org`, accepted); opportunity `7bfcb845-015c-416a-a200-9795c68dfc55`
(int 2297, `20260926-0000 · ACE-IT PM→NM probe`, is_test, held by `ace-nm-org`,
active); deliver unit 7084; payment unit `c4d325e3-b58f-417d-8b8c-74cc94a4cfae`
(server id 2593); one form_field_rule (`probe meeting yes`); FLW invite for the
unregistered test number `+74260009999`. Apps: spark-facilitator/20260925-1536's
released Learn `cc3aaedcfa9a47729873d4915e12d226` / Deliver
`0d877e0f7bc14382b34f4a843803ca0a` on `connect-ace-prod`.

| Atom | Transport | `/a/<pm>/…` | `/a/<nm>/…` | Evidence |
|---|---|---|---|---|
| `connect_create_program` | REST | ✅ | n/a | program above |
| `connect_send_llo_invite` (organization = nm) | REST, org-agnostic | ✅ | — | → `status: invited`, `program_application_id` returned |
| `connect_accept_program_application` | REST (`ProgramApplicationAcceptView` authorises a **program-org** admin) | ✅ | — | → `status: accepted` |
| `connect_create_opportunity` (target = nm) | REST | ✅ | — | create response `organization_slug: ace-nm-org`; DU 7084 ≠ the PM-org DU 7083 for the same app |
| `connect_get_opportunity` | HTML | ✅ | ✅ | identical fields both; `dashboard_read: setup_incomplete` pre-PU, `ok` after activation. NB the atom ECHOES the input slug as `organization_slug` — it is not the holding org |
| `connect_list_deliver_units` | HTML | ✅ | ✅ | same `server_id` 7084 |
| `connect_set_verification_flags` | HTML, **PM-only** | ✅ `form_field_rules_saved: 1` | ❌ 302 → detail (now typed `verification_page_pm_only`) | ace#2419 resolved for `pm-nm` mode |
| `connect_create_payment_unit(s)` | REST, org-agnostic | ✅ | (same endpoint) | PU 2593 on DU 7084 |
| `connect_activate_opportunity` | REST, org-agnostic | (same endpoint) | ✅ | `active: true` |
| `connect_send_flw_invite` | REST, org-agnostic | ✅ | (same endpoint) | `invited_count: 1` |
| `connect_list_flw_invites` | HTML | ✅ | ✅ | row present both |
| `connect_list_payment_units` | HTML | ✅ full row | ⚠️ row WITHOUT `payment_unit_uuid` / `amount` / `org_amount` | the NM-org table omits those columns |
| `connect_get_learn_progress` / `connect_get_deliver_progress` | HTML | ✅ | ✅ | empty worker lists both |
| `connect_list_invoices` | HTML | ✅ | ✅ | `[]` both. Upstream: `invoice_pay` / ticket-link are PM-only (`is_opportunity_pm`); invoice create/status label the actor by org |
| `connect_get_learn_passing_score` | HTML, program-scoped | ✅ 80 | ❌ 404 | the init-edit form lives under the program's org |
| `connect_list_opportunities` | HTML | ✅ lists it (`holding_organization_name: ace-nm-org`) | ✅ lists it | the two orgs render different table classes (`OpportunityList.get_table_class`); until ace#2506 the parser read only the PM one — 0 rows at the NM org, and the PM table's holding-org subtitle mislabelled `short_description` |

**Rule for ACE: act at the PM org's URL for everything in Phases 4–6.** Every
surface above serves there, including the ones that do not serve at the NM org.
The holding org matters for WHERE the opportunity lives (its canonical URL,
reviewer membership — `share-run-access` grants viewer in the holding org, which
`org_opportunity_access` gives VIEW on the opp) and for `target_organization_slug`.

**ace#573 does not cross orgs.** `ManagedOpportunityCreateSerializer` keys
`CommCareApp.objects.get_or_create(...)` on the HOLDING org, and
`DeliverUnit.get_or_create(app=deliver_app, …)` hangs off that row. The probe
reused a Deliver app whose PM-org DeliverUnit (7083) was already bound to
spark-facilitator/20260925-1536's payment unit; the NM-held opportunity got a
fresh DeliverUnit (7084) and its payment unit created without touching 7083.
Within ONE holding org the constraint still applies — each run builds fresh
apps, so it does not bite Phase 4. The same keying means the Learn
`passing_score` row is per holding org too.

### Re-running probes

When Connect changes an HTML template upstream, only the *Playwright-backed*
atoms break. Each domain has a probe script under `scripts/probe-connect-*`
that documents the live HTML contract; re-run the relevant probe to update
the fixture, then update the regex in `mcp/connect/backends/html-scrape.ts`
until its unit test passes against the new fixture. REST atoms only break
when the JSON contract on `commcare-connect` changes — much less frequent.

## Adopting future REST endpoints

When commcare-connect ships an additional REST endpoint that maps to one of
the still-Playwright-backed atoms (`update_program`, `update_opportunity`,
`set_verification_flags`, the `list_*` reads, invoices):

1. Implement the method in `mcp/connect/backends/rest.ts` (replaces a stub).
2. Flip the `capability-map.ts` entry from `PLAYWRIGHT` to `REST`.
3. Flip the dispatch line in `mcp/connect/backends/composite.ts`.
4. Delete the corresponding `playwright.ts` method + its HTML fixture test.
5. Bump VERSION; ship.

When all atoms have flipped, `auth/playwright-session.ts` can be replaced
with token auth and the entire `playwright.ts` backend deleted.

## Staging

There is no separate staging instance for Connect today. Tests against
production use a name-prefix isolation pattern (`ACE-IT-<timestamp>`) to avoid
clobbering real data, and run inside the configured PM org
(`ACE_CONNECT_PM_ORG`, § Which Connect orgs ACE acts in), which is expected to
be provisioned for this kind of dogfood.

If a real staging URL becomes available, set `CONNECT_BASE_URL` in `.env`
to point at it; no other code changes needed.
