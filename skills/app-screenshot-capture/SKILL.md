---
name: app-screenshot-capture
description: >
  Run app smoke recipes against a local AVD and capture per-step
  screenshots for the training deck. Per-opp content only.
disable-model-invocation: true
---

# App Screenshot Capture

Run the smoke recipes from `app-test-cases.yaml` against a local AVD,
capture PNGs at every `takeScreenshot` step, and ship a thin per-app UX
smoke judge so Phase 5 has a meaningful (but cheap) signal that the
built apps are usable end-to-end. Deep, per-journey UX grading lives in
`/ace:qa-deep` → `app-ux-eval` — this skill is intentionally shallow.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 (`pdd-to-app-journeys`) | `ACE/<opp>/runs/<run-id>/1-design/pdd-to-app-journeys.md` | persona summary for the UX judge prompt; archetype context |
| Phase 2 (`app-test-cases`) | `ACE/<opp>/runs/<run-id>/2-commcare/app-test-cases.yaml` | smoke-recipe selection (`is_smoke: true`) + recipe paths |
| Phase 1 | `ACE/<opp>/inputs/pdd.md` | persona-summary fallback if not embedded in pdd-to-app-journeys |
| Phase 2 | `ACE/<opp>/runs/<run-id>/2-commcare/app-deploy_summary.md` | HQ domain for `${HQ_DOMAIN}` env var |
| Phase 3 (run_state.yaml) | `connect.opportunity.id` + ACE test user invite | `${OPP_NAME}`, `${ACE_E2E_PHONE_LOCAL}`, etc. |

Recipes are read by path from the entries in `app-test-cases.yaml`
(`recipe_path` field). They were composed and validated by Phase 2's
`app-test-cases` skill — this skill does NOT compose or validate
recipes itself. If a smoke recipe is missing or malformed, halt and
point at `app-test-cases`.

## Outputs

- `5-qa-and-training/screenshots/<journey-id>/<step-name>.png` — per-step PNGs (anyone-with-link permission set at upload for Slides ingest)
- `5-qa-and-training/app-screenshot-capture_manifest.yaml` — fileId/alias index consumed by `training-flw-guide` and `training-deck-outline`
- `5-qa-and-training/app-screenshot-capture_verdict-shallow.yaml` — thin per-app UX smoke verdict

Per-opp content only. Common Connect navigation screenshots come from
the standalone `connect-baseline-screenshots` skill (NOT a Phase 5
dispatch).

## Process

### Step 1: Read upstream artifacts

Read `1-design/pdd-to-app-journeys.md` and
`2-commcare/app-test-cases.yaml` from Drive. If either is missing or
empty, halt with a structured error pointing at the upstream phase:

- Missing `1-design/pdd-to-app-journeys.md` → Phase 1 (`pdd-to-app-journeys`)
- Missing `2-commcare/app-test-cases.yaml` → Phase 2 (`app-test-cases`)

Do NOT generate recipes or test cases independently — Phase 5 is an
executor, not a synthesizer.

### Step 2: Input completeness pre-flight

Before booting the AVD, verify the upstream Phase 2 outputs are
**structurally complete**. Phase 2's `app-test-cases` SKILL contracts
BOTH the master yaml AND a per-journey Maestro recipe (see
`skills/app-test-cases/SKILL.md § Outputs`). Half-emitted state — the
master yaml present but recipes missing — is the canonical "upstream
incomplete output" failure mode. Catch it here before AVD wall-clock
burns.

Read `app-test-cases.yaml`. Filter `journeys[]` to entries with
`is_smoke: true`, then group by the `app:` field. Run these checks
in order. Halt at the first failure with a structured PLATFORM-tag
auto_surfaced entry naming the exact remediation command:

| Failure mode | PLATFORM message | Remediation |
|---|---|---|
| Master yaml has zero `is_smoke: true` journeys | `app-test-cases.yaml has no is_smoke:true journeys; upstream Phase 2 (app-test-cases) emitted no smoke set` | `/ace:step app-test-cases <opp>/<run-id>` |
| `app: learn` smoke count != 1 OR `app: deliver` smoke count != 1 | `app-test-cases.yaml smoke set malformed: expected exactly one is_smoke:true journey per app, got learn=N deliver=M` | `/ace:step app-test-cases <opp>/<run-id>` |
| `2-commcare/recipes/` subfolder does not exist on Drive | `app-test-cases.yaml declares is_smoke:true journeys but 2-commcare/recipes/ subfolder is missing — upstream Phase 2 produced incomplete output (master yaml without per-journey recipes)` | `/ace:step app-test-cases <opp>/<run-id>` BEFORE retrying this skill |
| One or more smoke journeys' `recipe_path` doesn't resolve to a real file | `recipe_path J<n>.yaml referenced by app-test-cases.yaml does not resolve under 2-commcare/recipes/ — upstream Phase 2 produced an incomplete output set` | `/ace:step app-test-cases <opp>/<run-id>` BEFORE retrying |

Each of these halts writes the **incomplete-mode verdict shape** (see
Step 9 below) with `verdict: incomplete` and the matching PLATFORM
auto_surfaced entry. Do not write `verdict: fail` for these — fail is
reserved for cases where the recipes ran but a smoke recipe broke.
Upstream gaps are `incomplete`, not `fail`.

The agent-level pre-flight (`agents/qa-and-training.md § Pre-flight
checklist`) catches the same class of gap before the skill is
dispatched. This skill-level check is the second line of defense for
direct `/ace:step app-screenshot-capture` invocations.

### Step 3: Boot AVD + ensure apps installed

Boot the AVD via `mobile_ensure_avd_running` and install the Connect
APK via `mobile_install_apk` (no-op if cached).

### Step 4: Run static prerequisite recipes

These set up the AVD to the post-claim state the smoke recipes assume:

- `connect-login.yaml` with `${ACE_E2E_PHONE_LOCAL}`, `${ACE_E2E_PIN}`.
- `connect-claim-opp.yaml` with `${OPP_NAME}` from run_state.yaml.

### Step 5: Run the smoke recipes

For each of the two smoke journeys (Learn first, then Deliver), call
`mobile_run_recipe` with the resolved recipe path:

- Each call returns a list of captured screenshots; upload each to
  `ACE/<opp>/runs/<run-id>/5-qa-and-training/screenshots/<journey-id>/<step-name>.png`
  via `drive_upload_binary` with `shareAnyoneWithLink: true` AND
  `mimeType: "image/png"`.
- **CRITICAL:** the `shareAnyoneWithLink: true` flag is required.
  Slides' `createImage` (used by `training-deck-build` downstream)
  fetches PNGs via Google's image-import service, which doesn't carry
  the SA's auth — so an SA-only file gets "image cannot be reached"
  and the deck slide comes out blank. Setting anyone-with-link at
  upload time avoids a class of "deck builds without errors but
  slides are empty" bugs. The flag was added to `drive_upload_binary`
  in 0.13.57 alongside the standalone `drive_set_anyone_with_link`
  atom (use the standalone atom only when retroactively sharing a
  file that was uploaded without the flag). Verified live 2026-05-02
  via `scripts/test-screenshot-to-slides-e2e.ts`.

If a smoke recipe fails (status != pass), halt — downstream phases
must not start without working smoke screenshots, and a smoke failure
means the app is broken in a basic way.

### Step 6: Write `5-qa-and-training/app-screenshot-capture_manifest.yaml`

Link each captured PNG back to (a) its journey id (`J<n>`), (b) its
`takeScreenshot:` step label, (c) its Drive path. This is the input
shape the per-artifact training skills (`training-flw-guide`,
`training-deck-outline`) consume.

### Step 7: Thin UX smoke judge

For each smoke recipe (Learn + Deliver), assemble the captured
screenshot set into a single LLM-as-Judge call:

Prompt: "These screenshots are from a smoke run of the {{app}} app.
The target FLW persona (from PDD) is: {{persona_summary}}. Looking at
these screenshots in order, would this person be able to complete the
journey without confusion? Rate 0-3 + one-line reason. 0 = a typical
persona-matching FLW would get stuck; 3 = obviously usable."

Threshold: ≥ 2/3 per app. Below → halt with verdict.

This is intentionally one LLM call per app (~2 calls total). Deep,
per-dimension UX grading is `app-ux-eval` running from `/ace:qa-deep`.

### Step 8: Self-evaluate (LLM-as-Judge)

For the structural-quality dimensions:

- Did every smoke recipe complete (status: pass)?
- Are screenshots of expected count produced (≥ 1 per `takeScreenshot` step)?
- Are all screenshots non-zero bytes?

### Step 9: Write verdicts

Write the canonical structural verdict to
`5-qa-and-training/app-screenshot-capture_verdict.yaml` AND the
shallow smoke verdict to
`5-qa-and-training/app-screenshot-capture_verdict-shallow.yaml`. Both
shapes conform to `lib/verdict-schema.ts` so `opp-eval` can aggregate.

**Structural verdict** (`5-qa-and-training/app-screenshot-capture_verdict.yaml`):

```yaml
skill: app-screenshot-capture
target: <opp-name>
ran_at: <ISO timestamp>
capture_path: 5-qa-and-training/app-screenshot-capture_manifest.yaml

overall_score: 8.5             # 0.0–10.0, weighted across dimensions
verdict: pass | warn | fail | incomplete
# Use `verdict: incomplete` when env vars are unset, recipes have
# unfilled REPLACE_* selectors, or the AVD never booted — the
# rubric COULD NOT grade, not that the run was bad. NEVER use
# `verdict: blocked` (off-schema; not in lib/verdict-schema.ts).

dimensions:
  coverage:           { score: 9.0, weight: 0.30 }   # both smoke journeys covered
  execution:          { score: 8.5, weight: 0.30 }   # every smoke recipe status == pass
  artifact_quality:   { score: 9.0, weight: 0.20 }   # every screenshot is a valid PNG, non-zero bytes
  manifest_integrity: { score: 8.0, weight: 0.20 }   # manifest.yaml lists every screenshot actually present in Drive

per_item:
  - ref: "J1.yaml"   # smoke journey id from app-test-cases.yaml
    score: 9.0
    verdict: pass
    note: "5 screenshots, all PNG, all referenced from manifest"
  # ... one per smoke journey

auto_surfaced:
  - severity: WARN
    message: "Recipe X timed out at step Y; partial screenshots captured"
```

**Shallow smoke verdict** (`5-qa-and-training/app-screenshot-capture_verdict-shallow.yaml`):

```yaml
skill: app-screenshot-capture
target: <opp-name>
mode: shallow
ran_at: <ISO timestamp>
capture_path: 5-qa-and-training/app-screenshot-capture_manifest.yaml

overall_score: 2.5             # average of per-app smoke-judge scores (0-3 scale)
verdict: pass | fail | incomplete
# pass iff every per-app smoke-judge score >= 2/3.

dimensions:
  ux_smoke:           { score: 2.5, weight: 1.00 }   # mean of per-app smoke judge

per_item:
  - ref: "learn"
    score: 3
    verdict: pass
    note: "Field labels clear, submission confirmation visible"
  - ref: "deliver"
    score: 2
    verdict: pass
    note: "Mostly clear; one screen has a developer-named field but recoverable"

auto_surfaced: []
```

**Incomplete-mode shape** (when blocked before grading):

```yaml
skill: app-screenshot-capture
target: <opp-name>
ran_at: <ISO timestamp>
capture_path: phase5-block.md

overall_score: 0          # required by schema; not meaningful when incomplete
verdict: incomplete
live_state_verified: false

dimensions:
  coverage:           { score: 0, weight: 0.30 }
  execution:          { score: 0, weight: 0.30 }
  artifact_quality:   { score: 0, weight: 0.20 }
  manifest_integrity: { score: 0, weight: 0.20 }

auto_surfaced:
  - severity: PLATFORM
    message: "ACE_E2E_PHONE family unset in .env; mobile_register_test_user cannot run"
  - severity: PLATFORM
    message: "app-test-cases.yaml missing or no is_smoke: true entries; re-run /ace:step app-test-cases <opp>"
```

## CSRF token handling (when seeding ace-web prod sessions)

If a sub-step here needs to POST to a Django-backed endpoint (the ACE
web app's `/api/ingest/upload`, an OCS / Connect write, etc.) from inside
a Playwright browser context, **never use `page.request.post()`**. The
Playwright request context has its own cookie jar that doesn't share
the page's session cookies, so Django rejects the write with HTTP 403
("CSRF cookie not set" or "CSRF token missing or incorrect"). This is
the same class of bug `mcp/connect/backends/playwright.ts` and
`mcp/ocs-server.ts` already work around in production (search those
files for `X-CSRFToken` for the canonical examples).

The two-step pattern is: **read the CSRF cookie from `document.cookie`,
then issue the fetch from inside the page** so the browser's own cookie
jar travels with the request:

```ts
// Inside the Playwright session, after a GET has warmed csrftoken_ace:
const csrf = await page.evaluate(() => {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken_ace=([^;]+)/);
  return m ? m[1] : null;
});
if (!csrf) throw new Error('csrftoken_ace not set — GET base URL first to warm it');

const response = await page.evaluate(
  async ([url, csrf, body]) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'X-CSRFToken': csrf as string, 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.text() };
  },
  [endpoint, csrf, payload],
);
```

Notes:
- Cookie name is `csrftoken_ace` on the ACE web app (`ace-web`); on the
  OCS / Connect Django backends it's plain `csrftoken`. Pick the right
  one for the host you're targeting.
- The cookie isn't set until *some* view rendered by `CsrfViewMiddleware`
  has been hit — a single `await page.goto(baseUrl)` first is enough to
  warm it. See `skills/upload-transcript/SKILL.md` § Shell reference for
  the curl-cookie-jar equivalent of the same pattern.
- The header MUST be `X-CSRFToken` (capital T-O-K-E-N), not `X-CSRF-Token`.
  Django's `CsrfViewMiddleware` only honors the former.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_upload_binary`, `drive_create_file`, `drive_list_folder`.
- `ace-mobile`: `mobile_ensure_avd_running`, `mobile_install_apk`, `mobile_run_recipe`.

## Mode Behavior

- **Auto:** Run end-to-end, write artifacts, proceed.
- **Review:** Pause after Step 2 (smoke-recipe selection) so an operator can confirm which two journeys will run; resume on approval.

## Dry-Run Behavior

- Read inputs and resolve smoke recipes normally.
- Skip AVD boot and `mobile_run_recipe` calls.
- Write empty manifest with `dry_run: true` flag.
- Skip the UX smoke judge (no screenshots to grade).
- State tracks as `dry-run-success`.

## LLM-as-Judge Rubric

| Dimension | Pass criteria |
|---|---|
| Coverage | both smoke journeys (Learn + Deliver) executed |
| Execution | every smoke recipe status: pass |
| Artifact quality | every screenshot is a valid PNG with non-zero bytes |
| Manifest integrity | manifest.yaml lists every screenshot path actually present in Drive |
| UX smoke (shallow verdict only) | per-app score ≥ 2/3 from the thin smoke judge |

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-04-28 | Initial version (mobile-emulation work) | ACE team |
| 2026-04-30 | Refactored as Phase 5 Step 2 — now consumes the `qa-plan` skill's manifest as its source of truth for what to capture, instead of generating recipes itself. Captures only **per-opp** content; common Connect navigation screenshots are sourced from `ACE/_common/connect-screenshots/<connect-version>/` produced by the standalone `connect-baseline-screenshots` skill. Switched PNG upload from text-encoded `drive_create_file` to `drive_upload_binary` (0.10.43) so screenshots upload as native PNGs. (0.10.44) | ACE team |
| 2026-05-04 | Phase 5 executor pivot — drops `qa-plan` synthesis. Now reads `expected-journeys.md` (Phase 1) and `app-test-cases.yaml` (Phase 2) as inputs, runs only the two `is_smoke: true` recipes (one per app), and adds a thin per-app UX smoke judge (~2 LLM calls). Writes a new shallow verdict at `verdicts/app-screenshot-capture-shallow.yaml`. Deep, per-journey UX grading moves to `app-ux-eval` running from `/ace:qa-deep`. Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md | ACE team |
| 2026-05-05 | **Path-scheme migration.** Inputs repointed to `1-design/pdd-to-app-journeys.md`, `2-commcare/app-test-cases.yaml`, `2-commcare/app-deploy_summary.md`, `2-commcare/recipes/`. Outputs repointed to `5-qa-and-training/screenshots/<journey-id>/<step-name>.png`, `5-qa-and-training/app-screenshot-capture_manifest.yaml`, `5-qa-and-training/app-screenshot-capture_verdict.yaml`, `5-qa-and-training/app-screenshot-capture_verdict-shallow.yaml` (per manifest). Both verdict YAML examples' `capture_path` updated. No behavior change beyond paths. | ACE team |
| 2026-05-06 | **Step 2 input-completeness pre-flight** — restructured the post-Step-1 logic into an explicit failure-mode table that distinguishes upstream Phase 2 incomplete output (master yaml without recipes) from smoke-flag malformation. Each failure halts with a named PLATFORM auto_surfaced message + the exact `/ace:step` remediation command, and writes `verdict: incomplete` (not `fail` — upstream gaps aren't smoke failures). Surfaced by leep-paint-collection run 20260506-1440 where a Phase 2 dispatch paraphrased the `app-test-cases` SKILL contract and elided the per-journey recipe outputs; `app-screenshot-capture` halted correctly but the operator-facing message conflated the failure mode with general "missing input" diagnostics. See jjackson/ace#106 finding #3 + #16. | ACE team |
| 2026-05-07 | **Step 5 anyone-with-link via `drive_upload_binary({shareAnyoneWithLink: true})`** — replaces the previous unfulfillable contract (the SKILL named `drive.permissions.create` but no MCP atom implemented it). The new flag sets `role: reader, type: anyone` atomically at upload time, eliminating the "deck builds without errors but slides are empty" failure mode. Standalone `drive_set_anyone_with_link({fileId})` atom also added for retroactive sharing. See jjackson/ace#115 finding #3. | ACE team |
