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
smoke judge so Phase 6 has a meaningful (but cheap) signal that the
built apps are usable end-to-end. Deep, per-journey UX grading lives in
`/ace:qa-deep` → `app-ux-eval` — this skill is intentionally shallow.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 (`pdd-to-app-journeys`) | `ACE/<opp>/runs/<run-id>/2-scenarios/pdd-to-app-journeys.md` | persona summary for the UX judge prompt; archetype context |
| Phase 3 (`app-test-cases`) | `ACE/<opp>/runs/<run-id>/3-commcare/app-test-cases.yaml` | smoke-recipe selection (`is_smoke: true`) + recipe paths |
| Phase 1 | `ACE/<opp>/inputs/pdd.md` | persona-summary fallback if not embedded in pdd-to-app-journeys |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/app-deploy_summary.md` | HQ domain for `${HQ_DOMAIN}` env var |
| Phase 4 (run_state.yaml) | `phases.connect-setup.products.connect.opportunity.{id, name}` + top-level `run_id` + ACE test user invite | `${OPP_RUN_ID}` (verbatim from `run_state.yaml.run_id`, the deterministic tile matcher), `${OPP_NAME}` (verbatim from `opportunity.name`, logging/screenshot context only), `${ACE_E2E_PHONE_LOCAL}`, etc. |

Recipes are read by path from the entries in `app-test-cases.yaml`
(`recipe_path` field). They were composed and validated by Phase 3's
`app-test-cases` skill — this skill does NOT compose or validate
recipes itself. If a smoke recipe is missing or malformed, halt and
point at `app-test-cases`.

## Products

- `6-qa-and-training/screenshots/<recipe-base>/<step-name>.png` — per-step PNGs (anyone-with-link permission set at upload for Slides ingest)
- `6-qa-and-training/app-screenshot-capture_manifest.yaml` — fileId/alias index consumed by `training-flw-guide` and `training-deck-generate`
- `6-qa-and-training/app-screenshot-capture_verdict-shallow.yaml` — thin per-app UX smoke verdict

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

Read `app-test-cases.yaml`. **Filter `journeys[]` to entries with
`is_smoke: true`** (this is the only set Phase 6 walks). Deep
(non-smoke) journeys carry `recipe: deferred` — Phase 3 does NOT author
their recipe files (they are generated lazily by `/ace:qa-deep`; see
`skills/app-test-cases/SKILL.md § Products` + jjackson/ace#605). This
skill never reads or runs deep journeys, so a `recipe: deferred` entry
is expected and must NOT be treated as a missing-recipe failure. Scope
every check below to the `is_smoke: true` subset. Then group the smokes
by the `app:` field. Run these checks in order. Halt at the first
failure with a structured PLATFORM-tag auto_surfaced entry naming the
exact remediation command:

| Failure mode | PLATFORM message | Remediation |
|---|---|---|
| Master yaml has zero `is_smoke: true` journeys | `app-test-cases.yaml has no is_smoke:true journeys; upstream Phase 3 (app-test-cases) emitted no smoke set` | `/ace:step app-test-cases <opp>/<run-id>` |
| `app: learn` smoke count != 1 OR `app: deliver` smoke count != 1 | `app-test-cases.yaml smoke set malformed: expected exactly one is_smoke:true journey per app, got learn=N deliver=M` | `/ace:step app-test-cases <opp>/<run-id>` |
| `3-commcare/recipes/` subfolder does not exist on Drive | `app-test-cases.yaml declares is_smoke:true journeys but 3-commcare/recipes/ subfolder is missing — upstream Phase 3 produced incomplete output (master yaml without per-journey recipes)` | `/ace:step app-test-cases <opp>/<run-id>` BEFORE retrying this skill |
| One or more **smoke** journeys' `recipe_path` doesn't resolve to a real file | `recipe_path journey-<app>.yaml referenced by app-test-cases.yaml does not resolve under 3-commcare/recipes/ — upstream Phase 3 produced an incomplete output set` | `/ace:step app-test-cases <opp>/<run-id>` BEFORE retrying |

(A non-smoke journey with `recipe: deferred` and no recipe file is NOT a
failure — those are generated on demand by `/ace:qa-deep`. Only the
`is_smoke: true` journeys are checked here.)

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
- Smoke recipe text(s) — read from `3-commcare/recipes/journey-*.yaml` on
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
| `form-advance-without-answer-tap` | Recipe chains ≥2 consecutive form-advance steps with no answer step between them — required-input questions will stall on `warning_root`. Re-author via `/ace:step app-test-cases`: for each required field, read its label/options via Nova `get_form` and emit a `tapOn:text:"<literal>"` (or `inputText` / photo-capture sequence) BEFORE the form-advance. |
| `brief-label-drift` | Recipe has a `tapOn:text:"X"` matcher where X matches a PDD-brief naming pattern (`^[LFM]\d+ — `, `^Stage \d+ — `). Nova rewrites these during autobuild and the matcher won't resolve live. Re-author via `/ace:step app-test-cases`: read the live label from Nova `get_form`/`get_module` and use it verbatim. |
| `deliver-smoke-rewalks-learn` | Re-author the Deliver smoke as resume-only (`connect-resume-opp` → `deliver-launch.yaml`) via `/ace:step app-test-cases`. The Learn leg already completes Learn. |

On any failure, halt with the **incomplete-mode verdict shape** (see
Step 9), `verdict: incomplete`, and a per-class
PLATFORM auto_surfaced entry naming the remediation. Do NOT proceed
to Step 3 — every one of these classes is structurally guaranteed to
produce a recipe-level failure 5-10 min later. Fail fast at the
boundary.

### Step 2.7: Learn-completion is one-way — never re-walk, never mutate to diagnose (#568)

**Learn completion is permanent per `(test user, opportunity)`.** Once
the test user has completed Learn on an opp, Connect routes "Continue
Learning" to the **Deliver download gate**, not the Learn home — the
Learn flow cannot be walked again on that opp+user. This is documented
in `docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md`;
this step makes it operational so the Learn-walk smoke does not halt on a
consumed opp.

Two hard rules:

1. **A recipe-defect diagnosis must NOT mutate one-way live state.** If
   the Learn smoke recipe is broken (e.g. a missing FINISH press), fix
   the *recipe* — do NOT manually complete Learn on the live opp to
   "confirm the fix." Completing Learn consumes the Learn-not-complete
   precondition permanently, and the only restore is a fresh opportunity
   (run independence). The bednet-spot-check/20260529-1124 cycle burned
   two Phase-6 attempts + a failed opp re-mint exactly this way.

2. **An already-Learn-complete opp is NOT a re-walkable state and NOT a
   blocker to "recover" by re-walking.** The Learn leg (Step 5) must
   branch on it:
   - If, after the claim/resume prefix, the device is at the **Deliver
     gate** (Learn already complete — `connect-claim-opp.yaml` surfaces
     this via its already-Learn-complete branch, #570), record the Learn
     sub-verdict as **`satisfied-by-prior-completion`** (NOT `fail`, NOT
     `incomplete` — Learn genuinely completed, just on a prior pass) and
     proceed directly to the **Deliver leg**, which is unlocked.
   - Only attempt the actual Learn screenshot walk when the device lands
     on the **Learn home** (`nsv_home_screen`) — i.e. Learn is genuinely
     not yet complete.

If a *fresh* Learn-walk screenshot set is specifically required (e.g. the
prior completion produced no usable captures), that needs a **fresh
opportunity** — start a new `/ace:run` (new opp → fresh
`OpportunityAccess`). Do NOT re-mint a Phase-4 opp on the *same released
Deliver app* to get there: Connect shares one `DeliverUnit` across opps
on the same `cc_app_id`, so the fresh opp can't get a payment unit
(#573) — a fresh run (new apps → new `cc_app_id`) is the clean path.

This branch is the structural fix; it does not require a live pre-AVD
probe (Connect exposes no clean per-user Learn-completion atom today) —
the claim-prefix landing screen IS the signal.

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
- `connect-claim-opp.yaml` with **`${OPP_RUN_ID}`** (the deterministic
  tile matcher) read verbatim from `run_state.yaml.run_id`, AND
  `${OPP_NAME}` read verbatim from
  `run_state.yaml.phases.connect-setup.products.connect.opportunity.name`
  (logging / screenshot context only).

**OPP_RUN_ID matcher — the deterministic tile finder (#618).** Phase 4
(`connect-opp-setup`) front-prefixes every opp name with the run-id:
`"<run_id> · <PDD display name>"` (e.g. `"20260601-0739 · Malaria RDT
Performance Sampling"`). The run-id (format `YYYYMMDD-HHMM`, the
top-level `run_state.yaml.run_id`) is unique per run and, as a FRONT
prefix, lands on the tile's first line — short and never clipped by the
tile's name-wrap. The claim/resume recipes anchor their tile match on it
as `text: ".*${OPP_RUN_ID}.*"` (Maestro `text:` is a full-match regex;
the `.*` wrappers substring-match the run-id within the longer tile
label). Pass `${OPP_RUN_ID}` **verbatim** from `run_state.yaml.run_id`.
This is what makes finding this run's opp among the test user's
accumulated invites deterministic.

**OPP_NAME — context only (no longer the matcher).** Phase 4 also writes
the exact tile name Connect renders into
`phases.connect-setup.products.connect.opportunity.name`. Pass that
string **verbatim** as `${OPP_NAME}` for logging and screenshot context.
Do NOT reassemble from slug pieces. It is **no longer the recipe
matcher** — `${OPP_RUN_ID}` (above) is.

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

**OPP_NAME uniqueness assumption (durable note) — resolved by the
run-id FRONT prefix (#618).** Because every `/ace:run` Phase 3 invites
the same ACE test user (`${ACE_E2E_PHONE}`) to a fresh Connect opp, the
test user's in-app invite list grows unboundedly across runs. Every
prior opp the test user was ever invited to is still listed, and there
is no per-run cleanup atom yet (TBD) — **the list still grows**.

What changed (#618): `connect-opp-setup` now front-prefixes the opp name
with the run-id — `"<run_id> · <display name>"` (e.g.
`"20260601-0739 · Malaria RDT Performance Sampling"`) — and the
claim/resume recipes anchor their match on the run-id token via
`text: ".*${OPP_RUN_ID}.*"`. This resolves the two fragilities the old
run-id-SUFFIX form carried:

1. **Discriminator no longer clipped.** The old name put the run-id at
   the END of a long name that wraps to 2-3 lines on the tile — the
   most-clipped position, so the only disambiguating token was the one
   most likely below the fold. The run-id is now a FRONT prefix on the
   tile's first line, which is never clipped by name-wrap.
2. **No reliance on "newest near top."** The old `tapOn:text` matcher
   depended on Connect ordering by invited_at descending so the right
   tile sorted near the top. The recipes now `scrollUntilVisible` on the
   run-id regex and assert it, so the match is positional-order-
   independent: it finds this run's tile wherever it sits in the list.

**Remaining honest caveat.** The invite list itself is still unbounded —
there is no per-run cleanup atom, so the test user accumulates dozens of
tiles over time. The run-id match is what makes finding the right one
*deterministic* despite that accumulation (a short, unique, line-1
token), but the underlying list growth is unchanged. A periodic
test-user invite-list-cleanup atom is still desirable (Connect doesn't
expose this in the public API today; would need a `connect_*` Playwright
atom).

### Step 5: Run the smoke recipes — two independent legs

**Palette-composition footguns (jjackson/ace#592) — read before composing recipes:**

1. **`mobile_run_recipe` does NOT resolve `${SELECTOR:...}` placeholders
   inside `runFlow`'d palette files.** It resolves selectors in the
   top-level recipe body it's handed, but a palette piece pulled in via
   `runFlow:` runs *verbatim* — Maestro receives the literal
   `${SELECTOR:foo}` token and (because `${...}` is also Maestro's env-var
   syntax) resolves it to `NaN` (e.g. `Assert that "NaN" is visible`).
   When composing static palette pieces, either (a) run
   `mobile_resolve_selectors` on the composed body first, or (b) inline
   literal selectors. Do NOT assume nested `runFlow` inherits the parent's
   selector resolution.
2. **`runFlow` relative paths resolve against Maestro's temp chunk dir,
   not the recipe-file dir.** `runFlow: ../../../../mcp/...` fails with
   `Flow file does not exist: /var/folders/.../mcp/...`. Always use
   **absolute paths** when composing palette pieces.
3. **Login credentials are easy to mis-split.** `COUNTRY_CODE` is `7`
   (the dialing code), `PHONE_LOCAL` is `4260000101`, and the PIN is the
   full `${ACE_E2E_PIN}` (`111111`, 6 digits). The `+7426` demo prefix in
   the docs is CC `7` + local starting `4260000101` — do NOT mis-split it
   as CC `7426`.
4. **Mid-session re-login surface (tracked recipe gap).** Between the
   Learn and Deliver legs the Connect session can drop to a
   signed-out-but-registered screen — `screen_login_main` with
   `welcome_msg` "Welcome ACE Test!" and a `login_button`
   "LOGIN WITH PERSONALID". `connect-login.yaml` today only branches on
   first-start (`str_setup_message`) and already-signed-in
   (`connect_fragment_jobs_list`); it halts on this intermediate screen.
   The branch (tap `login_button` → `lockPassword` → PIN) is documented
   but **not yet live-validated** — calibrate it the next time this
   surface is reached on-device, then add the branch + a
   static-recipe-invariants assertion. Until then, a re-login drop
   between legs is a known cause of a Deliver-leg halt.

**HARD RULE — screenshots come ONLY from a `status: pass` execution in
THIS run (jjackson/ace#756).** If `mobile_run_recipe` returns
`status != pass` for a required journey, that leg's screenshots DO NOT
EXIST: record the leg `fail` with the recipe failure (failureClass,
stderr, failed step) inline in the verdict, and NEVER source PNGs from
the screenshot dir, a prior run, or any imagined "replay cache" — no
such mechanism exists, and any file not in the returned `screenshots[]`
of this dispatch is untraceable. The shallow verdict MUST NOT be `pass`
if any required journey's recipe failed (per the Step 9 table). Halt
loud per CLAUDE.md § Phase preconditions — don't ship placeholders.
(Since #756 `mobile_run_recipe` also wipes the screenshot dir at
execution start, so stale PNGs are structurally absent — but the rule
stands regardless of what's on disk.)

Capture is split into a **Learn leg** and a **Deliver leg**. The legs
are graded independently; a Deliver failure never suppresses Learn
capture.

**Learn leg (always runs first).** Run `journey-learn.yaml` against the
AVD. Upload every captured screenshot to
`6-qa-and-training/screenshots/journey-learn/<step-name>.png`
(`shareAnyoneWithLink: true`, `mimeType: image/png`; upload any sibling
`<step-name>.xml` ui-dump with `mimeType: application/xml`). Record the
Learn leg outcome (`pass` iff the recipe status is pass AND every
screenshot is non-zero bytes). A Learn failure records the Learn
sub-verdict and does NOT abort the dispatch — but the Deliver leg then
cannot run (Connect gates Deliver behind Learn completion), so it is
recorded `blocked-by-learn`.

**Deliver leg (runs second; depends on the Learn leg).** Only attempt
if the Learn leg reached completion. `journey-deliver.yaml` resumes
from the now-unlocked state in the same device session (no re-login).
Upload to `6-qa-and-training/screenshots/journey-deliver/<step-name>.png`.
Record the Deliver leg outcome independently.

**FIRST, before any Deliver recipe — capture the post-Learn landing
(unconditional, #618 ground truth).** The instant the Learn leg completes,
`mobile_capture_ui_dump` and upload it to
`journey-deliver/00-postlearn-landing.xml` (`drive_upload_binary`,
`mimeType: "application/xml"`). This is captured BEFORE the Deliver leg
runs (and BEFORE any failure remediation) precisely because the device's
post-Learn state is fragile — see the next rule. The dump tells you which
post-Learn pathway you're on: `nsv_home_screen` → **Path A** (device on the
CommCare Learn home, inside CommCare — the uncharacterized
[#618](https://github.com/jjackson/ace/issues/618) landing);
`connect_fragment_jobs_list` → **Path B** (Connect jobs list — `deliver-launch`
drives it). On Path A, run the #618 probe below.

**NEVER cold-boot / re-bootstrap to "recover" a Deliver-leg failure.** A
Deliver landing on the CommCare home (`nsv_home_screen`) is the **#618 nav
gap — an expected, characterized condition, NOT a device-infra failure.**
`mobile_ensure_avd_running` (cold-boot) and `/ace:mobile-bootstrap`
**destroy the post-Learn state and reset the device PIN**, which makes
recovery impossible and wedges the rest of the run on a system auth prompt
(observed live, run `20260605-2138`: a cold-boot after the Deliver handoff
failed reset the PIN → every subsequent recipe failed on `com.android.systemui`
→ the leg gave up after re-register attempts). On a Deliver-leg failure: do
NOT escalate to a boot/bootstrap. Capture the dump (above) + the #618 probe
(below), record the Deliver leg `incomplete`, and STOP. Re-bootstrap is ONLY
for a Learn-leg `CommCareSetupActivity`/PersonalID-wipe failure (the table
row that names it), never for a post-Learn Deliver landing.

**Do NOT halt the dispatch on a single leg failure.** Run both legs (or
record why the Deliver leg couldn't run), then write the per-app
verdict in Step 9. The recipe-error → failure-mode table below is the
per-leg classifier — apply it to whichever leg failed.

- **CRITICAL:** the `shareAnyoneWithLink: true` flag is required.
  Slides' `createImage` (used by `training-deck-render` downstream)
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
  `ACE/<opp>/runs/<run-id>/6-qa-and-training/screenshots/<recipe-base>/<step-name>.xml`
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

**#618 Path-A inter-leg probe (calibration).** When the unconditional
post-Learn dump (`00-postlearn-landing.xml`, above) shows the device on
`nsv_home_screen` — Path A, the CommCare Learn home (Start / View Job Status /
Sync / Log out of CommCare tiles) — Deliver is unreachable from here (it's
only reachable via Connect's opp-detail → DOWNLOAD gate), so Path A must
return to Connect first, and that return-nav has never been captured live.
Run this probe to capture the return-route from live truth instead of
guessing (do NOT cold-boot — see the rule above):

1. `mobile_run_recipe(connect-learn-home-deliver-probe.yaml)` — taps the
   "Log out of CommCare" tile (the candidate return-to-Connect route).
2. `mobile_capture_ui_dump` → upload to
   `journey-deliver/618probe-01-after-logout-tile.xml` (`drive_upload_binary`,
   `mimeType: "application/xml"`). This is the measurement: did Logout land on
   Connect's jobs list (`connect_fragment_jobs_list` — the desired Path-A entry
   to `deliver-launch.yaml`) or fully de-register the worker?
3. Upload both probe screenshots (`618probe-*.png`, `shareAnyoneWithLink:
   true`).
4. Record the Deliver leg `incomplete` with note `#618 Path-A probe captured
   — see journey-deliver/00-postlearn-landing.xml + 618probe-01-*.xml`. Do NOT
   mark Deliver `pass`/`fail` on the probe; it's a calibration capture.

This is the "close the loop to the source of truth — one live dump beats a
guess" rule applied to the longest-standing Phase-6 gap. Once the dumps show
the real return route, encode it in `connect-resume-opp.yaml` as the Path-A
branch (detect `nsv_home_screen` → return-to-Connect → existing jobs-list CTA
logic) and retire this probe.

**Before consulting this table, READ the failure screenshot.** Two
sources, in priority order:

1. **`result.failureForensics` (auto-captured, cross-backend — since
   0.13.538).** On *every* recipe `status: 'fail'`, `mobile_run_recipe`
   captures the device state at the moment of failure — `uiDumpPath`
   (an `<recipe-id>-FAILURE.xml` element tree: resource-ids/text/bounds,
   the highest-signal artifact for selector + nav debugging) plus
   `screenshotPath` (`<recipe-id>-FAILURE.png` of the offending screen)
   — and returns them on the result. Both land in the run's
   `screenshotDir`, so they get uploaded + provenance-stamped alongside
   the smoke PNGs. This works on the cloud backend too (Maestro's own
   debug-bundle screenshot is local-only). **Read `failureForensics`
   first** — the ui-dump usually shows the exact screen + the
   resource-ids present, which resolves "wrong selector" vs "wrong
   screen" immediately.
2. **Maestro's debug-bundle screenshot (local AVD only).** Written on
   every halt; path appears in the `maestro.log` `Failed:` line as
   `screenshot-❌-<timestamp>-(<recipe>.yaml).png`, under
   `~/.maestro/tests/<timestamp>/`.

The image/dump often names the failure mode literally — *"Logged out of
PersonalID"*, *"Enter Code"*, *"Failed to start learning"*, *"App not
found"* — making package / process / driver probing redundant.
**Image-read first, infer second.**
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
| `Failed to start learning` | Released Learn CCZ has Nova `<module xmlns="…connect…">` + `<assessment xmlns="…connect…">` wrappers that the AVD's CommCare runtime can't launch. Confirmed live 2026-05-07 against leep-paint-collection: turmeric Learn (working) has 0 wrapper refs; LEEP Learn (broken) has 16. Tracking: [voidcraft-labs/nova-plugin#7](https://github.com/voidcraft-labs/nova-plugin/issues/7), [jjackson/ace#115 finding 1](https://github.com/jjackson/ace/issues/115). | As of 0.13.66 Phase 3's Step 2.8 invokes `commcare-form-patch` automatically — re-run `/ace:run <opp>` and Phase 6 should pick up the patched Learn release. For an in-flight opp that already shipped Phase 3 without the patch: `/ace:step commcare-form-patch <opp>` then re-run Phase 6. Diagnostic probe: `npx tsx scripts/probe-connect-learn-handoff.ts <opp_uuid>` + adb logcat. |
| `deviceInfo … UNAVAILABLE` / `MaestroDriverError` | Maestro driver app on the AVD is installed but its gRPC server isn't responding. Symptom of a wedged driver process or a stale install whose runtime state diverged from the CLI's expectations. Reproduced live 2026-05-11 against leep run 20260511-0507 Phase 6 (port 7001 refusing connections, every recipe stalling on `deviceInfo`). | Since 0.13.165 `mobile_ensure_avd_running` auto-heals (force-stop + uninstall both halves of `dev.mobile.maestro`, then re-probe to trigger the CLI's auto-reinstall). If this error still surfaces, the heal exhausted — run `/ace:mobile-bootstrap` to re-baseline the AVD + driver, then `/ace:step app-screenshot-capture <opp>/<run-id>`. Logcat probe: `adb -s <serial> logcat | grep -i maestro`. |
| `extendedWaitUntil` timeout on `connect_fragment_jobs_list` | Claim flow didn't reach jobs list. LLO program-application not ACCEPTED, or Connect session expired on the AVD. | Re-run `connect-login.yaml` and verify `connect_get_opportunity` returns the expected opp. |
| `assertVisible(text: ${OPP_NAME})` failure AND focused activity is `CommCareSetupActivity` AND/OR failure screenshot shows "Logged out of PersonalID" / "Lost PersonalID configuration" / "Reconfigure" / "Enter Code" / "Welcome to CommCare" | **AVD's per-user state was wiped** — no `ApplicationDocument` configured (CCHQ app never pulled OR app db was wiped) and/or PersonalID account de-registered from the device. Important: `org.commcare.dalvik` IS the Connect-enabled CommCare client (no separate Connect package); presence of `org.commcare.dalvik` in `pm list packages` does **NOT** imply a usable Connect home. Should have been caught by Step 2.5; if it surfaces here, Step 2.5's probe missed a signal worth adding. Live in 2026-05-13 (turmeric run 20260513-0616) with both states stacked: setup activity foregrounded + PersonalID drawer banner. | `/ace:mobile-bootstrap` — re-installs APK if needed, registers the ACE test user (`${ACE_E2E_PHONE}`) via the Connect registration API, pulls the CCHQ app for this run's HQ ids, saves a clean snapshot. After bootstrap returns clean: `/ace:step app-screenshot-capture <opp>/<run-id>`. If this state recurs after a successful bootstrap, the issue is state-loss between sessions (snapshot revert, AVD cold-boot, server-side PersonalID de-registration); file a class-level issue on `mobile_ensure_avd_running`'s state-persistence contract rather than re-bootstrapping. |
| `assertVisible(text: ${OPP_NAME})` failure AND failure screenshot shows the Connect "New Opportunities" / opp list home (the user IS logged in, app IS configured, just no matching tile) | Right opp card not on screen for the OPP_NAME being matched. Wrong `OPP_NAME` env var (typically slug-reassembled instead of read verbatim from `run_state.yaml`), OR opp not yet claimed by the test user, OR `${OPP_NAME}` collides ambiguously with another invite further up the test user's accumulated invite list (see Step 4 "OPP_NAME uniqueness assumption"). | Confirm `OPP_NAME` was read verbatim from `run_state.yaml.phases.connect-setup.products.connect.opportunity.name` (NOT composed from slug pieces — see Step 4 "OPP_NAME source" and [#115 finding 4](https://github.com/jjackson/ace/issues/115)). If the field is present and still mismatches the tile, scroll the invite list or use the `connect_get_opportunity` fallback. |
| `assertVisible(nsv_home_screen)` failure AND a `claim-START-HANDOFF-WEDGED-issue629` screenshot is present (Start was tapped on the opp-detail Job Card; neither the Learn home nor the Deliver download gate ever rendered within 180s) | **Inert `btn_start` handoff** — Connect's `POST /users/start_learn_app/` never fired or 500-ed, so the Learn CCZ download never began and `nsv_home_screen` never appeared. This is the Connect-platform half of [#629](https://github.com/jjackson/ace/issues/629), downstream of ACE — the released CCZ already passed Phase 3's `commcare-cli play` install gate, so it is NOT a Nova/recipe/marker defect. `connect-claim-opp.yaml` now captures the labeled artifact + fails loud at this exact point instead of a generic 180s timeout. | Run `connect_preflight_learn_app_user({org_slug, opportunity_id})` to classify: an auth/domain/conflict failure there confirms the server-side `start_learn_app` block (fix Connect-side / re-invite the test user); a clean preflight points at a device-side wedge (re-run after `mobile_ensure_avd_running` cold-boot). Do NOT mark the Learn leg `pass` on placeholder screenshots; record the wedge verdict and surface #629. |

**Manual-debug fallback — when the table doesn't resolve it.** If a
recipe error matches NO row above (a novel nav defect, an
uncharacterized inter-leg handoff like [#618](https://github.com/jjackson/ace/issues/618),
a selector that resolved on a sibling APK but not this one), do NOT
halt blind. **Open `failureForensics.screenshotPath` and read
`failureForensics.uiDumpPath` before writing the verdict:**

1. The `.png` tells you *which screen* the device died on (Learn home?
   Connect job card? a dialog?).
2. The `-FAILURE.xml` ui-dump lists the resource-ids/text actually
   present on that screen — diff that against the selector the recipe
   reached for. "Selector absent from the dump" → wrong screen or APK
   selector drift; "selector present but tap was a no-op" → a
   `childOf`/scoping or timing issue.
3. If that names a concrete recipe/selector fix, **`gh issue create`
   against `jjackson/ace`** with the dump excerpt + the screen it
   characterizes (the "close the loop to the source of truth" rule —
   one live dump beats another plausible guess), then encode the fix
   only after a live `mobile_capture_ui_dump` → candidate-tap → re-dump
   confirms it navigates. Until confirmed live, halt loud with the
   characterization in the verdict — never ship an unvalidated nav
   guess (the #618 / #591 selector-drift class).

### Step 6: Write `6-qa-and-training/app-screenshot-capture_manifest.yaml`

Link each captured PNG back to (a) its journey id (a meaningful slug
like `journey-learn-pass` / `journey-deliver-submit` from `app-test-cases.yaml`), (b) its
`takeScreenshot:` step label, (c) its Drive path. This is the input
shape the per-artifact training skills (`training-flw-guide`,
`training-deck-generate`) consume.

### Step 6.5: Harvest selector-drift signal (atlas-drift)

Run the drift harvester over this run's screenshot dir (the same
`screenshotDir` you passed to `mobile_run_recipe` in Step 5, where the
`*-FAILURE.xml` / `*-FAILURE.png` forensics and the per-step `runRecipeWithDumps`
XMLs accumulated). This closes the consume-loop on selector drift —
otherwise the dumps just pile up unread.

```bash
npx tsx scripts/probe-atlas-drift.ts <screenshotDir> \
  --apk "${ACE_CONNECT_APK_VERSION:-2.63.0}" \
  --out <screenshotDir>/atlas-drift-report.md
```

Best-effort: a probe error never fails the phase — log it and continue.
When the report has a **"⚠️ Drift suspects on FAILURE screens"** section,
treat those resource-ids as the priority signal: each is a candidate
root cause for a recipe failure *in this run* (the recipe reached for a
logical name whose mapped `id:` no longer matches what this APK renders —
the #591/#618 selector-drift class). Do NOT auto-edit the selector map —
surface the candidates in the verdict and, when a candidate is
confirmed live (`mobile_capture_ui_dump` → candidate-tap → re-dump
navigates), `gh issue create` against `jjackson/ace` proposing the new
`selectors.<logical-name>` row. This is the "close the loop to the
source of truth" rule — one live dump beats another plausible guess.

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
`6-qa-and-training/app-screenshot-capture_verdict.yaml` AND the
shallow smoke verdict to
`6-qa-and-training/app-screenshot-capture_verdict-shallow.yaml`. Both
shapes conform to `lib/verdict-schema.ts` so `opp-eval` can aggregate.

**Structural verdict** (`6-qa-and-training/app-screenshot-capture_verdict.yaml`):

```yaml
skill: app-screenshot-capture
target: <opp-name>
ran_at: <ISO timestamp>
capture_path: 6-qa-and-training/app-screenshot-capture_manifest.yaml

overall_score: 8.5             # 0.0–10.0, weighted across dimensions
verdict: pass | warn | fail | incomplete
# `incomplete` is reserved for *upstream-incomplete* state the skill
# itself cannot remediate: app-test-cases.yaml missing or malformed,
# `3-commcare/recipes/journey-*.yaml` files absent, recipes carrying
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
  - ref: learn
    score: 9.0
    verdict: pass
    note: "journey-learn walked to completion; 6 screenshots, all PNG"
  - ref: deliver
    score: 0
    verdict: incomplete       # or fail / pass
    note: "journey-deliver.yaml missing — Phase 3 deferred it"
```

Top-level `verdict` from the two legs:

| Learn | Deliver | top-level verdict | phase proceeds clean? |
|---|---|---|---|
| pass | pass | `pass` | yes |
| pass | fail (ran, broke) | `fail` | no — blocks |
| pass | incomplete (recipe missing/scaffold) | `incomplete` | no — blocks |
| fail | blocked-by-learn | `fail` | no — blocks |
| incomplete | incomplete | `incomplete` | no — blocks |

A non-pass verdict still ships the Learn screenshots it captured.
Operator-authorized whole-step skip remains the separate explicit
escape (unchanged).

```yaml

auto_surfaced:
  - severity: WARN
    message: "Recipe X timed out at step Y; partial screenshots captured"
```

**Shallow smoke verdict** (`6-qa-and-training/app-screenshot-capture_verdict-shallow.yaml`):

```yaml
skill: app-screenshot-capture
target: <opp-name>
mode: shallow
ran_at: <ISO timestamp>
capture_path: 6-qa-and-training/app-screenshot-capture_manifest.yaml

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
| Coverage | both legs attempted; Learn always; Deliver iff Learn completed |
| Execution | every smoke recipe status: pass |
| Artifact quality | every screenshot is a valid PNG with non-zero bytes |
| Manifest integrity | manifest.yaml lists every screenshot path actually present in Drive |
| UX smoke (shallow verdict only) | per-app score ≥ 2/3 from the thin smoke judge |

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-06-12 | **Step 5 hard rule: screenshots only from a `status: pass` execution in THIS run (jjackson/ace#756).** A `status != pass` `mobile_run_recipe` result for a required journey means that leg has NO screenshots — record the leg `fail` with the recipe failure inline; never source leftover PNGs (no "replay cache" exists); the shallow verdict must not be `pass` if any required journey's recipe failed. Pairs with the MCP-side fix: `mobile_run_recipe` now wipes the screenshot dir at execution start so stale PNGs are structurally absent. Surfaced by bednet-spot-check run 20260612-1220, where a failed deliver leg shipped prior-run PNGs under a confabulated "runner replay cache" note. | ACE team |
| 2026-06-03 | **Step 6.5 auto-harvests selector drift.** End of Phase 6 now runs `scripts/probe-atlas-drift.ts` over the run's screenshot dir automatically (best-effort), closing the consume-loop on the `runRecipeWithDumps` + `*-FAILURE.xml` dumps that previously just accumulated. The harvester is now FAILURE-aware: resource-ids seen on a `*-FAILURE.xml` screen but absent from the selector map surface as a priority "Drift suspects on FAILURE screens" section (candidate root causes for a recipe failure in this run — the #591/#618 drift class). Pairs with thrown-failure forensics capture (`mobile_run_recipe` now captures the failure screen on a thrown driver-death too, not just on returned `status:'fail'`). Canonical contract: `playbook/integrations/mobile-integration.md § Failure forensics`. | ACE team |
| 2026-05-05 | **Path-scheme migration.** Inputs repointed to `2-scenarios/pdd-to-app-journeys.md`, `3-commcare/app-test-cases.yaml`, `3-commcare/app-deploy_summary.md`, `3-commcare/recipes/`. Outputs repointed to `6-qa-and-training/screenshots/<recipe-base>/<step-name>.png`, `6-qa-and-training/app-screenshot-capture_manifest.yaml`, `6-qa-and-training/app-screenshot-capture_verdict.yaml`, `6-qa-and-training/app-screenshot-capture_verdict-shallow.yaml` (per manifest). Both verdict YAML examples' `capture_path` updated. No behavior change beyond paths. | ACE team |
| 2026-05-27 | **Recipe naming convention.** Screenshot dirs updated from `<journey-id>/` to `<recipe-base>/` (`journey-learn/`, `journey-deliver/`). Recipe read references updated from `J*.yaml` to `journey-*.yaml`. Structural verdict `per_item` refs changed from `ref: "J1.yaml"` to `ref: learn` / `ref: deliver`. No runtime behavior change. See spec 2026-05-27-phase6-learn-deliver-decoupling. | ACE team |
| 2026-05-31 | **Meaningful journey ids.** The manifest's journey-id reference is now a meaningful slug (`learn-happy-path` / `deliver-yes`) from `app-test-cases.yaml` instead of `J<n>`. Pairs with the descriptive recipe filenames / screenshot dirs already in place. See `skills/app-test-cases/SKILL.md § Journey id convention`. | ACE team |
| 2026-05-31 | **`journey-` prefix.** The manifest's journey-id reference examples now carry the `journey-` prefix (`journey-learn-pass` / `journey-deliver-submit`) to match the amended id convention. See `skills/app-test-cases/SKILL.md § Journey id convention`. | ACE team |
| 2026-05-31 | **Tolerate `recipe: deferred` (lazy deep recipes, #605).** Phase 3 now authors recipe files only for the two `is_smoke: true` journeys; deep journeys carry `recipe: deferred` and have no file (generated on demand by `/ace:qa-deep`). Step 2's pre-flight is scoped explicitly to the `is_smoke: true` subset, and a deferred deep journey with no recipe file is no longer a missing-recipe failure. This skill already only walked the smokes — this change makes the deferred-deep state explicitly non-fatal. | ACE team |
| 2026-05-27 | **Two-leg capture split.** Step 5 rewritten as independent Learn leg + Deliver leg. Learn always runs first; a Deliver failure (or missing recipe) no longer suppresses Learn screenshots. Per-app `per_item` verdict mapping table added (pass/fail/incomplete/blocked-by-learn outcomes). Coverage rubric updated: "both legs attempted; Learn always; Deliver iff Learn completed." See spec 2026-05-27-phase6-learn-deliver-decoupling. | ACE team |
| 2026-05-06 | **Step 2 input-completeness pre-flight** — restructured the post-Step-1 logic into an explicit failure-mode table that distinguishes upstream Phase 3 incomplete output (master yaml without recipes) from smoke-flag malformation. Each failure halts with a named PLATFORM auto_surfaced message + the exact `/ace:step` remediation command, and writes `verdict: incomplete` (not `fail` — upstream gaps aren't smoke failures). Surfaced by leep-paint-collection run 20260506-1440 where a Phase 3 dispatch paraphrased the `app-test-cases` SKILL contract and elided the per-journey recipe outputs; `app-screenshot-capture` halted correctly but the operator-facing message conflated the failure mode with general "missing input" diagnostics. See jjackson/ace#106 finding #3 + #16. | ACE team |
| 2026-05-07 | **Step 5 anyone-with-link via `drive_upload_binary({shareAnyoneWithLink: true})`** — replaces the previous unfulfillable contract (the SKILL named `drive.permissions.create` but no MCP atom implemented it). The new flag sets `role: reader, type: anyone` atomically at upload time, eliminating the "deck builds without errors but slides are empty" failure mode. Standalone `drive_set_anyone_with_link({fileId})` atom also added for retroactive sharing. See jjackson/ace#115 finding #3. | ACE team |
