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
smoke judge so Phase 3 has a meaningful (but cheap) signal that the
built apps are usable end-to-end. Deep, per-journey UX grading lives in
`/ace:qa-deep` → `app-ux-eval` — this skill is intentionally shallow.

**Phase moved 2026-05-22.** This skill was originally a Phase 6
(`qa-and-training`) producer; it now lives at the end of Phase 3
(`commcare-setup` § Step 2.9). The move puts recipe-quality failures
and AVD/Maestro infrastructure failures at the source, where the
operator has fresh context on Nova blueprints + released CCZ
build_ids. Phase 6 reads the screenshots this skill produces but no
longer touches the AVD or runs Maestro itself. References to "Phase
6" below that talk about live failure modes (e.g. recipe halts,
AVD wedging) should be read as "Phase 3 § Step 2.9" — the SKILL prose
has not been globally swept for the rename because most of the
references document historical incidents that are still useful as
diagnostic context. The phase ordinal in the artifact-manifest, the
agent procedure docs, and the `phase:` tag on output paths are
authoritative.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 (`pdd-to-app-journeys`) | `ACE/<opp>/runs/<run-id>/2-scenarios/pdd-to-app-journeys.md` | persona summary for the UX judge prompt; archetype context |
| Phase 3 (`app-test-cases`) | `ACE/<opp>/runs/<run-id>/3-commcare/app-test-cases.yaml` | smoke-recipe selection (`is_smoke: true`) + recipe paths |
| Phase 1 | `ACE/<opp>/inputs/pdd.md` | persona-summary fallback if not embedded in pdd-to-app-journeys |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/app-deploy_summary.md` | HQ domain for `${HQ_DOMAIN}` env var |
| Phase 4 (run_state.yaml) | `phases.connect-setup.products.connect.opportunity.{id, name}` + ACE test user invite | `${OPP_NAME}` (verbatim from `opportunity.name`), `${ACE_E2E_PHONE_LOCAL}`, etc. |

Recipes are read by path from the entries in `app-test-cases.yaml`
(`recipe_path` field). They were composed and validated by Phase 3's
`app-test-cases` skill — this skill does NOT compose or validate
recipes itself. If a smoke recipe is missing or malformed, halt and
point at `app-test-cases`.

## Products

- `3-commcare/screenshots/<journey-id>/<step-name>.png` — per-step PNGs (anyone-with-link permission set at upload for Slides ingest)
- `3-commcare/app-screenshot-capture_manifest.yaml` — fileId/alias index consumed by `training-flw-guide` and `training-deck-outline`
- `3-commcare/app-screenshot-capture_verdict-shallow.yaml` — thin per-app UX smoke verdict

Per-opp content only. Common Connect navigation screenshots come from
the standalone `connect-baseline-screenshots` skill (NOT a Phase 6
dispatch).

## Process

### Step 1: Read upstream artifacts

Read `2-scenarios/pdd-to-app-journeys.md` and
`3-commcare/app-test-cases.yaml` from Drive. If either is missing or
empty, halt with a structured error pointing at the upstream phase:

- Missing `2-scenarios/pdd-to-app-journeys.md` → Phase 1 (`pdd-to-app-journeys`)
- Missing `3-commcare/app-test-cases.yaml` → Phase 3 (`app-test-cases`)

Do NOT generate recipes or test cases independently — Phase 6 is an
executor, not a synthesizer.

### Step 2: Input completeness pre-flight

Before booting the AVD, verify the upstream Phase 3 outputs are
**structurally complete**. Phase 3's `app-test-cases` SKILL contracts
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
| Master yaml has zero `is_smoke: true` journeys | `app-test-cases.yaml has no is_smoke:true journeys; upstream Phase 3 (app-test-cases) emitted no smoke set` | `/ace:step app-test-cases <opp>/<run-id>` |
| `app: learn` smoke count != 1 OR `app: deliver` smoke count != 1 | `app-test-cases.yaml smoke set malformed: expected exactly one is_smoke:true journey per app, got learn=N deliver=M` | `/ace:step app-test-cases <opp>/<run-id>` |
| `3-commcare/recipes/` subfolder does not exist on Drive | `app-test-cases.yaml declares is_smoke:true journeys but 3-commcare/recipes/ subfolder is missing — upstream Phase 3 produced incomplete output (master yaml without per-journey recipes)` | `/ace:step app-test-cases <opp>/<run-id>` BEFORE retrying this skill |
| One or more smoke journeys' `recipe_path` doesn't resolve to a real file | `recipe_path J<n>.yaml referenced by app-test-cases.yaml does not resolve under 3-commcare/recipes/ — upstream Phase 3 produced an incomplete output set` | `/ace:step app-test-cases <opp>/<run-id>` BEFORE retrying |

Each of these halts writes the **incomplete-mode verdict shape** (see
Step 9 below) with `verdict: incomplete` and the matching PLATFORM
auto_surfaced entry. Do not write `verdict: fail` for these — fail is
reserved for cases where the recipes ran but a smoke recipe broke.
Upstream gaps are `incomplete`, not `fail`.

**This pre-flight is not optional, even when journeys + recipes are
on disk.** The count check is the load-bearing gate, not the recipe-
presence check. Caught in vivo on malaria-itn-app run 20260517-1829:
Phase 3 emitted `smoke_journeys_per_app: {learn: 0, deliver: 1}` (a
known-incomplete state) and Phase 6 ran the Deliver recipe anyway —
producing a recipe-vs-app-state mismatch (post-claim handoff landed in
Learn, not Deliver, because Connect gates Deliver behind Learn-
assessment completion; see
`docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md`).
The agent SHOULD have halted at row 2 of the failure-mode table the
moment it read `learn=0`. If the agent finds itself rationalizing past
this check ("the recipe is on disk, the AVD is healthy, I'll just run
the Deliver smoke and skip the Learn one") — that's the exact anti-
pattern this table prevents. Halt instead.

The agent-level pre-flight (`agents/qa-and-training.md § Pre-flight
checklist`) catches the same class of gap before the skill is
dispatched. This skill-level check is the second line of defense for
direct `/ace:step app-screenshot-capture` invocations.

### Step 2.5: Trust the upstream restore (no local probe)

Recipes assume the AVD is at the Connect "New Opportunities" home —
the app is configured, the test user is signed in to PersonalID, the
opp tile is reachable. This is a **precondition** of running the
smoke recipes, not a state we adapt to. Per the **"phase preconditions
are restored, not adapted"** pattern (see `CLAUDE.md § Phase
preconditions`), the restore happens in `mobile_ensure_avd_running`,
unconditionally:

- **Local backend (since 0.13.203):** `loadSnapshot('registered-test-user')`
  every Phase 6 dispatch. ~3s, deterministic. If the snapshot doesn't
  exist (fresh machine, deleted, etc.), tier-2 auto-bootstrap fires:
  install CommCare APK if missing → `registerTestUser` → `saveSnapshot`.
  ~3-5 min on fresh-machine first dispatch; ~3s thereafter via the
  freshly-saved snapshot. Phase 4's `connect-opp-setup` already
  invited `${ACE_E2E_PHONE}` to the run's opp, so the CONNECT-ID-3F
  server-side invite-check precondition is satisfied automatically.
  `/ace:mobile-bootstrap` is no longer required as an operator
  pre-step inside `/ace:run` — useful only for ad-hoc workstation
  setup outside the lifecycle.
- **Cloud backend:** each `/api/mobile/ensure-running` cold-boots the
  AVD and runs the registration recipes against it (see
  `backends/cloud.ts` header). Same precondition contract, different
  mechanism — and no explicit snapshot-load is needed because the AMI
  ships the registration recipes built-in.

After `mobile_ensure_avd_running` returns, `AvdInfo.heal.deviceUserState`
carries the outcome: `{ classified_as, attempted, healed_via,
verified_as, ui_dump_signal }`. Local always shows `attempted: true,
healed_via: 'snapshot-load'`. Cloud shows `attempted: false` (cold-boot
already handled it).

**Recovery escalation.** If `mobile_ensure_avd_running` threw
`DeviceUserStateError`, two recoverable error codes:

- `snapshot-load-failed` — the snapshot doesn't exist (fresh machine,
  snapshot was deleted) OR the emulator console couldn't load it. The
  remediation is `/ace:mobile-bootstrap` — it'll register the test
  user, configure the app, and save a fresh snapshot.
- `needs-app-config` / `needs-personal-id` / `commcare-not-installed`
  (as the `verify:` segment in the error attempts) — the snapshot
  loaded but post-restore probe still showed a wiped state. This is
  snapshot corruption or post-snapshot APK upgrade drift. Same
  remediation: `/ace:mobile-bootstrap` re-snapshots.

**This step is now ~zero code in the skill.** The state-classifier
lives in `mcp/mobile/client.ts` (post-restore verification only); no
duplicate probe at the skill level. Earlier versions of this skill
documented a local probe table here — that was the "tolerate any
starting state" anti-pattern. Removed 0.13.202.

The recipe-error → failure-mode table further down (Step 5) is the
second-line classifier for things the upstream restore couldn't
catch (e.g. CCZ content issues, Maestro recipe drift, OPP_NAME
collisions in long invite lists). It stays.

### Step 2.6: Recipe-sanity pre-flight (static probe)

Before booting the AVD, run a static comparison between recipe
expectations and live app + Connect state. This catches the failure
classes the turmeric/20260515-0536 cycle surfaced one-at-a-time over
8 attempts (~80 min of wall-clock burn) — module-name == form-name,
expected-module-not-in-app, opp-name-mismatch, tile-name-collision.

Helper: `mcp/mobile/recipe-sanity-probe.ts` (pure function — same
inputs always produce the same verdict; no MCP calls inside the
probe itself).

Inputs the caller assembles:
- Smoke recipe text(s) — read from `3-commcare/recipes/J*.yaml` on
  Drive
- Nova app structures — one `nova_get_app({app_id})` per app in
  `app-test-cases.yaml` (typically learn + deliver)
- Live Connect opp — `connect_get_opportunity({org_slug,
  opportunity_id})` from `run_state.yaml.phases.connect-setup.products`
- (optional) OPP_NAME the recipe was authored against — read from the
  recipe's `env.OPP_NAME` or from `app-test-cases.yaml`
- (optional) Visible tile names — `mobile_capture_ui_dump` after a
  quick login. Skipping this skips only the `tile-name-collision`
  check; everything else still runs.

Failure classes the probe surfaces (each with a canonical
remediation):

| Class | Remediation |
|---|---|
| `module-name-equals-form-name` | Verify plugin >= 0.13.255 (handled by learn-tap-module). If older, re-author via `/ace:step app-test-cases`. |
| `expected-module-not-in-app` | Recipe needs re-author via `/ace:step app-test-cases` — live app structure has drifted. |
| `expected-form-not-in-module` | Same as above — module/form structure has drifted. |
| `opp-name-mismatch` | Pass `OPP_NAME` verbatim from `run_state.yaml.phases.connect-setup.products.connect.opportunity.name` (NOT slug-reassembled). Fallback only if missing: `connect_get_opportunity({org_slug, opportunity_id}).name`. |
| `tile-name-collision` | Clean up prior-run invites OR use Resume-branch (exact-match claim). |

On any failure, halt with the **incomplete-mode verdict shape** (see
Step 9), `verdict: incomplete`, and a per-class
PLATFORM auto_surfaced entry naming the remediation. Do NOT proceed
to Step 3 — every one of these classes is structurally guaranteed to
produce a recipe-level failure 5-10 min later. Fail fast at the
boundary.

### Step 3: Boot AVD + ensure apps installed

Boot the AVD via `mobile_ensure_avd_running` and install the Connect
APK via `mobile_install_apk` (no-op if cached).

`mobile_ensure_avd_running` is the single source of truth for "AVD is
ready for Maestro" — since 0.13.165 it also probes the on-device
Maestro driver's gRPC channel and auto-heals (force-stop + uninstall +
reinstall of `dev.mobile.maestro`) if the driver isn't responding.
Same code path is what `mobile-bootstrap` calls and what `ace-doctor`
probes (read-only via `mobile_probe_maestro_driver`). One healing
implementation, three callers.

If `mobile_ensure_avd_running` throws `MaestroDriverError` (the heal
exhausted), halt with `verdict: fail` + `severity: BLOCKER` naming
`/ace:mobile-bootstrap` as the operator recovery. **Do NOT downgrade
to `verdict: incomplete`** — Maestro driver health is solvable on the
workstation, not via a placeholder ship. Pre-0.13.165 the skill wrote
`incomplete` here and Phase 6 shipped without screenshots; that escape
valve hid real capability gaps behind a yellow verdict.

### Step 4: Run static prerequisite recipes

These set up the AVD to the post-claim state the smoke recipes assume:

- `connect-login.yaml` with `${ACE_E2E_PHONE_LOCAL}`, `${ACE_E2E_PIN}`.
- `connect-claim-opp.yaml` with `${OPP_NAME}` read verbatim from
  `run_state.yaml.phases.connect-setup.products.connect.opportunity.name`.

**OPP_NAME source — authoritative read from `run_state.yaml`.** Phase 4
(`connect-opp-setup`) writes the exact tile name Connect renders into
`phases.connect-setup.products.connect.opportunity.name` at the moment
the opportunity is created. Pass that string **verbatim** as the
`OPP_NAME` envVar. Do NOT reassemble from slug pieces — the live tile
text is `"<display_name> — <slug> (run <date>)"` with an em-dash
(U+2014), not `"<org_slug> - <slug> (run <date>)"` with an ASCII hyphen,
and any slug-based composition will silently mis-match the tile.

**Fallback (legacy runs only).** If `opportunity.name` is missing from
`run_state.yaml` (rare — only pre-0.13.x runs predating the name-field
write), fall back to `connect_get_opportunity({org_slug,
opportunity_id}).name` and log `[WARN] OPP_NAME read from connect_get_opportunity
fallback — current run_state.yaml lacks phases.connect-setup.products.connect.opportunity.name`.
Never compose from slug pieces.

This insulates Phase 6 from Connect's name-formatting changes — we
read what Phase 4 wrote when it created the opp, not what the Connect
UI happens to render today. Caught live on malaria-itn-fgd run
20260515-1645 Phase 6 attempt 9, where slug-based composition produced
`"ai-demo-space - malaria-itn-fgd (run 20260515-1645)"` but the live
tile text was `"Malaria ITN FGD — malaria-itn-fgd (run 20260515-1645)"`;
the subagent self-corrected mid-dispatch by calling
`connect_get_opportunity`, wasting a recipe cycle.

**OPP_NAME uniqueness assumption (durable note).** Because every
`/ace:run` Phase 3 invites the same ACE test user (`${ACE_E2E_PHONE}`)
to a fresh Connect opp, the test user's in-app invite list grows
unboundedly across runs. Every prior opp the test user was ever invited
to is still listed, and there is no per-run cleanup atom yet (TBD). The
`${OPP_NAME}` recipe matcher assumes:

1. The opp name is **unique enough** to disambiguate this run's opp
   from all prior invites. `connect-opp-setup` writes a name like
   `"<display_name> — <slug> (run <YYYYMMDD-HHMM>)"` (e.g.
   `"Malaria ITN FGD — malaria-itn-fgd (run 20260515-1645)"`) — the
   run-id suffix gives it lexical uniqueness, the em-dash + slug
   disambiguates within an opp's runs, and the display-name prefix
   matches what the LLO will see when the opportunity is solicited.
2. **The newest invite sits near the top of the list.** Today this is
   implicitly the case (Connect orders by invited_at descending), so
   `tapOn:text` on the unique full name lands the right tile.

These assumptions break as the test user accumulates invites:
- A `tapOn:text` matcher that uses just the title prefix (without the
  run-id suffix) will collide across runs.
- Even with a unique full name, on extremely long invite lists Maestro
  may need to scroll to find it; recipes today don't.

**Future-proofing options** (none implemented yet):
- Use `${OPP_UUID}` or `${OPP_LABS_INT_ID}` as the identifier — but
  neither surfaces in the mobile UI today (Connect's tile shows the
  display name).
- Have `connect-opp-setup` emit a per-run unique short tag (e.g.
  `RUN20260513-0616`) and append it to the opp name so the recipe
  matcher is unambiguous regardless of invite-list length.
- Add an explicit `scrollUntilVisible` wrapper to the claim recipe so
  long invite lists don't fall off the visible region.
- Add a periodic test-user invite-list-cleanup atom (Connect doesn't
  expose this in the public API today; would need a `connect_*`
  Playwright atom).

Track as a class-level concern; revisit when the test user has
accumulated enough invites to break the implicit ordering or when a
recipe surfaces a false-positive `tapOn:text` hit on the wrong tile.

### Step 5: Run the smoke recipes

For each of the two smoke journeys (Learn first, then Deliver), call
`mobile_run_recipe` with the resolved recipe path:

- Each call returns a list of captured screenshots; upload each to
  `ACE/<opp>/runs/<run-id>/3-commcare/screenshots/<journey-id>/<step-name>.png`
  via `drive_upload_binary` with `shareAnyoneWithLink: true` AND
  `mimeType: "image/png"`.
- **CRITICAL:** the `shareAnyoneWithLink: true` flag is required.
  Slides' `createImage` (used by `training-deck-build` downstream)
  fetches PNGs via Google's image-import service, which doesn't carry
  the SA's auth — so an SA-only file gets "image cannot be reached"
  and the deck slide comes out blank. Setting anyone-with-link at
  upload time avoids a class of "deck builds without errors but
  slides are empty" bugs. The standalone `drive_set_anyone_with_link`
  atom exists for retroactively sharing a file that was uploaded
  without the flag. Verified live 2026-05-02 via
  `scripts/test-screenshot-to-slides-e2e.ts`.
- **NEW (0.13.229):** each `ScreenshotEntry` may now carry a sibling
  `uiDumpPath` pointing at a `<step-name>.xml` file containing the
  Android `uiautomator dump` output captured at the same moment as the
  PNG. When present, upload it to
  `ACE/<opp>/runs/<run-id>/3-commcare/screenshots/<journey-id>/<step-name>.xml`
  via `drive_upload_binary` with `mimeType: "application/xml"`
  (no `shareAnyoneWithLink` needed — XMLs aren't consumed by Slides).
  The dumps are produced automatically by `MaestroBackend.runRecipeWithDumps`
  whenever the caller passes a `serial` to `mobile_run_recipe` (the
  default path for local-AVD invocations since 0.13.229). Absence is
  fine — pre-0.13.229 recipes have no XMLs and the upload step
  becomes a no-op. The dumps unlock atlas auto-maintenance (every
  Phase 6 dispatch leaves a complete record of resource-IDs at every
  surface the recipe visited) and selector drift detection (diff
  current dump vs prior passing run's dump). See
  `docs/learnings/2026-05-14-atlas-side-channel-capture.md` for the
  underlying problem and `mcp/mobile/recipe-splitter.ts` for the
  splitting logic.

If a smoke recipe fails (status != pass), halt — downstream phases
must not start without working smoke screenshots, and a smoke failure
means the app is broken in a basic way.

**Before consulting this table, READ the failure screenshot.** Maestro
writes one to its debug bundle on every recipe halt — path appears in
the `maestro.log` `Failed:` line as `screenshot-❌-<timestamp>-(<recipe>.yaml).png`,
under `~/.maestro/tests/<timestamp>/`. The image often names the
failure mode literally — *"Logged out of PersonalID"*, *"Enter Code"*,
*"Failed to start learning"*, *"App not found"* — making package /
process / driver probing redundant. **Image-read first, infer second.**
Skipping this step produced an inverted-conclusion bug live in
2026-05-13 (turmeric run 20260513-0616): the agent saw `org.commcare.dalvik`
absent of a `connect`-named sibling package and concluded "Connect not
installed" — when the failure screenshot showed *"Logged out of
PersonalID — Lost PersonalID configuration with server, please recover
your PersonalID account and retry"* with a `Reconfigure →` CTA in the
nav drawer. Reading the screenshot would have produced the right
answer in one step.

**Recognized failure modes** (write a `[BLOCKER]` to the gate brief
naming the specific failure + remediation rather than a generic
"smoke recipe failed" message):

| Recipe error contains | Failure mode + root cause | Remediation |
|---|---|---|
| `Failed to start learning` | Connect's HQ→Connect sync registered no learn modules for the opp. Pre-2026-05-22 ACE attributed this to `<module xmlns="…connect…">` / `<assessment xmlns="…connect…">` wrappers in the released Learn CCZ; voidcraft-labs/nova-plugin#7 closure (2026-05-22) clarified the wrappers are *required* — Connect uses them to register. The real historical root cause was Connect block ids > 50 chars, fixed at the Nova emitter by commcare-nova PR #21. Verified live 2026-05-22 (leep-paint-collection run 20260522-1241): unpatched wrappered Learn CCZ launches cleanly when ids are in-bounds. | Verify the released Learn CCZ's `projected_connect_state.max_slug_length ≤ 50` and `oversized_slugs: empty` (returned by `commcare_download_ccz` since 0.10.56). If a slug overflows, re-author the architect brief with shorter `connect.learn_module.id` / `connect.assessment.id` values (see `skills/pdd-to-learn-app/SKILL.md § REQUIRED — Set id explicitly`) and re-deploy. Diagnostic probe: `npx tsx scripts/probe-connect-learn-handoff.ts <opp_uuid>` + adb logcat. |
| `deviceInfo … UNAVAILABLE` / `MaestroDriverError` | Maestro driver app on the AVD is installed but its gRPC server isn't responding. Symptom of a wedged driver process or a stale install whose runtime state diverged from the CLI's expectations. Reproduced live 2026-05-11 against leep run 20260511-0507 Phase 6 (port 7001 refusing connections, every recipe stalling on `deviceInfo`). | Since 0.13.165 `mobile_ensure_avd_running` auto-heals (force-stop + uninstall both halves of `dev.mobile.maestro`, then re-probe to trigger the CLI's auto-reinstall). If this error still surfaces, the heal exhausted — run `/ace:mobile-bootstrap` to re-baseline the AVD + driver, then `/ace:step app-screenshot-capture <opp>/<run-id>`. Logcat probe: `adb -s <serial> logcat | grep -i maestro`. |
| `extendedWaitUntil` timeout on `connect_fragment_jobs_list` | Claim flow didn't reach jobs list. LLO program-application not ACCEPTED, or Connect session expired on the AVD. | Re-run `connect-login.yaml` and verify `connect_get_opportunity` returns the expected opp. |
| `assertVisible(text: ${OPP_NAME})` failure AND focused activity is `CommCareSetupActivity` AND/OR failure screenshot shows "Logged out of PersonalID" / "Lost PersonalID configuration" / "Reconfigure" / "Enter Code" / "Welcome to CommCare" | **AVD's per-user state was wiped** — no `ApplicationDocument` configured (CCHQ app never pulled OR app db was wiped) and/or PersonalID account de-registered from the device. Important: `org.commcare.dalvik` IS the Connect-enabled CommCare client (no separate Connect package); presence of `org.commcare.dalvik` in `pm list packages` does **NOT** imply a usable Connect home. Should have been caught by Step 2.5; if it surfaces here, Step 2.5's probe missed a signal worth adding. Live in 2026-05-13 (turmeric run 20260513-0616) with both states stacked: setup activity foregrounded + PersonalID drawer banner. | `/ace:mobile-bootstrap` — re-installs APK if needed, registers the ACE test user (`${ACE_E2E_PHONE}`) via the Connect registration API, pulls the CCHQ app for this run's HQ ids, saves a clean snapshot. After bootstrap returns clean: `/ace:step app-screenshot-capture <opp>/<run-id>`. If this state recurs after a successful bootstrap, the issue is state-loss between sessions (snapshot revert, AVD cold-boot, server-side PersonalID de-registration); file a class-level issue on `mobile_ensure_avd_running`'s state-persistence contract rather than re-bootstrapping. |
| `assertVisible(text: ${OPP_NAME})` failure AND failure screenshot shows the Connect "New Opportunities" / opp list home (the user IS logged in, app IS configured, just no matching tile) | Right opp card not on screen for the OPP_NAME being matched. Wrong `OPP_NAME` env var (typically slug-reassembled instead of read verbatim from `run_state.yaml`), OR opp not yet claimed by the test user, OR `${OPP_NAME}` collides ambiguously with another invite further up the test user's accumulated invite list (see Step 4 "OPP_NAME uniqueness assumption"). | Confirm `OPP_NAME` was read verbatim from `run_state.yaml.phases.connect-setup.products.connect.opportunity.name` (NOT composed from slug pieces — see Step 4 "OPP_NAME source" and [#115 finding 4](https://github.com/jjackson/ace/issues/115)). If the field is present and still mismatches the tile, scroll the invite list or use the `connect_get_opportunity` fallback. |

### Step 6: Write `3-commcare/app-screenshot-capture_manifest.yaml`

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
`3-commcare/app-screenshot-capture_verdict.yaml` AND the
shallow smoke verdict to
`3-commcare/app-screenshot-capture_verdict-shallow.yaml`. Both
shapes conform to `lib/verdict-schema.ts` so `opp-eval` can aggregate.

**Structural verdict** (`3-commcare/app-screenshot-capture_verdict.yaml`):

```yaml
skill: app-screenshot-capture
target: <opp-name>
ran_at: <ISO timestamp>
capture_path: 3-commcare/app-screenshot-capture_manifest.yaml

overall_score: 8.5             # 0.0–10.0, weighted across dimensions
verdict: pass | warn | fail | incomplete
# `incomplete` is reserved for *upstream-incomplete* state the skill
# itself cannot remediate: app-test-cases.yaml missing or malformed,
# `3-commcare/recipes/J*.yaml` files absent, recipes carrying
# unfilled REPLACE_* selectors. That's "the rubric COULD NOT grade
# because Phase 3 didn't ship its full output set," not "the AVD is
# sick."
#
# AVD / Maestro driver health is **not** incomplete-state — it's
# `verdict: fail` with severity:BLOCKER. Pre-0.13.165 a hung Maestro
# driver wrote `incomplete` and the phase shipped placeholders; that
# escape valve let real Phase 6 capability problems hide behind a
# benign-looking yellow verdict run after run. Since 0.13.165
# `mobile_ensure_avd_running` includes an auto-heal (force-stop +
# uninstall + reinstall of `dev.mobile.maestro`), so a healthy
# workstation almost never needs to surface AVD failure to this
# rubric. When the heal exhausts, we want the BLOCKER, not the soft
# fail — the operator runs `/ace:mobile-bootstrap` and the run
# retries with screenshots. NEVER use `verdict: blocked`
# (off-schema; not in lib/verdict-schema.ts).

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

**Shallow smoke verdict** (`3-commcare/app-screenshot-capture_verdict-shallow.yaml`):

```yaml
skill: app-screenshot-capture
target: <opp-name>
mode: shallow
ran_at: <ISO timestamp>
capture_path: 3-commcare/app-screenshot-capture_manifest.yaml

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
| 2026-05-05 | **Path-scheme migration.** Inputs repointed to `2-scenarios/pdd-to-app-journeys.md`, `3-commcare/app-test-cases.yaml`, `3-commcare/app-deploy_summary.md`, `3-commcare/recipes/`. Outputs repointed to `3-commcare/screenshots/<journey-id>/<step-name>.png`, `3-commcare/app-screenshot-capture_manifest.yaml`, `3-commcare/app-screenshot-capture_verdict.yaml`, `3-commcare/app-screenshot-capture_verdict-shallow.yaml` (per manifest). Both verdict YAML examples' `capture_path` updated. No behavior change beyond paths. | ACE team |
| 2026-05-06 | **Step 2 input-completeness pre-flight** — restructured the post-Step-1 logic into an explicit failure-mode table that distinguishes upstream Phase 3 incomplete output (master yaml without recipes) from smoke-flag malformation. Each failure halts with a named PLATFORM auto_surfaced message + the exact `/ace:step` remediation command, and writes `verdict: incomplete` (not `fail` — upstream gaps aren't smoke failures). Surfaced by leep-paint-collection run 20260506-1440 where a Phase 3 dispatch paraphrased the `app-test-cases` SKILL contract and elided the per-journey recipe outputs; `app-screenshot-capture` halted correctly but the operator-facing message conflated the failure mode with general "missing input" diagnostics. See jjackson/ace#106 finding #3 + #16. | ACE team |
| 2026-05-07 | **Step 5 anyone-with-link via `drive_upload_binary({shareAnyoneWithLink: true})`** — replaces the previous unfulfillable contract (the SKILL named `drive.permissions.create` but no MCP atom implemented it). The new flag sets `role: reader, type: anyone` atomically at upload time, eliminating the "deck builds without errors but slides are empty" failure mode. Standalone `drive_set_anyone_with_link({fileId})` atom also added for retroactive sharing. See jjackson/ace#115 finding #3. | ACE team |
