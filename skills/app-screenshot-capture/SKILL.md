---
name: app-screenshot-capture
description: >
  Execute the per-opp QA walkthrough recipes that `qa-plan` generated against
  a local AVD and capture one PNG per recipe step into Drive. Step 2 of
  Phase 5 (qa-and-training). Consumes the qa-plan manifest as its input
  spec; produces `ACE/<opp>/screenshots/` + manifest.yaml consumed by
  the per-artifact training skills (`training-flw-guide`,
  `training-deck-outline`). Captures only **per-opp** content; common Connect
  navigation screenshots come from the standalone
  `connect-baseline-screenshots` skill (not this one).
---

# App Screenshot Capture

Run the qa-plan walkthrough recipes against a local AVD, capture PNGs at
every `takeScreenshot` step, and upload them to Drive linked to their test
case.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 5 Step 1 (qa-plan) | `ACE/<opp>/qa-plan/walkthrough-recipes/manifest.yaml` | recipe execution order |
| Phase 5 Step 1 (qa-plan) | `ACE/<opp>/qa-plan/walkthrough-recipes/{learn,deliver}/module-N.yaml` | the recipes themselves |
| Phase 5 Step 1 (qa-plan) | `ACE/<opp>/qa-plan/screenshot-manifest.yaml` | expected screenshot count + naming |
| Phase 1 | `ACE/<opp>/pdd.md` | archetype branching only |
| Phase 2 | `ACE/<opp>/deployment-summary.md` | HQ domain for `${HQ_DOMAIN}` env var |
| Phase 3 (run_state.yaml) | `connect.opportunity.id` + ACE test user invite | `${OPP_NAME}`, `${ACE_E2E_PHONE_LOCAL}`, etc. |

## Process

1. **Read upstream artifacts** from Drive, **starting with the qa-plan**. If
   the qa-plan verdict isn't `pass` (or its artifacts are missing), exit
   with a structured error pointing at Step 1. Do NOT generate recipes
   independently — the qa-plan is the source of truth for what gets
   captured.

2. **Boot AVD + ensure apps installed** via `mobile_ensure_avd_running` and
   `mobile_install_apk` (no-op if cached).

3. **Run static prerequisite recipes** (login + opp claim) — these set up
   the AVD to the post-claim state the qa-plan recipes assume:
   - `connect-login.yaml` with `${ACE_E2E_PHONE_LOCAL}`, `${ACE_E2E_PIN}`.
   - `connect-claim-opp.yaml` with `${OPP_NAME}` from run_state.yaml.

4. **Run the qa-plan walkthrough recipes**, in the order the qa-plan
   manifest specifies:
   - For each recipe under `qa-plan/walkthrough-recipes/learn/` then
     `qa-plan/walkthrough-recipes/deliver/`, call `mobile_run_recipe`.
   - Each call returns a list of captured screenshots; upload each to
     `ACE/<opp>/screenshots/<recipe-stem>/<step-name>.png` via
     `drive_upload_binary` (mime: `image/png`).
   - **CRITICAL:** after uploading each PNG, set its sharing
     permission to `anyone-with-link` (role: reader) via
     `drive.permissions.create`. Slides' `createImage` (used by
     `training-deck-build` downstream) fetches PNGs via Google's
     image-import service, which doesn't carry the SA's auth — so an
     SA-only file gets "image cannot be reached" and the deck slide
     comes out blank. Setting anyone-with-link at upload time avoids
     a class of "deck builds without errors but slides are empty"
     bugs. Verified live 2026-05-02 via
     `scripts/test-screenshot-to-slides-e2e.ts`.

5. **Cross-check against the qa-plan screenshot-manifest.** Every
   manifest entry should now have a real PNG at the expected path. Flag
   missing ones in the verdict's `auto_surfaced` (don't silently drop).

6. **Write `ACE/<opp>/screenshots/manifest.yaml`** linking each captured
   PNG back to (a) its qa-plan test-case ID, (b) its `takeScreenshot:`
   step label, (c) its Drive path. This is the input shape the
   per-artifact training skills (`training-flw-guide`,
   `training-deck-outline`) consume.

7. **Self-evaluate (LLM-as-Judge):**
   - Did every recipe complete (status: pass)?
   - Are screenshots of expected count produced (≥ 1 per `takeScreenshot` step)?
   - Are all screenshots non-zero bytes?

8. **Write verdict** to `verdicts/app-screenshot-capture.yaml`. The shape MUST conform to `lib/verdict-schema.ts` so `opp-eval` can aggregate.

   ```yaml
   skill: app-screenshot-capture
   target: <opp-name>
   ran_at: <ISO timestamp>
   capture_path: screenshots/manifest.yaml

   overall_score: 8.5             # 0.0–10.0, weighted across dimensions
   verdict: pass | warn | fail | incomplete
   # Use `verdict: incomplete` when env vars are unset, recipes have
   # unfilled REPLACE_* selectors, or the AVD never booted — the
   # rubric COULD NOT grade, not that the run was bad. NEVER use
   # `verdict: blocked` (off-schema; not in lib/verdict-schema.ts).

   dimensions:
     coverage:           { score: 9.0, weight: 0.30 }   # every Learn module + Deliver form has a recipe
     execution:          { score: 8.5, weight: 0.30 }   # every recipe status == pass
     artifact_quality:   { score: 9.0, weight: 0.20 }   # every screenshot is a valid PNG, non-zero bytes
     manifest_integrity: { score: 8.0, weight: 0.20 }   # manifest.yaml lists every screenshot actually present in Drive

   per_item:
     - ref: "connect-login.yaml"
       score: 9.0
       verdict: pass
       note: "5 screenshots, all PNG, all referenced from manifest"
     # ... one per recipe

   auto_surfaced:
     - severity: WARN
       message: "Recipe X timed out at step Y; partial screenshots captured"
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
       message: "Static Maestro recipes have unfilled REPLACE_* selectors; calibrate via `maestro studio` against ~/.ace/apks/commcare-2.62.0.apk before live runs"
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

- `ace-gdrive`: `drive_read_file`, `drive_create_file`, `drive_list_folder`.
- `ace-mobile`: `mobile_ensure_avd_running`, `mobile_install_apk`, `mobile_run_recipe`. (`generate_recipes_from_app_summary` is invoked programmatically inside the skill, not as an MCP tool.)

## Mode Behavior

- **Auto:** Run end-to-end, write artifacts, proceed.
- **Review:** Pause after generating recipes for human inspection of `mobile-recipes/`; resume on approval.

## Dry-Run Behavior

- Generate recipes and write to Drive normally.
- Skip AVD boot and `mobile_run_recipe` calls.
- Write empty manifest with `dry_run: true` flag.
- State tracks as `dry-run-success`.

## LLM-as-Judge Rubric

| Dimension | Pass criteria |
|---|---|
| Coverage | every Learn module + every Deliver form has a generated recipe |
| Execution | every recipe status: pass |
| Artifact quality | every screenshot is a valid PNG with non-zero bytes |
| Manifest integrity | manifest.yaml lists every screenshot path actually present in Drive |

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-04-28 | Initial version (mobile-emulation work) | ACE team |
| 2026-04-30 | Refactored as Phase 5 Step 2 — now consumes the `qa-plan` skill's manifest as its source of truth for what to capture, instead of generating recipes itself. Captures only **per-opp** content; common Connect navigation screenshots are sourced from `ACE/_common/connect-screenshots/<connect-version>/` produced by the standalone `connect-baseline-screenshots` skill. Switched PNG upload from text-encoded `drive_create_file` to `drive_upload_binary` (0.10.43) so screenshots upload as native PNGs. (0.10.44) | ACE team |
