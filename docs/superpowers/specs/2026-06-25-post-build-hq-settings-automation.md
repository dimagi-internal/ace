# Post-build CommCare-HQ settings automation

**Status:** Backlog — scoped (2026-07-15 spike done; 2 items to build, gated on one live probe)
**Filed:** 2026-06-25
**Owner:** Sarvesh / ACE team
**Related:** `skills/_app-component-library.md`; `skills/app-deploy`; `skills/app-release`; `skills/app-release-qa`; `agents/commcare-setup.md` (residuals-as-first-class-state, dimagi-internal/ace#867)

## Update 2026-07-15 — spike outcome & decisions

A read-only spike + the earlier real builds resolved all three HQ-layer settings:

1. **`assessment-display-lifecycle` — WON'T-DO (dropped).** A CommCare form
   Display Condition (`form_filter`) can only test case/session state, and ACE
   Learn apps are case-less by hard rule, so there is no app-readable "completed"
   signal for it to read. The shown-once / gated / hidden-after-pass behavior is
   already delivered **Connect-side** via `assessment-gate` + native
   module-completion. Deprecated in the library and removed from the
   `pdd-to-learn-app` emit-checklist. **Out of scope for this automation.**

2. **`live-photo-capture` — build the auto-apply.** Verify side already landed on
   `main` (`app-release-qa` camera-only `[BLOCKER]` check + `residuals[]`, #867).
   Decision: **always-on for Deliver** (superset of #867's PDD-conditional verify;
   no conflict). Apply mechanism: patch `appearance="acquire"` onto each image
   `<upload>` via `commcare_patch_xform`, pre-release. **Open probe:** `patch_xform`
   takes a full replacement XForm and no current tool fetches the draft XForm
   source — the draft-read path must be resolved by a live probe (or a new atom)
   before the procedure can be authored.

3. **`grid-menu-display` — build the auto-apply.** Lives in the app doc; renders to
   `suite.xml` (so verifiable from the released CCZ). No MCP tool reaches it.
   **Open probe:** whether HQ exposes a clean `edit_module_attr`-style POST, else
   Playwright against App Settings → Advanced.

**Net:** two items to automate (photos, grid), both blocked on a live HQ probe
before a reliable procedure can be written; one item formally dropped. The
automation slots as a step between `app-deploy` and `app-release` and should
resolve the matching `commcare-setup.residuals[]` entries so #867's checks pass
without a manual flip. The per-setting mechanics below are retained as the spike's
working notes.

## Why this exists

On 2026-06-25 we added seven "standing app-build instruction" components to the
app component library (per-app guidance meant to apply to every Nova build) and
wired them into the `pdd-to-learn-app` / `pdd-to-deliver-app` emit-checklists.
A real Deliver build was run to test whether Nova's autobuild architect actually
*applies* them. It split cleanly:

- Instructions that map to a **Nova blueprint primitive** were applied and are
  readable via Nova's API.
- Instructions that map to a **CommCare-HQ App/Form Settings flag** were **not**
  applied — Nova's blueprint has no field to hold them and no tool to set them,
  so the brief instruction degraded to (at best) advisory hint text.

This backlog item covers building the post-build mechanism for the second group.

## Evidence (test build: `malaria-rdt/20260611-1732`, nova_app_id `E5m6kKzFvjNIvPi7Pt7P`)

| Component | Maps to | Result |
|---|---|---|
| `deliver-app-naming` | Nova app name | ✅ applied & readable (`get_app`) |
| `no-section-module-language` | Nova field/label text | ✅ applied & readable (`get_form`) |
| `live-photo-capture` (`acquire` appearance) | HQ form-designer Appearance Attribute | ❌ not applied — `get_field` has no appearance key; Nova emitted only hint text |
| `grid-menu-display` | HQ App Settings → Advanced → Menu Display | ❌ not applied — `get_app`/`get_module` have no menu-display key (confirmed on both Deliver and Learn builds) |
| `assessment-display-lifecycle` (form Display Conditions) | HQ form Display Condition | ❌ confirmed (Learn build `dMtqjjKy8mGKTlkZgREH`): trigger fired (app has pre+post) but the form object has no display-condition key. **See realizability caveat in scope item 3.** |
| `end-of-form-previous` (`post_submit`) | Nova `update_form.post_submit` | ✅ confirmed applied & readable (Learn build): `post_submit:"previous"` on all 10 forms. Enforceable from the blueprint — **NOT part of this backlog**. |

## Scope — the three HQ-layer settings to automate

1. **`grid-menu-display`** — set Modules Menu Display + Forms Menu Display to "Grid" (app-level Advanced setting).
2. **`live-photo-capture`** — set Appearance Attribute = `acquire` on every image/photo question.
3. **`assessment-display-lifecycle`** — set the Display Condition on the pre/post assessment forms (shown-once / gated-on-pre / hidden-after-pass).
   **Realizability caveat (raised by the 2026-06-25 Learn build):** Learn apps are
   case-less by design (`assessment-gate` forbids case blocks; completion is tracked
   Connect-side). A CommCare form Display Condition needs in-app state to evaluate —
   and a case-less Learn app has none. So "shown only once" / "hidden after pass"
   may **not be expressible as a pure HQ Display Condition at all**, even post-build.
   Before building this, decide the mechanism: (i) Connect-side module-completion
   gating (how `assessment-gate` already works — likely the real answer), vs
   (ii) introducing some readable in-app state. This sub-item may resolve to "won't
   do as a Display Condition" rather than "automate it." Owner decision pending
   (user previously preferred Display Conditions specifically; this caveat reopens that).

## Candidate mechanisms (to investigate)

A new post-build step that runs **after `app-deploy` (HQ upload) and before
`app-release`**, applying these via one of:

- **HQ API** — if CommCare HQ exposes app-settings / form-settings endpoints that
  set menu display, appearance attributes, and form display conditions. (Preferred
  if it exists — deterministic, headless. Needs investigation.)
- **XForm / suite patch** — `commcare_patch_xform` (already used elsewhere) could
  set the `appearance` bind attribute and form display conditions at the XForm/suite
  layer on the uploaded app. Menu display is an app-profile/suite setting, possibly
  patchable the same way.
- **HQ UI automation** — Playwright against the App Manager UI (last resort;
  brittle, but matches how a human does it today).

## Eval-enforcement implications

The eval dimensions referenced by these components (`menu_display`,
`Capture fitness` appearance check, `assessment_gating` display-condition check)
**cannot read the settings off the Nova blueprint** — `pdd-to-*-app-eval` reads
Nova, where these fields don't exist. Enforcement must instead read the **released
CCZ / suite.xml / XForm** (which `app-release-qa` already downloads and parses —
a natural hook) or the HQ API. Until this backlog item ships, those eval
dimensions should be marked provisional / not-yet-enforceable rather than
"hard-fail", to avoid claiming enforcement we don't have.

## Related findings from the same test (not in scope here, but logged)

- **WAF 403 on every `validate`-object write** this session — Nova could not apply
  hard `validate` constraints, so the existing `data-quality-constraints` component
  silently degraded to soft `required`/`relevant` gating. Environment/gateway issue,
  not a brief issue, but it means a real run's hard data-quality gates may be
  missing. Worth a separate investigation.
- **App-level `connect_type:"deliver"` marker not set by the architect** (no exposed
  setter) — the known `connect_type:""` false-positive trap; `pdd-to-deliver-app`
  Step 4e's L0 heal addresses it in a full run.

## Acceptance criteria (when picked up)

- A post-build step applies grid menu display, `acquire` appearance, and assessment
  Display Conditions to the uploaded HQ app, idempotently.
- The matching eval dimensions read the released artifact (CCZ/suite/HQ API) and
  hard-fail a build missing any of the three.
- The three components in `_app-component-library.md` drop their "brief-only /
  pending" status note once enforcement is real.
- Verified on one Learn and one Deliver opp end to end.
