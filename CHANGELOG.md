# Changelog

All notable changes to the ACE plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the plugin follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.10.38 — 2026-04-30

**Closes the FLW-invite + claim-flow loop end-to-end. New
`connect_finalize_opportunity` atom + fully-calibrated
`connect-claim-opp.yaml`.**

The 21st `ace-connect` atom: finalize an opportunity by setting
`start_date`, `end_date`, and `max_users`. The form computes
`total_budget = max_users × Σ(payment_unit.amount × max_total)` and
persists it server-side. After finalize, `is_setup_complete` returns
True and `connect_send_flw_invite` can finally land an invite.

**Live success against the existing `249ad8fe…` turmeric opp**:
finalize → 302; FLW invite → 302 ("queued"); CommCare AVD opp list
populated within seconds; "View Opportunity" → opp-detail screen
captured live; "Start" button (`btn_start`) confirmed as the
accept-invite primitive. The whole `connect-claim-opp.yaml` recipe
is now calibrated against real selectors with no REPLACE_*
placeholders.

### Added

- `connect_finalize_opportunity` atom (`mcp/connect/`):
  - `capability-map.ts` — atom count 20 → 21
  - `client.ts` — `finalizeOpportunity` interface method
  - `backends/composite.ts` — Playwright routing
  - `backends/playwright.ts` — POSTs to `/finalize/`. Reads existing
    payment units to compute `total_budget` (the form's
    `total_budget` field is rendered readonly + computed by client-
    side JS; we mirror that JS calculation server-side so the form
    persists a non-zero value rather than the falsy 0 that trips
    `is_setup_complete`)
  - `connect-server.ts` — `connect_finalize_opportunity` MCP tool
    with zod date-format validation

### Changed

- `mcp/mobile/recipes/static/connect-claim-opp.yaml` — second half
  fully calibrated. `accept_invite_button` →
  `org.commcare.dalvik:id/btn_start`. `commcare_handoff_or_learn_root`
  → `org.commcare.dalvik:id/tv_learn_modules_list`. Card on opp list
  is tapped via the `btn_view_opportunity` button (cards aren't
  directly tappable — that was the wrong assumption in the original
  scaffold). No REPLACE_* placeholders remain in the recipe.
- `skills/connect-opp-setup/SKILL.md` Step 8 — split into
  Step 8a (`connect_finalize_opportunity`) and Step 8b
  (`connect_send_flw_invite`). Documents the
  `max_users × Σ(amount × max_total)` budget computation and the
  `max_daily` requirement on the PaymentUnit.
- `playbook/integrations/connect-api.md` — Lifecycle section bumped
  from 1 to 2 atoms.

### Test counts

42 connect unit tests pass (atom count test bumped 20 → 21; same
count of behavioural tests).

## 0.10.36 — 2026-04-30

**Form-error parser: support crispy-tailwind `<p id="error_N_id_FIELD">`
markup. Document `is_setup_complete` gating in `connect-opp-setup`.**

Live test of `connect_send_flw_invite` against the existing turmeric
opps surfaced two issues:

1. **Parser blind spot.** Connect's modern templates render form
   validation errors as
   `<p id="error_1_id_users" class="text-red-500…"><strong>…</strong></p>`,
   not the legacy `<ul class="errorlist">`. Our `parseFormErrors` /
   `parseFormErrorsByField` helpers only knew about the legacy markup,
   so the FLW-invite atom (and any other form-POSTing atom that hits a
   crispy-tailwind page) returned a generic
   `"Connect rejected request: … no errorlist found"` instead of the
   real reason. Now both helpers also pick up the modern pattern, with
   the field name parsed from the `id="error_N_id_FIELD"` attribute.
   Mixed-markup pages (legacy errorlist + modern `<p>` in the same
   response) are also supported.

2. **`is_setup_complete` gating.** The new atom is verified to behave
   correctly on every existing turmeric opp (live POSTs return
   structured `users: ["Please finish setting up the opportunity…"]`
   field errors), but the success branch (302 redirect) requires the
   target opp to be `is_setup_complete`. Per the upstream model that
   requires `total_budget` + `end_date` + every PaymentUnit having
   `max_total` AND `max_daily`. `connect_create_opportunity` doesn't
   set `total_budget`, `connect_update_opportunity` doesn't accept it,
   and `/add_budget_new_users` (an HTMX endpoint) needs its own atom
   that doesn't exist yet. Documented in `connect-opp-setup` Step 8 so
   the next time this is debugged the gap is in front of you, not
   buried in run-time error parsing.

### Changed

- `mcp/connect/backends/html-scrape.ts` — `parseFormErrors` and
  `parseFormErrorsByField` extended to recognize the crispy-tailwind
  `<p id="error_N_id_FIELD" class="text-red-500…">…</p>` pattern that
  modern Connect templates use. Backward-compatible with the legacy
  `<ul class="errorlist">` markup; both can coexist in one response.
- `skills/connect-opp-setup/SKILL.md` Step 8 — added explicit
  `is_setup_complete` checklist (`total_budget`, `end_date`,
  PaymentUnit `max_total`/`max_daily`) and documented the missing
  budget atom that blocks live FLW-invite success.

### Added

- `scripts/probe-flw-invite.ts` — kept as a durable reproducer for the
  live FLW-invite call against an existing opp. Iterates a list of
  candidate opps, dumps the response body when a 200-with-errorlist
  comes back, and reports the first one that succeeds (302).
- 3 new unit tests in `test/mcp/connect/unit/html-scrape.test.ts`
  covering the crispy-tailwind error pattern, the `<p id="error_…">`
  field-keyed scan, and the legacy + modern mixed-markup case.

### Test counts

42 connect unit tests pass (was 39 in 0.10.35).

## 0.10.35 — 2026-04-29

**New `connect_send_flw_invite` atom + `connect-opp-setup` Step 8 fix.**

The 20th `ace-connect` atom: invite one or more FLW phones to a Connect
opportunity. Mirrors what the Connect web UI does at
`/a/<org>/opportunity/<uuid>/user_invite/` — POSTs a newline-separated
list of `+<country><digits>` phones to the `users` form field. The
server queues `add_connect_users.delay(...)` async and 302s back to
opportunity:detail; the atom returns `status: 'queued'`.

This unblocks Phase 5 `app-screenshot-capture`: previously
`connect-opp-setup` Step 8 documented `connect_send_llo_invite` as the
test-user pre-invite call, but that atom invites LLO partner orgs to
*programs* (different URL, different form, different semantics) and
couldn't actually send an FLW phone invite. The result was that every
new opp had its FLW invite either skipped (causing PersonalID
registration to time out — Sentry CONNECT-ID-3F) or done by hand via
the Connect UI.

Step 8 now uses the new atom end-to-end with no manual fallback.

### Added

- `connect_send_flw_invite` atom (`mcp/connect/`):
  - `capability-map.ts` — atom count 19 → 20
  - `client.ts` — `sendFlwInvite` interface method
  - `backends/composite.ts` — Playwright routing
  - `backends/playwright.ts` — POST to user_invite/, parses 200-with-
    errorlist responses via the existing `validationErrorFromHtml`
    helper so callers get a structured `ConnectValidationError` (with
    field-keyed errors like `users: ["Phone numbers must…"]`) on
    setup-incomplete / ended / bad-format rejections instead of an
    opaque 200 success
  - `connect-server.ts` — `connect_send_flw_invite` MCP tool with zod
    validation that each phone matches `^\+\d+$`
- Unit tests: composite-routing test and updated capability-map atom
  count assertion

### Changed

- `skills/connect-opp-setup/SKILL.md` Step 8 — switched from
  `connect_send_llo_invite` (wrong atom) to `connect_send_flw_invite`,
  removed the "operator may need to manually invite" carve-out, and
  documented the `is_setup_complete` constraint that requires Step 8
  to run after Steps 4–7.
- `playbook/integrations/connect-api.md` — Invites section bumped
  from 2 to 3, with usage notes on which atom invites partner orgs vs
  FLWs.

## 0.10.34 — 2026-04-30

**Producer-side verdict validation script + 2 new provisional eval rubrics + HQ-domain doctor check.**

Round 2 of the turmeric-driven eval framework cleanup. 0.10.28 introduced
`parseVerdictYaml` for in-test validation; 0.10.34 ships the operator-side
counterpart (`validate-opp-verdicts.ts`) plus two new eval rubrics that
absorb run_time_followups items 2 (CCZ regex) and 10 (widget paste-in HITL).

### Added

- `scripts/validate-opp-verdicts.ts` — fetches `ACE/<opp>/verdicts/`
  from Drive and runs `parseVerdictYaml` on every YAML. Reports
  PASS/FAIL per file. Reuses the canonical SA-key resolution pattern
  (env → plugin-data-dir → home-data fallback → legacy) so it works
  from a worktree, not just the cache path.
- `bin/ace-doctor verdicts <opp-name>` sub-command — wraps the script
  above. Operators run it after a full opp cycle to catch any verdict
  drift before downstream consumers (opp-eval, future tooling) trip.
- `npm run validate:verdicts -- <opp-name>` — same script, npm-script form.
- `skills/app-release-eval/SKILL.md` — provisional rubric. 4 dimensions:
  both_apps_released (0.35), ccz_marker_integrity (0.25),
  build_id_traceability (0.20), deliver_units_enumerable (0.20).
  Step 4 explicitly distinguishes CCZ-regex false-positives (skill bug,
  surfaces as `[WARN]`) from real missing markers (real defect,
  deducts). Absorbs run_time_followups item 2.
- `skills/ocs-widget-handoff-eval/SKILL.md` — provisional rubric.
  4 dimensions: widget_url_resolves (0.25), connect_opp_link (0.20),
  operator_instructions_clarity (0.30), credential_hygiene (0.25 —
  with auto-fail on global-secret leak). Grades the staging artifact;
  the paste-in itself is HITL until CCC-301. Absorbs item 10.
- `bin/ace-doctor` — new `hq_domain` env-drift check. Warns when
  `ACE_HQ_DOMAIN` is unset or != `connect-ace-prod`. Defensive
  complement to 0.10.31's 1Password routing (which fixed the source;
  this catches "operator forgot to add the `domain` field to the
  1Password item").

### Schema-normalized 4 pre-existing turmeric verdicts on Drive

The verdicts written during the live-run all drifted from the schema in
different ways. Content (scores, notes, prompts) preserved verbatim;
only structural fields normalized:

- `ocs-chatbot-eval-quick.yaml` + `ocs-chatbot-eval-deep.yaml` — added
  required `weight:` to every dimension. Reproduced canonical weights
  from the skill spec.
- `training-materials.yaml` — `scores:` → `dimensions:`; dropped
  `mode: standard` (off-enum); kept content + caveats.
- `app-screenshot-capture.yaml` — `verdict: blocked` → `verdict: incomplete`
  (canonical for "structural gap prevents grading"); dropped `mode: blocked`
  (also off-enum). All 8 turmeric verdicts now pass `validate:verdicts`.

### Fixed (existing test breakage from 0.10.31)

- `test/skills/nova-contracts.test.ts` "does not commit a literal HQ
  project space" assertion was failing on origin/main since 0.10.31
  routed `ACE_HQ_DOMAIN` through 1Password (`op://...` reference).
  Updated the assertion to allow `op://...` while still rejecting
  bare-string literals like `connect-ace-prod`.

### Caught by the new validator

The first run of `validate:verdicts turmeric` immediately surfaced a
schema bug in 0.10.28's own `connect-program-setup-eval.yaml`: a
`per_item` entry with `score: null` (used to encode INFO-SKIPPED).
Per the schema doc, `per_item` entries are by definition graded —
INFO-SKIPPED belongs only in `auto_surfaced`. Fixed in place; verdict
now validates cleanly. Class-level lesson: the validator is doing what
0.10.13's SKILL.md walker can't.

### Test counts

277 passing / 29 skipped (was 275 / 29 in 0.10.28). +2 from the new
eval-skill drift checks (0.10.13 walker auto-discovers them).
`validate:verdicts turmeric` reports 8/8 PASS.

### Why this matters

The chain is now end-to-end:
- Schema: `lib/verdict-schema.ts` (single source of truth).
- Docs: `skills/README.md § Verdict YAML shape`.
- Doc examples: caught by 0.10.13 walker on every commit.
- Real verdict files (test fixtures): caught by 0.10.28 unit test.
- Real verdict files (live opp): caught by 0.10.34 `validate:verdicts`
  / `ace-doctor verdicts <opp>` on operator demand.

Future class-level preventer: pre-write validation in
`drive_create_file` when filename matches `verdicts/*.yaml`.

## 0.10.33 — 2026-04-29

**Mobile recipe progress + two class-level gotchas documented.**

Live AVD discovery pass against CommCare 2.62.0 (registered ACE test
user on `ACE_Pixel_API_34_PS`) calibrated the first half of
`connect-claim-opp.yaml` (home → Opportunities → opp list) and
surfaced two class-level gotchas worth documenting now even though
neither is fully fixable in a code change today.

### Changed

- `mcp/mobile/recipes/static/connect-claim-opp.yaml` —
  `home_screen_root` → `org.commcare.dalvik:id/screen_first_start_main`,
  `opportunities_tab` → `text: "Opportunities"`. Adds a
  `runFlow.when` step that handles the post-registration
  `BiometricPrompt` (system credential dialog) by entering `${PIN}`
  when `com.android.systemui:id/lockPassword` is visible, then
  asserts the opp-list root `connect_fragment_jobs_list`. Second
  half (accept-invite / handoff) still REPLACE_* — needs an FLW
  invite on `${ACE_E2E_PHONE}` to drive, and there is no MCP atom
  for FLW program invites yet (only LLO invites via
  `connect_send_llo_invite`).
- `playbook/integrations/mobile-integration.md` — recipe table
  marks `connect-claim-opp.yaml` as **partial** instead of pure
  scaffold. New `### Unlock PersonalID gate` section documents the
  `BiometricPrompt` cross-package transition and the recommended
  `runFlow.when` pattern. New `### aapt is required by
  mobile_install_apk` section documents the `build-tools` gap that
  bites every fresh workstation: homebrew's
  `android-commandlinetools` doesn't include `build-tools/`, so
  `aapt` isn't on PATH and `mobile_install_apk` fails with
  `spawn aapt ENOENT`. Quick `sdkmanager "build-tools;34.0.0"` +
  symlink fixes it; longer-term fix is to make
  `AvdBackend.installApk` search `$ANDROID_HOME/build-tools/*/aapt`.

## 0.10.32 — 2026-04-29

**Fix `.env.tpl` ACE_E2E_* vault reference.**

The mobile-emulation block added in 0.10.0 referenced
`op://ace/connect-test-user/...`, but the `ace` vault doesn't exist in
Dimagi's 1Password — it was added speculatively without creating the
backing item. `op inject` silently no-op'd those lines, leaving the
installed `.env` without any `ACE_E2E_*` keys. New mobile sessions
hit this on first registration: the test-user credentials are missing
and `mobile_register_test_user` can't run.

### Changed

- `.env.tpl` — `ACE_E2E_PHONE`, `ACE_E2E_PHONE_LOCAL`,
  `ACE_E2E_COUNTRY_CODE`, `ACE_E2E_PIN`, `ACE_E2E_BACKUP_CODE` now
  point at `op://AI-Agents/connect-test-user/...` to match the
  established pattern for all other ACE secrets. The corresponding
  1Password item was created today in the `AI-Agents` vault with the
  test-user credentials recovered from the prior `android-erui0`
  session log (`+74260000100`, PIN `111111`, backup `222222`).
  **Operator action:** re-run
  `op inject -i .env.tpl -o ~/.claude/plugins/data/ace-ace/.env --account dimagi.1password.com -f`
  to populate the keys.

## 0.10.31 — 2026-04-29

**Three small post-e2e fixes lifted from the turmeric run.**

The `e2e-xw5gk` turmeric run surfaced three friction points worth
fixing class-level so the next e2e doesn't hit them. None are bug
fixes; all are docs / contract tightenings.

### Changed

- `.env.tpl` — `ACE_HQ_DOMAIN` now points at
  `op://AI-Agents/ACE - CommCareHQ/domain` (1Password-sourced) instead
  of being a literal-empty string. **Operator action required:** add a
  `domain` field to that 1Password item with your deployment value
  (e.g. `connect-ace-prod` for production), then `op inject`. The
  turmeric run hit this as an empty-string mid-run workaround;
  routing through 1Password keeps the convention "values live in
  1Password, template references them."
- `agents/ocs-setup.md` § Step 3 — explicit prohibition on the Phase 4
  agent flipping `gates.ocs-chatbot-eval-deep` in `state.yaml`. The
  turmeric run's Phase 4 subagent auto-approved its own gate, which
  bypassed the operator review the gate was designed to force.
  Subagent's job ends at "gate brief written"; the orchestrator (or
  the operator in review/default mode) flips the gate.
- `skills/app-release/SKILL.md` § Step 6 — fix the CCZ-marker verify
  regex. Old pattern (`<learn:(deliver|module|task|assessment)`) looks
  for a `learn:` namespace prefix; Nova actually emits the elements
  with a default `xmlns="http://commcareconnect.com/data/v1/learn"`
  attribute. New pattern matches the actual XML shape, with an
  example block showing what the markup looks like in a released CCZ.
  Caught during turmeric run by manual re-verify.

## 0.10.30 — 2026-04-29

**Correction: Agent dispatches don't parallelize — revert parallel-Nova claim.**

0.10.21 (and follow-ups in 0.10.29) claimed `pdd-to-learn-app` and
`pdd-to-deliver-app` could run in parallel by placing two `Agent`
tool-use blocks in a single assistant message. That was wrong:
Claude Code does not reliably parallelize `Agent` dispatches in this
environment, so the two Nova builds must run sequentially.

The "tool calls in one message run in parallel" pattern is still
correct for regular MCP tool calls (Drive reads, `nova__update_form`,
`connect_create_payment_unit`, etc.) — that part of the Performance
Conventions stands. The mistake was extending it to `Agent(...)`
dispatches, which behave differently.

### Changed

- **`agents/commcare-setup.md` Step 1** rewritten: Learn and Deliver
  Nova builds run sequentially, with explicit "halt before Deliver if
  Learn fails" guidance to avoid wasting another ~10 min of Nova time
  on a known-bad spec. The ~7-min "wall-clock save" claimed in
  0.10.21 is removed; sequential is now the lower bound on Phase 2.
- **`agents/ace-orchestrator.md` § Performance Conventions** clarifies
  the parallelism rule explicitly: regular tool calls batch in one
  message; `Agent(...)` dispatches do not, and must be treated as
  serial. Applies across any future cross-phase orchestration too.

### Why

Operator caught the mistake in review. The original e2e session
review surfaced 8 findings; finding #4 ("parallel Nova dispatch") was
based on observing serial Nova builds and assuming the harness
supported batched Agent calls. It doesn't. Reverting the claim keeps
the doc honest and stops a future operator from chasing a phantom
"why isn't this batching?" debug session.

The other 7 findings stand: ToolSearch hoisting, batched MCP tool
calls (correct — these DO parallelize), inline phase handoffs,
default mode, Connect 5xx surfacing, doctor session_freshness,
ocs-setup resumption contract, defensive Nova turn-0 check.

## 0.10.29 — 2026-04-29

**Defensive Nova post-dispatch check + ocs-setup resumption contract.**

Two follow-ups to the e2e-session review: a workaround for upstream
Nova issue #2 (turn-0 halt), and an explicit resumption contract for
Phase 4 to recover cheaply from mid-phase context loss.

### Changed

- **`agents/commcare-setup.md` Step 1** adds a "Turn-0 halt detection"
  subsection. After every Nova `Agent` dispatch, verify a new app
  appeared (via Agent return string or `nova:list`); if not,
  re-dispatch once. After two failures, surface a hard error with
  `voidcraft-labs/nova-plugin#2` in the message. Bridges until
  upstream `/nova:autobuild` refuses to return without ≥1 tool call.
- **`agents/ocs-setup.md`** adds a **`## Resumption Contract`** section.
  Documents per-step "done-when" artifacts and the read-state-and-skip
  pattern so a fresh-dispatched ocs-setup doesn't re-clone the bot,
  re-index the RAG collection, or re-run the deep qa+eval. Motivated
  by the 2-hour gap observed in `e2e-xw5gk` after Phase 4 was
  abandoned and re-dispatched.

### Why

Nova issue #2 was filed today, but the upstream fix hasn't shipped —
the ACE-side defensive check is a 15-line procedure-doc edit that
costs ~30 seconds per dispatch and saves ~8 minutes per occurrence.

ocs-setup's resumption contract codifies what `ocs-agent-setup` already
documented as idempotent (Step 1) and extends it across all four
steps. State.yaml already tracks step-level completion; the agent
just needs to read it and skip done steps. Without the contract, a
fresh-dispatched Phase 4 would re-do ~20–30 minutes of work that
already completed.

## 0.10.28 — 2026-04-29

**Producer-side verdict schema preventer.**

Surfaced by the `turmeric` opp e2e: the 0.10.13 preventer caught drift
in *eval-skill SKILL.md examples*, but actual verdict YAML files
written by the producing skills drifted in three concrete ways:

1. `app-screenshot-capture/SKILL.md` had no YAML example. The producer
   invented `verdict: blocked` and `mode: blocked` — neither in the
   schema enum.
2. `training-materials/SKILL.md` didn't mention verdict-writing at all.
   The producer wrote `scores:` instead of `dimensions:`, set
   `mode: standard` (not in `quick|deep|monitor`), and dropped required
   `weight:` fields.
3. The `ocs-chatbot-eval` *spec* was clean, but the actual
   `ocs-chatbot-eval-{quick,deep}.yaml` written on Drive omitted
   `weight:` from every dimension.

The 0.10.13 walker only sees doc examples. The *real* verdicts on Drive
were never validated by anything outside `test/lib/verdict-schema.test.ts`.

### Added

- `lib/parse-verdict.ts` — `parseVerdictYaml(source)` parses YAML and
  runs `validateVerdict()`. Returns structured `{ ok, errors, parsed,
  parseError }`. Ready for `/ace:doctor verdicts <opp>` to consume
  against live Drive folders.
- `test/lib/real-verdict-validation.test.ts` — walks every
  `test/fixtures/**/verdicts/*.yaml`, asserts each passes
  `parseVerdictYaml`. Six unit tests of the parser itself: rejects
  `verdict: blocked`, catches missing `weight:`, accepts numeric
  `target:` and `null` dimension scores.
- `yaml@^2.8.3` dep — needed to parse real verdict files.

### Fixed (producer SKILL.md drift)

- `skills/app-screenshot-capture/SKILL.md` — added a schema-conforming
  verdict YAML example with both graded and `incomplete`-mode forms.
  Documents canonical 4 dimensions (`coverage`, `execution`,
  `artifact_quality`, `manifest_integrity`). Explicit prose:
  *NEVER use `verdict: blocked` (off-schema)*.
- `skills/training-materials/SKILL.md` — added a verdict YAML example
  (had no verdict-write section). 5 canonical dimensions with weights
  + an explicit screenshots-pending branch (when
  `app-screenshot-capture` came back `incomplete`, this skill keeps
  grading content fidelity rather than escalating).

### Schema additions

- `DimensionSchema.score` nullable. Matches `opp-eval`'s documented
  partial-coverage intent. Per-skill rubrics never emit null — they
  grade or set top-level `verdict: incomplete`.
- `VerdictSchema.target` accepts `string | number`. Real targets are
  often numeric IDs (experiment_id, opportunity_id, nova_app_id);
  YAML parses unquoted integers as numbers.

### Fixed (existing fixtures)

- `test/fixtures/CRISPR-Test-003-Turmeric/verdicts/ocs-chatbot-eval-deep.yaml`
  — migrated `per_prompt:` → `per_item:` (canonical since 0.4.3).

### Test counts

275 passing / 29 skipped. +8 verdict-validation tests + 2 schema tests
for nullable/numeric cases.

### Why this matters

Class-level preventer at the *producer* boundary. Same shape as 0.10.13
but covers actual files, not doc examples. The chain: schema ↔ docs ↔
SKILL.md examples (0.10.13) ↔ real verdict files (0.10.27).

### Known follow-up

`/ace:doctor verdicts <opp>` doesn't exist yet. Plumbing is in place;
adding the sub-command is the natural next class-level preventer release.

## 0.10.27 — 2026-04-29

**Hardened post-boot prep + documented `-wipe-data` recovery for stuck-FallbackHome AVDs.**

### Changed

- **`AvdBackend.runPostBootPrep` storage readiness check.** The boot
  wait now polls `test -e /storage/emulated/0` instead of
  `test -d /sdcard`. The latter fails under Android's scoped-storage
  permission model even when user storage is fully mounted — the
  shell uid can't read the symlink target, only its existence. The
  new check passes as soon as user storage is actually available,
  which is the real readiness signal for `pm` and `dumpsys` calls.

### Documented

- **`playbook/integrations/mobile-integration.md` § Stuck-FallbackHome
  recovery.** Some `google_apis*` AVD cold boots leave
  `mFocusedApp=com.android.settings/.FallbackHome` permanently —
  NexusLauncher never resolves as the default `HOME` activity, every
  Maestro `launchApp` times out, and `runPostBootPrep`'s recovery
  attempts (status-bar collapse, dismiss-keyguard, KEYCODE_HOME)
  don't break the wedge once the package manager has registered
  FallbackHome as the default. Recovery: cold-boot with
  `-wipe-data -no-snapshot-load -no-snapshot-save`. Live-verified on
  `ACE_Pixel_API_34_PS` after a 3-reboot stuck-cycle today. Costs:
  user data wipe (CommCare uninstall + test user re-registration),
  but `mobile_save_snapshot` after the next clean registration locks
  the recovered state in for future sessions.

### Why

The 0.10.26 prep code's `test -d /sdcard` was returning false even
on healthy boots because of scoped-storage permissions, so the
helper was timing out at 120s when storage was actually ready in
~10s. Switching to `/storage/emulated/0` is a no-op on healthy boots
and correctly detects readiness on cold ones.

The `-wipe-data` finding is the missing piece for "AVD got stuck,
how do I get unstuck?" — surfacing it as a documented escape hatch
saves the next operator the 30+ min I spent today figuring out that
no amount of prep tweaking would bring back NexusLauncher once
FallbackHome had latched onto the HOME intent.

## 0.10.26 — 2026-04-29

**Auto-run face-capture prep + recover from NotificationShade quirk during AVD boot.**

### Added

- **`AvdBackend.runPostBootPrep` runs after every `ensureAvdRunning`
  cold boot.** Idempotent best-effort prep that:
  - Waits up to 90s for `sys.boot_completed=1` (the device is reachable
    by `adb devices` long before `pm` and `dumpsys` calls succeed; the
    earlier code raced and led to silent prep failures).
  - Disables Google Play Services via `pm disable-user --user 0
    com.google.android.gms` so `MicroImageActivity` falls back to
    `ManualMode` and exposes `camera_shutter_button`. Eliminates the
    one operator step that mobile-bootstrap.md previously asked for in
    step 9. Re-enable manually with `pm enable com.google.android.gms`
    if any future ACE skill needs GMS.
  - Pre-grants `android.permission.CAMERA` to `org.commcare.dalvik` if
    the package is installed. Skips silently if it isn't (most cold
    boots — bootstrap installs CommCare later).
  - Detects the post-cold-boot NotificationShade quirk
    (`mCurrentFocus=Window{...NotificationShade}` on `google_apis*`
    images on macOS) and recovers via `wm dismiss-keyguard` +
    `KEYCODE_HOME`. Skips silently when focus is already on a normal
    activity. Without this, maestro's first `launchApp` against a
    cold-booted AVD would race against the stuck shade and time out.

All four steps are best-effort — any failure logs and continues. The
boot itself never fails just because GMS-disable couldn't run on a
device that lacks the package, etc.

### Why

0.10.22's bootstrap doc told operators to run two adb commands manually
before registration. That's an easy step to forget, and the failure
mode (registration stalls on auto-shutter) is non-obvious — burned a
whole session today figuring out the GMS-disable lever was the actual
fix. Baking the prep into `ensureAvdRunning` makes the bypass
structurally invisible: every fresh AVD boot is registration-ready
without operator memory. Same theme as 0.10.18's `hw.camera.front`
auto-patch — class-level preventer over instance-level fix.

The NotificationShade quirk is the one thing that blocked the live
e2e verify in 0.10.22. Codifying the recovery here means the next
session shouldn't lose time to it again.

## 0.10.25 — 2026-04-29

**Connect 5xx errors now surface the real Django exception; doctor catches stale-session-after-update.**

Two related fixes for the "Connect HTTP 500 retry storm" pattern
observed in `new-e2e-25bff` (6 attempts, ~25 min lost). The root cause
is two-part: bad error visibility on 5xx responses, and a stale-MCP
session after `/ace:update` that surfaces as "No such tool available."

### Added

- **`summarizeServerErrorBody(body, contentType?)` in
  `mcp/connect/errors.ts`.** When Connect returns a 5xx, the body is
  typically a Django HTML page — debug stack trace in dev, generic
  "Server Error (500)" in prod, sometimes a Sentry event id embedded
  in JS init. The previous behavior sliced the first 200 chars of the
  body into the error message, which surfaced
  `<!DOCTYPE html><html><head>...` and was useless for triage.
  The new helper extracts (in order): JSON `detail`/`error`/`message`
  fields, Django technical-500 `<pre class="exception_value">` plus
  exception type, generic-500 `<title>` + `<h1>` + Sentry event id,
  or a stripped-tags fallback. Capped at ~300 chars.
- **`HttpError` constructor accepts an optional `contentType` arg** —
  used by the summarizer to detect JSON bodies. Backward-compatible
  with all existing call sites (none pass the 4th arg).
- **9 new unit tests in `test/mcp/connect/unit/errors.test.ts`**
  covering JSON error bodies, Django technical-500 pages, generic-500
  pages, Sentry event id extraction, character cap, plain-text
  fallback, and the HttpError integration.
- **`bin/ace-doctor` adds a `session_freshness` check.** Compares the
  running plugin's `VERSION` against `installed_plugins.json`'s recorded
  version. Mismatch surfaces as `WARN session_freshness` with the
  actionable fix: run `/reload-plugins` or restart the session, since
  MCP servers don't pick up a new version until reload. The canonical
  symptom of this class is "No such tool available: connect_*" right
  after `/ace:update` — observed in `new-e2e-25bff` at 12:10.

### Changed

- **`mcp/connect/backends/playwright.ts` `httpErrorFor`** now passes
  the response Content-Type header through to `HttpError`, so the
  summarizer can identify JSON bodies even when the body bytes don't
  start with `{`.

### Why

`new-e2e-25bff` had 6 distinct `connect_create_opportunity` failures,
each followed by a `connect_list_opportunities` recovery probe and a
fresh retry — 4 of them on HTTP 500, plus a "tool not available" after
a mid-session `/ace:update`. The 500 retry storm cost ~25 min of
wall-clock; the underlying Django exception was invisible to the agent
because the error message was just `HTTP 500 POST /a/.../opportunity/init/:
<!DOCTYPE html><html><head><title>` with the actual exception type
buried 4kb into the body. The agent now sees the real error and can
make a real triage decision (retry vs reauth vs filing a Connect
issue).

The doctor `session_freshness` check is the class-level preventer for
the post-update tool-loss symptom — same pattern as the 0.7.1
`ocs_shared_collection_team` probe and 0.5.18 Drive Shared-Drive guard.

## 0.10.24 — 2026-04-29

**New default `/ace:run` mode — keep going until external communication.**

Adds a third execution mode, `default`, and makes it the default for
`/ace:run`. Replaces the old "pause at every gate" default with one
that matches the way the team actually operates: trust the eval
verdict for internal phases, halt only on real blockers, and stop
unconditionally before any action that touches an outside party.

### Added

- **`default` mode** — the new default. Auto-proceeds through the
  three internal gates (`idea-to-pdd`, `app-deploy`,
  `ocs-chatbot-eval-deep`) when the gate brief contains no
  `[BLOCKER]` concern. Always pauses at the Phase 5→6 transition
  (the external-communication boundary) and at every Phase 6/7 step
  whose action affects an external party — `llo-invite`,
  `llo-onboarding`, `llo-uat`, `llo-launch`, and `opp-closeout`.
  Hard errors halt regardless of mode.

### Changed

- **`commands/run.md`** — `--mode` argument now accepts
  `default|review|auto`; default value flips from `review` to
  `default`. Each mode's intent documented inline.
- **`agents/ace-orchestrator.md`** — `## Execution Modes` rewritten
  to define the three modes with concrete per-phase behavior. New
  `## Gate Brief Contract` per-mode pause matrix table makes the
  default vs review vs auto behavior explicit at every named gate.
  `## Between Phases` and `## Error Handling` updated for the
  three-mode world.
- **State schema** — `mode: default|review|auto` (was
  `mode: review|auto`). `state.yaml` default value flips to `default`.
- **`commands/status.md`** — mode column displays
  `default/review/auto` (was `auto/review`).

### Why

Observed in today's e2e session (`e2e-xw5gk`): a 36-minute idle gap
mid-Phase-1 waiting for a `idea-to-pdd` gate approval. Phases 1–5
are entirely internal — Nova builds in private Firestore,
`app-deploy` uploads to a Dimagi-controlled project space, OCS
chatbots are configured but not yet linked to FLWs. Operators
historically rubber-stamped these gates 95%+ of the time when the
eval rubric passed cleanly. `default` mode lets the eval verdict be
the decision-maker for internal gates while preserving
"human-in-the-loop on every external touch" for Phases 6–7. The
existing `review` mode stays available as an opt-in for high-touch
operations or training; `auto` stays available for unattended
batch runs.

## 0.10.22 — 2026-04-29

**Face-capture gate has a real bypass — disable GMS at runtime.**

### Discovered

- **The photo IS required, but the content isn't validated.**
  - Client (`PersonalIdPhotoCaptureFragment` /
    `ApiPersonalId.setPhotoAndCompleteProfile`):
    `Objects.requireNonNull(photoAsBase64)` and SAVE PHOTO is disabled
    until a capture exists.
  - Server (connect-id `users/views.complete_profile`): rejects with
    `MISSING_DATA` (HTTP 400) if `photo` is empty/missing, then calls
    `upload_photo_to_s3(photo, user.username)` without content
    validation.
  - **Conclusion:** any non-empty bytes from the AVD's emulated camera
    satisfy both checks. Face detection lives entirely in the client as
    the auto-shutter trigger.

- **The auto-shutter / manual-shutter branch is GMS-driven at runtime,
  not AVD-image-driven.** Both `google_apis` and `google_apis_playstore`
  system images on macOS Apple Silicon ship a functional
  `com.google.android.gms` package, so
  `GoogleApiAvailability.isGooglePlayServicesAvailable` returns SUCCESS
  on both — the auto-shutter path is taken regardless. The actual lever
  is `pm disable-user --user 0 com.google.android.gms`, which flips
  `MicroImageActivity` into `ManualMode` and exposes
  `camera_shutter_button` for Maestro to tap.

### Changed

- **`connect-register-from-otp.yaml`** updated to tap
  `camera_shutter_button` after `take_photo_button`, then
  `save_photo_button` after the captured-image preview returns to the
  intro screen. The old "wait for AOSP camera Done button" steps are
  gone — they were based on an incorrect assumption that
  MicroImageActivity launched the system camera; in fact CommCare 2.62.0
  ships its own CameraX-based capture activity.
- **Header AVD prerequisites updated** to require runtime GMS disable
  + pre-granted CAMERA permission, with the exact `adb` commands.
  Pointers to the integration doc for full reasoning.
- **`commands/mobile-bootstrap.md` step 9** is the new pre-flight (run
  the two `adb shell pm` commands) before step 10 (the existing
  `mobile_register_test_user` call). Steps 10/11/12 renumbered.
- **`playbook/integrations/mobile-integration.md` § Face-capture gate**
  rewritten with source citations from `MicroImageActivity.onCreate`
  and `connect-id users/views.py`. Walks through why the photo content
  doesn't matter and why the GMS-availability branch is the lever.
- **0.10.20's "use a non-GMS AVD" recommendation reverted.** The system
  image choice doesn't affect this on macOS — both ship GMS.

### Why we haven't live-verified the full path

Live verification stalled on an AVD UI quirk (NotificationShade focus
stuck post-cold-boot, blocking maestro). The recipe is correct by
construction from the source — `MicroImageActivity.onCreate` directly
shows the conditional, `micro_image_widget.xml` declares the shutter
button, `setPhotoAndCompleteProfile` shows the API call shape, and
`complete_profile` (connect-id) shows the server contract. Operators
running `mobile-bootstrap` from scratch should hit the new path; if
something diverges, the `--debug` artifacts from a failing maestro run
plus a `mobile_capture_ui_dump` of MicroImageActivity will pinpoint it
in seconds.

### Why this matters in context

The user's intuition that "the picture isn't really required" was
half-right: any picture works, you just can't skip taking one. ACE's
production path doesn't depend on this either way — Phase 5
`training-prep` opens deployed CommCare apps directly. This release
clears the only remaining barrier to a fully-automated bootstrap from
a fresh AVD.

## 0.10.21 — 2026-04-29

**Speed wins from e2e session review — parallel dispatch + inline phase handoffs.**

Session review of today's `e2e-xw5gk` and `new-e2e-25bff` runs surfaced
four low-risk wall-clock wins. Each is a prose-only edit to an
agent/skill markdown file; no MCP changes, no schema changes.

### Changed

- **`agents/commcare-setup.md` — Step 1 hardens parallel Nova dispatch.**
  The doc previously said the two `pdd-to-*-app` skills "can run in
  parallel"; observed behavior was serial (~15 min Learn, then ~13 min
  Deliver, ~7 min wasted). Step 1 now requires both `Agent` calls in a
  single assistant message and spells out why the topology is safe
  (each Nova architect is a level-1 subagent dispatched from the
  inline-executed level-0 procedure). Saves ~7 min per opp.
- **`skills/app-connect-coverage/SKILL.md` — Step 4 batches `update_form`
  mutations.** Observed in `new-e2e-25bff`: 12 sequential
  `nova__update_form` calls in 30s. Skill now instructs to dispatch
  all mutations for an iteration in one message, then re-fetch all
  forms in one message. Saves 20–40 sec per coverage pass.
- **`agents/ace-orchestrator.md` — new "Performance Conventions"
  section.** Codifies three rules: (1) pass PDD + previous gate brief
  + state.yaml inline at phase handoff (kills the per-phase Drive
  re-read churn — observed PDD doc fetched 3× in 37 min in
  `e2e-xw5gk`); (2) pre-load common MCP atoms with one batched
  `ToolSearch` per phase instead of 5–10 scattered lookups (observed
  11 ToolSearch calls in one session); (3) batch independent tool
  calls in a single assistant message. Combined ~30–90 sec wall-clock
  + meaningful token savings per run.

### Why these specifically

The full review surfaced 8 findings; this release ships only the
four whose fix is mechanically clear and confined to prose. Three
deferred for separate PRs: batched `AskUserQuestion` audit per phase
(needs scope review), Connect HTTP 500 surfacing in
`mcp/connect/backends/composite.ts` (needs live probing), and Nova
turn-0 heartbeat detection (needs a reliable signal). Total ceiling
on shipped changes: ~10 min wall-clock + token churn per opp; ~50 min
ceiling on the deferred items if they all land.

## 0.10.20 — 2026-04-29

**Documented face-capture gate as known limitation.**

### Discovered

- **CommCare 2.62.0 added a `MicroImageActivity` face-capture screen.**
  Live verification of the optimized 0.10.19 loop drove registration
  through 28 of 30 recipe steps successfully (App Lock → PIN setup →
  unlock → name → backup code → photo step initiates → face viewfinder
  loads). The final two steps (`save_photo_button` after auto-shutter)
  require a face that the AVD's emulated front camera doesn't supply
  — `hw.camera.front=emulated` shows a moving gray test pattern, not a
  human face, and CommCare's auto-detect-and-shutter logic never
  triggers. `virtualscene` mode wouldn't help either; it renders an
  empty 3D office without a person.

### Documented

- **`playbook/integrations/mobile-integration.md` — new "Face-capture
  gate" gotcha** explains the barrier honestly: the phone IS registered
  server-side at this point, but the local CommCare session is blocked.
  Three hypothetical workarounds (host webcam, gRPC image stream,
  server-side demo bypass) are listed with their tradeoffs; none are
  implemented in 0.10.x.
- **"What's not yet built" expanded** to call out the face-capture
  bypass as a deferred item, and to note that this gate does NOT block
  ACE Phase 5 `training-prep` (which opens deployed CommCare apps
  directly, not via the registration flow).

### Why it's fine for ACE production

The Phase 5 `training-prep` use case opens a *deployed* CommCare app
directly to capture screenshots — no registration flow, no face capture.
The blocked path is only the one-time fresh-AVD bootstrap, which is
documented in `commands/mobile-bootstrap.md` as needing a pre-registered
test phone (the operator handles registration manually once or
re-uses an existing snapshot). 0.10.18's `mobile_save_snapshot` atom is
the durable workaround: register once on a real device or via manual
operator-driven photo capture, snapshot the AVD, restore on every
future run.

## 0.10.19 — 2026-04-29

**Optimized mobile selector-discovery workflow.**

### Changed

- **`playbook/integrations/mobile-integration.md` — selector discovery
  loop rewritten.** Recommends `maestro studio` (interactive selector
  picker) over the dump-and-grep loop, `mobile_capture_ui_dump` over
  `adb shell uiautomator dump` + `adb pull` + `grep`, and snapshot-driven
  iteration (load a `registered-test-user` snapshot in ~3s instead of
  replaying the 4-minute registration flow). New "Performance &
  efficiency" subsection codifies the screencap-Read PNG anti-pattern:
  almost every CommCare/PersonalID selector is resource-id-driven, so the
  uiautomator XML alone is enough — reserve screenshots for genuinely
  visual states like the AOSP camera UI.
- **`commands/mobile-bootstrap.md`** adds a recommended
  `mobile_save_snapshot` step after first registration, so future
  discovery sessions don't re-pay the 4-minute setup cost.

### Why

A self-review of the 0.10.18 live-verification session found ~15
iterations of (screencap → Read PNG → uiautomator dump → grep → edit
recipe → re-run). The PNG reads were the main context burn and the
re-runs were the main wall-clock burn — both avoidable with the atoms
already shipped in 0.10.18. This release just makes the optimized
workflow the documented default.

## 0.10.18 — 2026-04-29

**End-to-end Android control: camera auto-fix, snapshots, cross-platform Java, dropped OTP path.**

### Added

- **`mobile_save_snapshot` / `mobile_load_snapshot` atoms.** Wraps
  `adb emu avd snapshot save|load <name>`. Lets a register-once setup be
  restored on every test run in seconds rather than re-driving the full
  PersonalID flow each time. 12 atoms total now (was 10).
- **`AvdBackend.ensureFrontCameraEmulated()` runs before every boot.**
  Reads `~/.android/avd/<NAME>.avd/config.ini`, rewrites
  `hw.camera.front=none` (the default Pixel 7 template ships this) to
  `hw.camera.front=emulated`, and appends the key if missing. Idempotent —
  returns false if already correct. Without this fix CameraX silently
  fails LENS_FACING_FRONT validation and the photo step in CommCare
  PersonalID registration no-ops with no UI signal. Closes Gap 1 from the
  4/29 punch list.
- **Platform-aware `JAVA_HOME` resolution in `defaultShell`.** Resolves a
  JDK 17 home for macOS (`/usr/libexec/java_home -v 17`, then homebrew),
  Linux (`/usr/lib/jvm/java-17-openjdk-*`), and Windows
  (`%ProgramFiles%\Eclipse Adoptium\jdk-17.*`). Operator override via
  `export JAVA_HOME=...` still wins. Closes Gap 5.
- **`playbook/integrations/mobile-integration.md`.** Mirrors
  `ocs-integration.md` / `connect-api.md`. Architecture, atom inventory,
  what's verified vs. scaffolded, recipe vocabulary, the three durable
  gotchas (pre-invite, front camera, GMS phone-hint sheet), and the
  selector-discovery loop.

### Changed

- **`commands/mobile-bootstrap.md`** now has a per-platform install matrix
  (Maestro / adb / emulator+AVD / JDK 17 / AVD home) covering macOS,
  Linux/WSL2, and Windows native. Step 3 no longer asks the operator to
  hand-edit `config.ini` — auto-patched by `mobile_ensure_avd_running`.
- **`mobile_register_test_user` no longer fetches an OTP.** The +7426
  demo-bypass is the only registration path ACE maintains; Connect-id
  short-circuits OTP delivery for that range and surfaces a "demo user,
  skip OTP" snackbar instead. The static `connect-register-from-otp.yaml`
  recipe drops the `REPLACE_otp_entry` placeholder and runs straight from
  snackbar dismiss → App Lock → name → backup code → photo.
- **`connect-register-from-otp.yaml` handles both screen-lock branches.**
  When the device has no screen lock, the recipe walks
  `Configure PIN → set → confirm → DONE → AGREE & CONTINUE`. When a screen
  lock already exists (e.g., from a prior registration on the same AVD),
  the system jumps straight to the unlock prompt and the recipe skips the
  setup steps via `runFlow.when`.

### Verified

- 219 unit tests pass (was 212; +7 covering camera auto-fix and snapshot
  atoms).
- All 12 capabilities declared in `capability-map.test.ts`.
- All Phase A registration selectors live-verified end-to-end on
  CommCare 2.62.0 / `ACE_Pixel_API_34_PS` (ARM64 google_apis_playstore).
  Phase B (snackbar OK → App Lock → name → backup → photo) selectors
  carried over from the live capture in 0.10.17. Photo step's CameraX
  unblock has been verified at the config-patch level (the helper rewrites
  `hw.camera.front=emulated` correctly) but the post-fix end-to-end
  re-registration was blocked by an AVD secure-buffer state mid-session;
  the next clean cold-boot is the natural verification window.

### Known limitations

- `connect-claim-opp.yaml` selectors still scaffolded (`REPLACE_*`) —
  discovery deferred until a real opportunity is needed in a Phase 5 test
  run.
- Linux and Windows path resolution implemented and unit-tested; first
  operator-machine run welcome.

## 0.10.17 — 2026-04-29

**Live-AVD verification of the PersonalID registration flow.**

- `connect-register-to-otp.yaml` and `connect-register-from-otp.yaml`
  rewritten with real selectors discovered via uiautomator dump on
  CommCare 2.62.0 / `ACE_Pixel_API_34_PS`. `REPLACE_*` placeholders
  removed for every screen except the OTP-entry screen (still TODO —
  needs a non-+7426 phone to discover).
- Captured screens: phone entry → snackbar OK ("demo user, skip OTP")
  → App Lock → system PIN setup → lock-screen redaction → AGREE &
  CONTINUE → system unlock → name → backup code → photo capture.
- `mobile-bootstrap` step 3 now checks `hw.camera.front=emulated`. The
  default AVD config has `front=none`, which silently no-ops the photo
  capture step (CameraX validation fails: "Camera LENS_FACING_FRONT
  verification failed").
- Two server/client bugs surfaced and filed during this work:
  - **CI-643** (P2): Connect-id `/users/start_configuration` worker
    dies with `SystemExit` when the synchronous
    `check_number_for_existing_invites` HTTP call hangs past the
    gunicorn worker timeout. Sentry trail `CONNECT-ID-3F`, 13 events
    over 3 months.
  - **CI-644** (P2): CommCare Android `PersonalIdPhoneFragment.onFailure`
    crashes with NPE on null `sessionData` (line 472), force-stopping
    the app whenever the upstream returns an empty body. Same root
    cause as CI-643 — the empty body comes from the worker abort.
- `connect-opp-setup` already documents the pre-invite mitigation
  (Step 8). For first-time registration on a fresh `${ACE_E2E_PHONE}`,
  pre-invite is required until CI-643 lands — without it the flow
  hits both the server and client bugs in sequence.

## 0.10.16 — 2026-04-29

**Connect MCP: structured form-validation errors + new `connect_register_hq_api_key` atom.**

A real ACE session creating an opportunity for "Turmeric Market Survey —
2026-04-28" burned ~90 minutes diagnosing an opaque HTTP 500. Three separate
payload-shape bugs (hq_server expects int FK, api_key expects int FK,
learn_app/deliver_app must be JSON-stringified `{id, name}` objects) all
surfaced as identical opaque 500s because the Playwright backend wasn't
parsing Connect's form-rejection HTML. The agent had to reverse-engineer each
via curl + headed browser.

### Added

- `connect_register_hq_api_key` MCP atom — registers a CommCare HQ API key
  with Connect via `/opportunity/add_api_key/` and returns the int FK that
  `connect_create_opportunity` and Connect's other forms need. Idempotent:
  if the key is already registered for the given hq_server, the existing
  record is returned. Lets agents verify and debug the FK lookup
  independently of the larger create-opp flow.
- `parseFormErrorsByField` in `mcp/connect/backends/html-scrape.ts` — parses
  Connect's crispy-rendered Django form into a per-field error map. Walks
  each `<div id="div_id_<field>">` block and harvests the `<ul class="errorlist">`
  items inside it; form-level errors land under `__all__`.
- `ConnectValidationError.fieldErrors` — structured `{field: [msgs]}` map
  alongside the existing flat `validationErrors` list. `toJSON()` returns
  `{error: 'validation_error', message, errors, fields}` for MCP responses.
- `test/fixtures/connect-html/opportunity-init-validation-errors.html` —
  regression fixture covering the three real Turmeric-session failures
  plus a non-field error.

### Changed

- `connect_create_opportunity` (and every other Playwright atom that
  POSTs a form) now returns the structured per-field error payload
  instead of letting an opaque HTTP 500 bubble up. Agents can branch
  on `fields.api_key`, `fields.learn_app`, etc. directly.
- `mcp/connect-server.ts` wraps every atom call in `runAtom`, which
  converts `ConnectValidationError` into an MCP response with
  `isError: true` and the structured JSON body — so the error shape
  is consistent across all atoms.
- `capability-map.ts` now lists 19 atoms (was 18). New entry:
  `register_hq_api_key`.

## 0.10.15 — 2026-04-29

**Doc fix: name the canonical `.env` location so agents stop hunting.**

CLAUDE.md told future sessions how to *generate* `.env` (`op inject`)
and that 1Password owned the values, but never said *where the
installed `.env` lives*. When an orchestrator session needed to inspect
env state, it would walk through `~/.claude/plugins/cache/`, the
worktree, and the parent shell before finding the file at
`$CLAUDE_PLUGIN_DATA/.env`. `bin/ace-doctor` already knew the
canonical path; only the human-readable docs lagged.

### Changed

- `CLAUDE.md` `## Layout` — `.env.tpl` line now names the install path
  (`$CLAUDE_PLUGIN_DATA/.env`, legacy fallback plugin root) and the
  full `op inject` command including `--account dimagi.1password.com`.
- `CLAUDE.md` `## Gotchas` — new bullet parallel to the
  `.gws-sa-key.json` one: `.env` is per-machine, lives at
  `$CLAUDE_PLUGIN_DATA/.env`, and the in-shell env vars are normally
  empty because values load into MCP-server subprocesses, not the
  parent shell.
- `agents/ace-orchestrator.md` — the `ACE_DRIVE_ROOT_FOLDER_ID unset`
  error replaces the `<env-path>` placeholder with the concrete
  `$CLAUDE_PLUGIN_DATA/.env` path so it matches doctor's hint verbatim.

## 0.10.13 — 2026-04-29

**Class-level preventer for rubric-prose ↔ schema drift.**

The 0.10.7 schema bump was needed because eight `*-eval/SKILL.md` files
had referenced `verdict: incomplete` for months before
`lib/verdict-schema.ts` accepted that value. Drift was harmless only
because nothing called `validateVerdict` at runtime on a real verdict
(the schema test was the lone consumer). 0.10.13 closes that class:
the next time a rubric YAML example uses a literal the schema doesn't
allow, CI fails before the discrepancy can land.

### Added

- `test/lib/eval-skill-yaml-drift.test.ts` — walks every
  `skills/*-eval/SKILL.md`, extracts each `` ```yaml `` block, and
  asserts that every `verdict:`, `severity:`, `disposition:`, and
  `mode:` literal is in the corresponding `lib/verdict-schema.ts`
  enum. Indent-aware: per-item context narrows `verdict` to
  `pass|warn|fail` (no `incomplete`/`partial`); custom fields like
  `opp-eval`'s `recommendations[].severity` are skipped. Pipe-syntax
  doc lines (`verdict: pass | warn | fail | incomplete`) are split
  and each value checked individually.
- Six synthetic detection tests inside the same suite verify the
  walker actually catches drift (unknown verdict, unknown severity,
  per-item over-reach, custom-field skip, pipe-syntax handling) — so
  the per-skill checks can't pass vacuously if the walker breaks.

### Why this matters for the eval framework

Per the dominant ACE design rule (CLAUDE.md § Conventions —
*"Class-level preventers > instance-level fixes"*): when a silent-
failure class surfaces, catch it at the boundary so every future
instance is structurally impossible. 0.10.13 turns the rubric-prose
contract into runtime-enforced truth, in the same shape as
`ocs_shared_collection_team` (0.7.1) and `assertParentOnSharedDrive`
(Drive parent guard).

This unblocks future schema evolution: the next time a rubric needs
a new tier, the editor will hit the failing test immediately and
know to extend the enum (and bump `SCHEMA_VERSION`) instead of
silently shipping drift.

### Test counts

Full suite: 234 passing / 29 skipped after this change. The new
suite contributes 16 tests (1 discovery sanity, 9 per-skill drift
checks, 6 synthetic detection fixtures). Every per-skill check
passes on first run — 0.10.7 already cleaned the existing drift —
so the preventer ships in green state.

## 0.10.10 — 2026-04-29

**Capture-method branching in `ocs-chatbot-eval` source-usage dimension.**

Third and final cross-opp validation finding from the 0.9.11 turmeric-
dogfood run. The source-usage rubric capped at ≤5 whenever `cited_files`
was empty and the body named source docs — meant to catch a pipeline bug
where structured citations don't populate. But the QA skill captures
exclusively via the anonymous widget endpoint, and that endpoint never
returns inline citation markup regardless of bot grounding. Result: the
cap fired on every widget transcript regardless of bot quality, conflating
"bot is hallucinating" with "API doesn't expose grounding signal."

### Fixed

- **`ocs-chatbot-qa` transcript schema:** added `Capture method:` header
  field (`widget` | `openai-compat`). Today only `widget` is in use.
- **`ocs-chatbot-eval` source-usage dimension:** branches on capture
  method.
  - **`widget`:** grades body-text grounding (does the response name
    source docs by title? does it paraphrase content the KB
    demonstrably contains?). Emits
    `[PLATFORM] empty cited_files expected on widget capture;
    structured-citation grade not applicable` instead of binding the
    cap. Anchored deductions: -2 if body asserts facts without naming
    any source; ≤3 if body fabricates a source title not in the KB.
  - **`openai-compat`:** existing two-tier cap retained — empty
    `cited_files` there IS a real grounding gap.
- Default to `widget` if the header field is missing (legacy
  pre-0.10.10 transcripts).

### Why this matters for the eval framework

This polish removes a class of false deductions that affected every
widget-captured transcript — the same pattern as the
`connect-program-setup-eval` `[PLATFORM]` tier added in 0.10.7. Both
fixes follow the rule: rubrics MUST distinguish "thing the operator can
fix" from "thing the operator cannot fix." When the cap can't
discriminate, it's noise, not signal.

### Cross-opp validation backlog now closed

All three findings from 0.9.11 cross-opp validation have shipped:

1. ✅ HITL-stub branch in app-eval rubrics (0.10.8)
2. ✅ Clean-source reviewer fidelity in idea-to-pdd-eval (0.10.9)
3. ✅ Widget-API source-usage cap in ocs-chatbot-eval (0.10.10)

The five connect-program-setup-eval polish items also shipped in 0.10.7,
plus the read-side `getProgram` bug fix in 0.10.6. Net: every concrete
finding from the eval framework's first non-degraded production runs is
either fixed or closed-with-rationale.

## 0.10.9 — 2026-04-29

**Clean-source branch added to `idea-to-pdd-eval` reviewer-comment-fidelity.**

Second of three cross-opp validation findings from the 0.9.11 turmeric-
dogfood run. The reviewer-comment-fidelity dimension assumed every idea.md
contains formal `[a]/[b]` reviewer footnotes — it scored gracefully when
the source was clean (no comments) by treating PDD's Open Questions as
analog, but anchors at 9.5 were a poor fit because the dimension was
effectively measuring a different thing than what the rubric claimed.

### Fixed

- New step-2 clean-source detection: if idea.md contains zero reviewer
  comments — no `[a]/[b]` footnotes, no "Reviewer Comments" / "Comments"
  / "Feedback" section — set `clean_source = true` and skip step 3.
- Reviewer-comment-fidelity dimension now has two branches:
  - **`clean_source = false`** (the established case): comment-disposition
    grading, anchors unchanged from 0.9.4.
  - **`clean_source = true`** (the new case): grades **deferred-decision
    discipline**. Looks for Open Questions / Deferred Decisions /
    TBD-per-LLO section with named questions, owner phases, and
    resolution mechanisms. Anchors 9.5 → 4.0.
- Surfaces `[INFO] clean-source branch active: graded on deferred-decision
  discipline` in `auto_surfaced` so verdicts stay auditable across
  branches.
- The branch swap is automatic, not an opt-out — clean idea.md sources
  always grade on the new dimension; reviewer-comment idea.md sources
  always grade on the original.

### Why this matters for the eval framework

This is a **dimension-semantics** fix, not a deduction-tuning fix. The
original anchors were measuring whether the PDD addressed reviewer
comments; on a clean source, that's a vacuously-true question. The new
branch measures whether the PDD handles uncertainty rigorously — which
is the actually-meaningful question for clean PM-authored sources.
Without this fix, clean-source PDDs score artificially high on a
20%-weight dimension regardless of quality.

## 0.10.8 — 2026-04-29

**HITL-stub branch added to `pdd-to-deliver-app-eval` and `pdd-to-learn-app-eval`.**

The 0.9.11 cross-opp validation against `turmeric-dogfood-20260427` ran
both cross-artifact app rubrics against an HITL-pending app summary
(explicitly notes "actual app JSON/CCZ not yet produced"). Without an
early-return guard, the rubrics graded the stub:

- `pdd-to-deliver-app-eval`: 2 of 5 dimensions became ungradable
  (field-order, conditional-logic), and the remaining three drifted
  toward "looks fine" because there was nothing concrete to
  discriminate against.
- `pdd-to-learn-app-eval`: the most load-bearing dimension
  (assessment_score_wiring, 30%) graded the stub as "wiring entirely
  missing" → ≤3 → fail. The build wasn't actually a defect; the rubric
  was being run too early.

### Fixed

- Both rubrics now have a step-2 "Detect HITL-pending stub" guard.
  Triggers on any of: `nova_app_id` missing/`null`/`TBD`; explicit
  status text marking the build as HITL-pending; summary listing only
  skeleton structure with no field-level (Deliver) or wiring detail
  (Learn).
- On match, emit `verdict: incomplete` with `[INFO] HITL-stub summary;
  no built app to grade against PDD spec`. Subsequent steps are
  skipped.

This mirrors `connect-program-setup-eval`'s degraded-mode detection
(step 2). The pattern: structural gaps in the upstream environment
(`TBD-MANUAL` ids, HITL-pending stubs, unbuilt apps) are environmental,
not quality defects, and rubrics MUST short-circuit to `incomplete`
before grading. The new v2 schema (0.10.7) made `incomplete` a
first-class verdict tier.

### Why this matters for calibration

`pdd-to-learn-app-eval` previously graded `7.3 (FAIL)` on the turmeric
HITL-stub artifact (0.9.11 cross-opp report). With the guard, the
correct verdict is `incomplete` — and the cross-opp generalization
table now reads cleanly: 3 of 4 rubrics generalize, 1 is `incomplete`
on stub artifacts (correct behavior), 0 are mis-grading.

## 0.10.7 — 2026-04-29

**Verdict schema v2 + connect-program-setup-eval rubric polish (5 items).**

The first non-degraded `connect-program-setup-eval` run on
`turmeric-market-survey-2026-04-28` surfaced five rubric weaknesses where
the rubric either over-deducted, under-discriminated, or assumed inputs the
PDD doesn't always declare. This release fixes all five and brings the
shared verdict schema in sync with the prose contracts in rubric SKILL.md
files (which referenced `incomplete` long before the schema accepted it).

### Verdict schema v2 (`lib/verdict-schema.ts`, SCHEMA_VERSION 2)

Additive enum extensions. Every v1 verdict still validates as v2.

- **Top-level verdict tiers** extended from `pass | warn | fail` to
  `pass | warn | fail | incomplete | partial`:
  - `incomplete` — structural gap prevents grading (degraded-mode
    `TBD-MANUAL` ids, missing PDD). Already used in rubric prose; schema
    now matches.
  - `partial` — artifact correct on paper, but live MCP probes failed at
    grading time. Records the text-only score; caps overall at 8.5.
- **Per-item verdicts** stay restricted to `pass | warn | fail` —
  `partial`/`incomplete` are run-level concerns, not item-level.
- **Severity tiers** extended from `BLOCKER | WARN | INFO` to add
  `PLATFORM | DRIFT | INFO-SKIPPED`:
  - `PLATFORM` — defect originates upstream (Connect, OCS), not in skill
    output. Does NOT count toward inflation guards.
  - `DRIFT` — discrepancy between artifact text and live state probe.
    Diagnostic-only; the dimension consuming either source already
    deducts if either is wrong, so DRIFT does NOT count toward inflation
    guards.
  - `INFO-SKIPPED` — sub-check bypassed because input data is absent
    (e.g., payment-rate sanity when no PDD day-rate). Documents
    coverage gap without penalizing.
- **Optional `live_state_verified: boolean`** top-level field. `true` if
  the rubric ran live MCP probes and confirmed agreement; `false`
  otherwise. When `false` on a non-degraded artifact, verdict tier is
  capped at `partial`.
- **Optional `overall_score_pre_cap: number`** top-level field for
  symmetry with the existing convention; previously implicit.

`skills/README.md § Verdict YAML shape` updated to match. Six new
schema tests cover the new tiers + per-item restriction.

### `connect-program-setup-eval` rubric polish

All five items from the turmeric run's first non-degraded grading:

1. **Partial verdict tier.** Captures the runtime-blocked-but-not-degraded
   case (artifact correct, live state unreachable). Different from
   `incomplete` (structural gap). Forces re-grading when MCP recovers.
2. **`[PLATFORM]` severity tier.** Removes the false-deduction class where
   skills got penalized for Connect platform limits (e.g. unsupported
   verification rules). Documents the gap without penalizing skill
   quality.
3. **`[DRIFT]` severity tier + live-state-drift check.** New post-grading
   pass compares `connect-setup-summary.md` claims against
   `connect_get_*` live reads, emits one DRIFT entry per discrepancy.
   Diagnostic-only; never deductive (the dimension consuming either
   source already deducts if either is wrong).
4. **Payment threshold-sanity sub-check now conditional.** Previously
   "rarely fires" because the PDD doesn't usually declare a regional
   day-rate. Now: if PDD declares one, run the check; if not, emit
   `[INFO-SKIPPED]` and skip. Never count the absence as a defect.
5. **`live_state_verified` boolean** added to verdict schema; forces
   verdict ≤ `partial` when false.

### Why this matters for the eval framework

Three of the five polish items (`PLATFORM`, `DRIFT`, `INFO-SKIPPED`) are
about removing **false deductions** — places where the rubric was
penalizing skills for things the operator can't fix or for noise in the
diagnostic signal. The same pattern surfaces on `ocs-chatbot-eval`
(widget-API source-usage cap, queued for 0.10.10) and elsewhere; the new
severity tiers let those rubrics emit signal without burning score.

Calibration gain expected on the next non-degraded run: variance should
drop because PLATFORM/DRIFT entries no longer randomly hit the inflation
guard depending on whether the rubric chose to surface them.

## 0.10.6 — 2026-04-29

**Connect MCP `getProgram` read-path fix + eval-framework calibration note.**

The `connect-program-setup-eval` rubric on `turmeric-market-survey-2026-04-28`
flagged a real bug: programs created with all fields filled at submit time
returned empty fields when read back via `connect_get_program`. The rubric was
correct about the defect (fields missing post-read) but mis-attributed root
cause to a write-side serialization gap. Actual root cause was read-side: the
playwright backend's `getProgram` wrapped `listPrograms`, and the list page
only renders `name` + `description` — `parseProgramsList` hardcodes the rest
to `0`/`''` with a comment "caller can hydrate via getProgram() if needed",
but `getProgram` itself never hydrated.

### Fixed

- `mcp/connect/backends/playwright.ts`: `getProgram` now reads
  `/a/<org>/program/<uuid>/edit` and hydrates via `extractFormFieldValues`,
  mirroring the existing `getOpportunity` pattern. All 8 Program fields
  (name, description, delivery_type, budget, currency, country, start_date,
  end_date) now round-trip correctly.

- `test/mcp/connect/integration/e2e.integration.test.ts`: integration test
  for `getProgram` strengthened from asserting only `p.name` to asserting
  every hydrated field. Would have caught this bug; will catch any
  regression.

### Eval rubric calibration

- `skills/connect-program-setup-eval/SKILL.md`: added step-8 "Defect-vs-cause
  discipline." When writing `auto_surfaced` and `per_item.note` text:
  - State observations confidently (what was seen).
  - Phrase causes tentatively ("consistent with", "one possible cause is")
    unless verified by a probe.
  - When both present, format as `Observed: <fact>. Likely cause
    (unverified): <hypothesis>.`

  LLM-as-Judge rubrics tend to pattern-match defects to the most familiar
  root-cause label rather than reasoning about layer. The turmeric run made
  exactly this error: it pattern-matched "fields empty after create" to
  "serialization gap" — a familiar label that happened to be wrong. The
  rubric was right about WHAT, wrong about WHY. The discipline rule
  separates the two so future verdicts surface diagnostic value without
  burning operator hours on the wrong layer.

### Eval framework status

- Connect bug #1 (the read-path hydration gap, originally framed as
  "serialization") closed by this release.
- Connect bug #2 (Opportunity HTTP 500) closed in 0.10.1 — three silent-500
  root causes in `connect_create_opportunity` fixed there.
- Both production bugs the eval framework caught on
  `turmeric-market-survey-2026-04-28` are now resolved.


## 0.10.0 — 2026-04-28

**New: Phase 5 `training-prep` + ACE mobile emulation**

- New `ace-mobile` MCP server (10 atomic capabilities) drives a local Mac AVD via Maestro and captures raw PNGs at every recipe step. Backed by `adb`/`emulator`/`avdmanager` shell-outs (AVD lifecycle), `maestro test` (recipe runner with vocabulary-validating YAML pre-flight), and a TS-reimplementation of the Playwright OTP fetcher.
- New `app-screenshot-capture` skill produces `ACE/<opp>/screenshots/` + manifest from generated per-module Maestro recipes.
- New `training-prep` phase agent (Phase 5) runs `app-screenshot-capture` + the relocated `training-materials` skill end-to-end automated, with no LLO contact. Phases renumbered: `llo-manager` → 6, `closeout` → 7. Restores the "Phases 1–N agent-only, then LLO contact" invariant that was previously broken by `training-materials` running in commcare-setup.
- `training-materials` now consumes screenshots manifest, `connect-state.yaml`, and `ocs-state.yaml`, so generated docs include real URLs and step-by-step screenshots.
- New `/ace:mobile-bootstrap` slash command for one-time per-machine setup (Maestro, AVD, Playwright cookies, ACE test user registration).
- `connect-opp-setup` now invites the ACE test user (`${ACE_E2E_PHONE}`) to each new opp; invite URL persisted to `connect-state.yaml` so Phase 5 can drive the claim-opp flow.
- `.env.tpl` extended with `ACE_E2E_*` + `ACE_AVD_NAME`. `/ace:doctor` grew a `[Mobile]` section.
- Mac-only, local-AVD-only. No cloud device farms in this release.

See `docs/superpowers/specs/2026-04-28-ace-mobile-emulation-design.md` and `docs/superpowers/plans/2026-04-28-ace-mobile-emulation.md`.

## 0.9.11 — 2026-04-28

Cross-opp validation: applied all 4 strongly-calibrated rubrics
against `turmeric-dogfood-20260427` artifacts and compared scores
to the smoke-20260428-1242 calibration baselines. **3 of 4 rubrics
generalize**; the 4th surfaces a real rubric weakness worth fixing
in a future iteration.

### Cross-opp validation result

| Rubric | smoke-1242 baseline | turmeric-dogfood-20260427 | Verdict |
|---|---|---|---|
| ocs-chatbot-eval | 7.67 (cross-model median) | 8.0 post-cap | **GENERALIZES** (+0.33) |
| idea-to-pdd-eval | 8.65 (cross-model median) | 9.78 | **GENERALIZES** (+1.13) |
| pdd-to-deliver-app-eval | 8.5 post-cap | incomplete (~8.07) | rubric weakness — see below |
| pdd-to-learn-app-eval | 8.5 post-cap | 7.3 (FAIL) | **GENERALIZES** — caught real defect |

3 of 4 within ±1.5 of baseline. The pdd-to-learn-app-eval `fail` on
turmeric is the rubric working correctly: the turmeric Learn brief
is missing the most load-bearing dimension (Assessment Score
wiring), and the ≤3 → fail rule fires.

Each rubric also surfaced concrete defects from the new artifacts
(not just pattern-matched from smoke-1242 catalogue):

- **OCS:** P21 "Module 4" possible hallucination, P20 missing
  `[product-feedback]` tag, source-usage cap from widget API
  limitation (no inline citation markup).
- **idea-to-pdd:** Layer B "AI-assisted photo review" without
  named model/threshold (same pattern as smoke-1242 — feasibility
  rule generalizes).
- **learn-app:** Assessment Score wiring entirely missing from
  the HITL-stub brief.
- **deliver-app:** `flw_safety_concern` field added beyond PDD
  spec; Connectify wiring underspecified.

### Rubric weaknesses surfaced

The cross-opp run found 3 issues worth fixing in 0.9.12+:

1. **HITL-stub branch missing in cross-artifact app rubrics.**
   Both `pdd-to-deliver-app-eval` and `pdd-to-learn-app-eval`
   tried to grade against an HITL-pending app summary that
   explicitly notes "actual app JSON/CCZ not yet produced." The
   deliver rubric got 2 of 5 dimensions ungradable (field-order,
   conditional-logic). Both rubrics need a step-0 check: "if app
   summary status is HITL-pending or `nova_app_id` is null,
   return `verdict: incomplete` immediately."

2. **`idea-to-pdd-eval` reviewer-comment-fidelity assumes formal
   footnotes.** The turmeric idea.md is a clean source with no
   `[a]/[b]` reviewer comments. The rubric scored gracefully by
   treating PDD's Open Questions as analog, but anchors at 9.5
   were a poor fit. Add a "clean source → score on PDD's deferred-
   decision discipline instead" clause.

3. **OCS source-usage cap is widget-API-dependent.** The "empty
   `cited_files` + body names sources → ≤5 cap" rule fires every
   time on the widget-capture path because the widget API never
   returns inline citation markup. Considers whether the cap
   should differ between widget endpoint and OpenAI-compatible
   endpoint, or whether the cap is correctly punishing a real
   grounding gap regardless of capture method.

### Session arc complete

11 releases this session (0.9.0 → 0.9.11), each driven by a
finding from the previous one's calibration. Eval framework now
has rubrics for all 6 opp-eval categories (4 strongly calibrated,
4 provisional pending real ground-truth artifacts), a calibration
methodology + audit trail, and validated cross-opp generalization.

### Backlog still open after 0.9.11

- 3 rubric weakness fixes from this validation (HITL-stub branch,
  clean-source reviewer fidelity, widget-API source-usage cap).
- Real artifacts for the 4 provisional rubrics (non-degraded
  Phase 3, first launch, first weekly review, first closed cycle).
- 3 minor operate-category rubrics (llo-invite-eval,
  llo-onboarding-eval, llo-uat-eval).
- Operator-effort tracking in state.yaml.
- 3 small OCS rubric polish items + composition-rule imperatives.

## 0.9.10 — 2026-04-28

Operate-category rubrics added. **All 6 opp-eval categories now
have rubrics defined** (4 strongly calibrated + 4 provisional
pending real ground-truth artifacts).

### Added

- **`skills/llo-launch-eval/SKILL.md`** — most load-bearing Phase 5
  rubric. Grades `llo-launch` activations against PDD launch
  preconditions. 5 dimensions: uat_signoff_completeness (0.25),
  connect_activation_correctness (0.25), app_publish_status (0.20),
  go_live_notification_fidelity (0.15 — with the same factual-error
  rule from OCS rubric 0.9.4), pre_launch_gate_discipline (0.15 —
  any upstream gate not approved is a 4-point deduction). Hard-fail
  rules: explicit LLO reject (vs pending), missing activation
  transition, either app still in draft, gate bypass. Inflation
  guard at 8.5. Explicit `incomplete` verdict when Phase 5
  llo-launch hasn't run.

- **`skills/flw-data-review-eval/SKILL.md`** — recurring rubric for
  the per-cycle quality signal. Grades each weekly `flw-data-review`
  report. 5 dimensions: signal_coverage (0.25 — calibration drift,
  refusal rate, photo pass-rate, etc.), outlier_detection_rigor
  (0.20 — concrete threshold rules, not vibes), recommendation_
  actionability (0.20 — concrete remediations), evidence_citation_
  discipline (0.15), trajectory_awareness (0.20 with N/A handling
  for first-of-cycle). Recurring shape: produces dated verdict
  YAMLs (`flw-data-review-eval-YYYY-MM-DD.yaml`). Calibration cheap
  because the producing skill runs 4–8 times per opp.

### Coverage frontier (all 6 categories now defined)

| Category | Rubric(s) | Calibration |
|---|---|---|
| design | idea-to-pdd-eval | strongly |
| commcare | pdd-to-deliver-app-eval, pdd-to-learn-app-eval | strongly (×2) |
| connect | connect-program-setup-eval | provisional |
| ocs | ocs-chatbot-eval | strongly |
| operate | llo-launch-eval, flw-data-review-eval (NEW) | provisional (×2) |
| closeout | cycle-grade-eval | provisional |

8 rubrics total, 4 strongly calibrated, 4 provisional. Once real
artifacts arrive (non-degraded Phase 3, first Phase 5 launch, first
flw-data-review report, first closed cycle), the provisional rubrics
calibrate via the same 3-run same-model + 3-run cross-model protocol.

### Backlog still open

- **3 more operate-category rubrics deferred:** `llo-invite-eval`
  (prep-stage; lower stakes), `llo-onboarding-eval` (email send;
  hard to grade without delivery confirmations), `llo-uat-eval`
  (UAT signoff is gradable but lower-leverage than llo-launch).
  Build later if needed; current 2 cover the most load-bearing
  Phase 5 signals (the launch gate and the recurring quality
  review).
- **Cross-opp validation** (rubrics still trained only on
  smoke-20260428-1242).
- **Real artifacts** for the 4 provisional rubrics to calibrate
  against.
- **Operator-effort tracking** in state.yaml.
- 3 small OCS rubric polish items.

## 0.9.9 — 2026-04-28

### Added

- **`.env.tpl`** — `ACE_HQ_API_KEY` slot for
  `connect_create_opportunity`. Connect's `create_opportunity` REST
  endpoint validates the HQ API key against CCHQ before creating
  the opp. Without `ACE_HQ_API_KEY` in env, Phase 3 Step 2 dies
  with HTTP 500 from `/opportunity/init/` — observed on the
  turmeric-market-survey-2026-04-28 dogfood run. (Shipped from
  `emdash/new-e2e-25bff` via merge commit `b8dfecd`.)

## 0.9.8 — 2026-04-28

Two new provisional rubrics added — covers the remaining 2 of 6
opp-eval categories. ACE's eval framework now has rubrics defined
for **all 6 categories**, with 4 strongly calibrated and 2
provisional pending real ground-truth artifacts.

### Added

- **`skills/connect-program-setup-eval/SKILL.md`** — covers the
  `connect` category. 5 dimensions: program_fit_decision (0.15),
  verification_rule_fidelity (0.25 — most load-bearing for Layer A
  faithfulness), delivery_unit_wiring (0.20), payment_unit_fit
  (0.20), active_window_status (0.20). Inflation guard at 8.5.
  Explicit `incomplete` verdict for degraded-mode artifacts (which
  is what `smoke-20260428-1242` Phase 3 produced before the
  ace-connect MCP shipped) — degraded mode is environment, not
  quality, and shouldn't deduct. The rubric integrates with the new
  ace-connect MCP `connect_get_*` tools to verify live state against
  `connect-setup-summary.md` claims when the IDs are real.

- **`skills/cycle-grade-eval/SKILL.md`** — covers the `closeout`
  category. 5 dimensions: self_eval_agreement (0.25),
  learnings_concreteness (0.25 — vague aphorisms ≤4),
  recommendation_specificity (0.20 — must point at a concrete
  artifact change), evidence_citation_discipline (0.15 — uncited
  cycle-level claims are improvisation), trajectory_framing (0.15
  — must acknowledge calibration history when it shaped the score).
  Inflation guard at 8.5. Explicit `incomplete` verdict when Phase
  6 hasn't run yet.

### Changed

- **`skills/opp-eval/SKILL.md`** — `verdict: incomplete` verdicts
  are now excluded from category mean. They represent a rubric
  correctly detecting a structural gap (degraded mode, phase not
  run, target artifact missing) and refusing to grade. That's a
  coverage gap, not a quality signal, and shouldn't affect the
  category score. Categories with zero non-incomplete verdicts
  remain `null` (existing behavior).

### Coverage status (rubrics defined / strongly calibrated / verdicts on smoke-20260428-1242)

| Category | Rubric | Calibration | Smoke verdict |
|---|---|---|---|
| design | idea-to-pdd-eval | strongly | 8.65 (PASS) |
| commcare | pdd-to-deliver-app-eval + pdd-to-learn-app-eval | strongly | 8.5 each (PASS) |
| connect | connect-program-setup-eval (NEW) | provisional | will emit `incomplete` (degraded artifacts) |
| ocs | ocs-chatbot-eval | strongly | 7.62 (PASS) |
| operate | none yet | — | (Phase 5 not run) |
| closeout | cycle-grade-eval (NEW) | provisional | will emit `incomplete` (Phase 6 not run) |

Coverage frontier: **5 of 6 categories** now have rubrics defined.
The remaining gap is operate (Phase 5 skills: llo-onboarding,
llo-uat, llo-launch, flw-data-review, timeline-monitor). Building
those rubrics is queued — they're easier with a real Phase 5 run
producing ground-truth artifacts.

### Backlog still open

- **Cross-opp validation.** All 4 calibrated rubrics still trained
  on smoke-20260428-1242 only.
- **Real non-degraded Phase 3 run** to produce ground truth for
  connect-program-setup-eval calibration.
- **First closed-cycle opp** to produce ground truth for
  cycle-grade-eval calibration.
- **Operate-category rubrics** (5 skills, no rubrics yet).
- **Operator-effort tracking** in state.yaml.
- 3 small OCS rubric polish items + tighter composition-rule
  imperatives.

## 0.9.7 — 2026-04-28

🎯 **Milestone: all 4 ACE `-eval` rubrics now strongly calibrated.**
Cross-model variance protocols completed against the polished 0.9.5
rubrics for both `pdd-to-deliver-app-eval` and `pdd-to-learn-app-eval`,
joining `ocs-chatbot-eval` (0.9.4) and `idea-to-pdd-eval` (0.9.6) at
the strong-calibration tier.

### Demonstrated — final 2 cross-model audits

**`pdd-to-deliver-app-eval`** — Sonnet 8.5 (pre-cap 8.775), Opus 8.5
(pre-cap 9.175), Haiku 8.5 (pre-cap 9.0). Pre-cap spread **0.40** ≤ 1.0
→ strongly calibrated. All 3 hit the 8.5 inflation cap; pre-cap reporting
(added 0.9.4) is what makes the variance measurable.

**`pdd-to-learn-app-eval`** — Sonnet 8.5 (pre-cap 9.35), Opus 8.5
(pre-cap 9.25), Haiku 8.5 (pre-cap 9.50). Pre-cap spread **0.25** ≤ 1.0
→ strongly calibrated. Same cap-binding pattern. The 0.9.4 polish
(bonus-module pinned to 10.0; documented-platform-limitation rule;
stub-answer-keys carve-out) tightened pre-cap variance from 0.275
(same-model) to 0.25 (cross-model) — polish reducing variance without
changing central tendency, exactly per the eval-calibration learnings doc.

### Final calibration status (all 4 rubrics)

| Rubric | Same-model variance | Cross-model spread | Status |
|---|---|---|---|
| `ocs-chatbot-eval` | 0.09 (Runs 6–8) | 0.10 | strongly calibrated (0.9.4) |
| `idea-to-pdd-eval` | 0.04 (Runs 1–3) | 0.275 | strongly calibrated (0.9.6) |
| `pdd-to-deliver-app-eval` | 0.425 same-model | 0.40 pre-cap | strongly calibrated (0.9.7) |
| `pdd-to-learn-app-eval` | 0.275 pre-cap (Runs 1–3) | 0.25 pre-cap | strongly calibrated (0.9.7) |

24 total calibration runs across the session (12 same-model + 12
cross-model). 100% detection rate against the per-opp ground-truth
catalogue on every run.

### Updated

- **`ACE/smoke-20260428-1242/eval-calibration/pdd-to-deliver-app-eval-runs.md`**
  — Runs 4–6 (cross-model) appended.
- **`ACE/smoke-20260428-1242/eval-calibration/pdd-to-learn-app-eval-runs.md`**
  — Runs 4–6 (cross-model) appended.
- **`ACE/smoke-20260428-1242/verdicts/opp-eval-deep-v5.yaml`** — final
  re-aggregate. Score unchanged from v4 (8.21, PASS, adequate coverage)
  — the milestone is rigor-of-the-grading, not change-in-the-grade.
  All 4 contributing rubrics now strongly calibrated.

### Session arc (0.7.0 → 0.9.7)

The eval framework matured across this session in 3 phases:

1. **Topology fix (0.7.0–0.8.x).** ACE topology flattened to level-0
   `Agent` dispatch; first end-to-end smoke run completed; opp-eval
   produced a confident-but-meaningless 8.92 PASS at 1/6 coverage.

2. **Calibration framework (0.9.0–0.9.2).** Built `eval-calibration`
   methodology + 2 new cross-artifact rubrics. First real PASS verdict
   on opp-eval at adequate coverage. Trajectory: 8.92 (inflated) → 8.43
   (cap honest) → 8.085 (rubrics honest) → 8.21 (coverage adequate).

3. **Cross-model rigor (0.9.4–0.9.7).** Polished 19 surfaced rubric
   weaknesses; verified all 4 rubrics at strong-calibration tier via
   Sonnet/Opus/Haiku cross-model audits. Documented patterns and
   anti-patterns in `docs/eval-calibration-learnings.md` for future
   sessions.

The number now means something. 8.21/10 PASS is a weighted view of 3
calibrated categories (design 8.65, commcare 8.5, ocs 7.67), each
backed by a strongly-calibrated rubric audited at ≥80% detection rate
on a per-opp ground-truth catalogue, with cross-model spread ≤1.0.

### Backlog still open

- **Cross-opp validation.** All 4 rubrics calibrated against the same
  smoke-20260428-1242 artifacts. Next opp run will test whether
  calibration generalizes beyond this one set.
- **`connect-program-setup-eval`** — 4th category coverage, unblocked
  by ace-connect MCP. Needs a non-degraded run for ground truth.
- **Operate / closeout categories** — wait for Phase 5 / Phase 6 runs.
- **`cycle-grade` promotion** to a proper `-eval` skill.
- **Operator-effort tracking** in state.yaml — meta-eval signal not
  in any current rubric.
- Three small OCS rubric polish items + tighter composition-rule
  imperatives queued for the next iteration.

## 0.9.6 — 2026-04-28

Second strongly-calibrated rubric + durable session learnings doc.

### Demonstrated — `idea-to-pdd-eval` cross-model variance

Three judge models against the same fixed PDD with the polished
0.9.5 rubric:

| Model | Overall | Notes |
|---|---|---|
| Sonnet | 8.65 | Stress ceiling 7.5 bound; load-bearing + mid `numbers_consistent` deductions |
| Opus | 8.55 | Stress ceiling 7.5 bound (composition rule applied); same deductions |
| Haiku | 8.825 | Did NOT apply stress-test composition rule (read formula instead of ceiling); offset by lower `numbers_consistent` |

**Cross-model spread: 0.275** ≤ 1.0 → **strongly calibrated.**

Same Haiku-divergence pattern as the OCS rubric: when language is
borderline directive-vs-guidance, Haiku reads literally and the
others read as instruction. Multi-dimensional weighted score is
robust because dimensions counterbalance.

ACE now has **2 of 4 rubrics strongly calibrated** (OCS, idea-to-pdd).
`pdd-to-deliver-app-eval` and `pdd-to-learn-app-eval` are
provisional — cross-model audits queued.

### Added — durable eval calibration learnings

- **`docs/eval-calibration-learnings.md`** — reference doc capturing
  patterns and anti-patterns observed across the 0.9.0–0.9.5
  trajectory. Six anti-patterns documented (inflation by weight
  renormalization, generosity by default, "N/A defaults to perfect",
  cap-collapses-variance, self-eval over-confidence, same-model
  variance is not enough). Practical recipes for building a new
  `-eval` skill, recovering from suspiciously-low variance, and
  testing whether a rubric is actually discriminating. Linked from
  `skills/eval-calibration/SKILL.md` § See also.

### Backlog (still open after 0.9.6)

- Cross-model variance on `pdd-to-deliver-app-eval` and
  `pdd-to-learn-app-eval` (move them from provisional to strongly
  calibrated).
- Same-model re-runs of polished rubrics to confirm 0.9.4–0.9.5
  polish reduced (or didn't increase) variance.
- Tighten `idea-to-pdd-eval` composition-rule wording to imperative
  so Haiku-tier judges don't misread (Haiku's higher 8.825 stems
  from reading the rule as guidance rather than directive).
- Operator-effort tracking in `state.yaml`.
- `cycle-grade` promotion to a proper `-eval` skill (deferred until
  a closed-cycle opp produces ground truth).
- `connect-program-setup-eval` (deferred until a non-degraded
  Phase 3 run produces ground truth).
- Three OCS-rubric polish items not yet shipped: refine "unspeccable
  Layer B" anchor for `feasibility_headline_metrics` (Haiku scored
  it 8.5 vs Sonnet/Opus 6.5–7.5); clarify `numbers_consistent`
  severity-tier rules (Haiku applied two load-bearing 2.0
  deductions, Sonnet/Opus applied two mid 1.0).

## 0.9.5 — 2026-04-28

Rubric polish (19 surfaced weaknesses → fixes batched across all 4
calibrated rubrics) plus the first **strongly-calibrated** rubric.
Cross-model variance protocol on `ocs-chatbot-eval` against three
judge models (Sonnet, Opus, Haiku) produced a spread of **0.10**,
well under the strongly-calibrated target of ≤1.0 from
`eval-calibration` § Anchoring caveat. The OCS rubric is now the
first ACE rubric audited at the strong-calibration tier.

### Changed — rubric polish from 0.9.2 calibration findings

- **`skills/ocs-chatbot-eval/SKILL.md`** — 5 fixes:
  (a) **Multi-error rule:** 2+ distinct factual errors in one entry
  → ceiling drops from 7 to 6 (different defects in same answer is a
  worse signal than same defect in different answers).
  (b) **Tone-vs-Correctness boundary:** factual errors hit Correctness
  only, never Tone, even in stylistic contexts. Resolves the
  inter-run disagreement on whether email-typo dings tone.
  (c) **Source_usage two-tier cap:** ≤5 if `cited_files` empty AND
  body grounds in named docs (pipeline bug); ≤3 if empty AND body
  also lacks named sources (structural fail).
  (d) **Refusal_correctness tiered cap:** 0 adversarial prompts →
  cap 6 (no test); 1–2 prompts → cap 7 (sample size too small);
  3+ → no cap. Out-of-scope prompts count toward adversarial total.
  (e) **Tagging defensible-additions rule:** pinned scoring
  anchors at 10 / 9.0 / 8.5 / -1 per miss for clearer inter-run
  consistency.
  Plus pre-cap and post-cap reporting in verdict YAMLs.

- **`skills/pdd-to-learn-app-eval/SKILL.md`** — 5 fixes:
  bonus-module rule pinned to exactly 10.0 when criteria met (was
  9.0–9.5 across runs); module-order cap clarified to "dimension
  floor 7.0"; documented platform-limitation rule (informational-
  only scores never deduct); stub-answer-keys carve-out (calibration-
  gate answer keys do NOT score as present); pre-cap and post-cap
  reporting (essential for this rubric since cap binds on every
  Learn build).

- **`skills/idea-to-pdd-eval/SKILL.md`** — 6 fixes: split
  `concreteness` into `numbers_present` (0.10) + `numbers_consistent`
  (0.10); added `feasibility_headline_metrics` (0.05) as 7th
  dimension; reduced `archetype_coherence` weight 0.20 → 0.15 to
  rebalance; severity-tiered cross-section deductions (0.5/1.0/2.0
  by load-bearing); tightened reviewer-comment fidelity scoring
  anchors (single anchor at 9.5); composition rule for stress-test
  ceiling vs per-check formula; raised inflation-guard threshold
  7.5 → 8.0 (was non-binding at 7.5); pre-cap and post-cap reporting.

- **`skills/pdd-to-deliver-app-eval/SKILL.md`** — 3 fixes:
  question-order cap clarified to "dimension floor 5.0";
  conditional_logic scope pinned to relevance/display-conditional
  ONLY (not in-app camera prompts or geopoint validates);
  Connectify wiring split into 3 explicit sub-checks (Deliver
  Unit name / Entity ID composite / required-for-credit) so
  verdict YAMLs surface which sub-check is the swing factor.

### Demonstrated — cross-model variance on OCS rubric (strong calibration)

Single 0.9.4 rubric, fixed transcript, three judge models:

| Model | Overall | Refusal cap | Notes |
|---|---|---|---|
| Sonnet | 7.7 | 7 | Applied out-of-scope-as-adversarial rule |
| Opus | 7.6 | 7 | Applied out-of-scope-as-adversarial rule |
| Haiku | 7.67 | 6 | Did NOT apply out-of-scope rule; offset by higher Correctness/Tagging |

**Cross-model spread: 0.10** ≤ 1.0 target → **strongly calibrated.**

Most interesting finding: when judges disagree on rule
interpretation (Haiku read out-of-scope-as-adversarial as a
suggestion rather than directive), the multi-dimensional weighted
score is robust because dimensions counterbalance. Median 7.67
across all 3 models matches the 0.9.1 same-model median (7.62)
within 0.05.

Cross-rule disagreement queued for 0.9.5 tightening: rephrase
"out-of-scope counts toward adversarial total" from observation
language to imperative ("MUST count").

### Backlog still open

- **PDD/Learn/Deliver re-runs** with 0.9.4 polish. Same-model
  variance protocol against the polished rubrics is queued — not
  required to ship 0.9.4 because the polish is mostly clarifications
  that should reduce variance, not change central tendency.
- **Cross-model variance** on the other 3 rubrics. OCS is the first
  strongly-calibrated; the other 3 need cross-model audits next.
- **Operator-effort tracking** in state.yaml.
- **`cycle-grade` promotion** to a proper -eval skill.
- **`connect-program-setup-eval`** (now unblocked; needs a
  non-degraded opp run to produce ground truth).

## 0.9.4 — 2026-04-28

### Fixed

- `skills/connect-opp-setup/SKILL.md` — corrected the `location`
  field documentation. The MCP exposes `location` as a boolean
  toggle (the playwright backend always preserves the existing
  form threshold value, default 10m). Skill text was telling
  agents to set a meters value, which silently became dead text.
  Now documents the actual boolean semantics + flags the
  threshold as a known limitation. (Shipped from
  `emdash/new-e2e-25bff` via merge commit `69a4dbf`.)

## 0.9.3 — 2026-04-28

Coverage milestone. opp-eval produced the **first real PASS verdict**
on `smoke-20260428-1242` (overall 8.21, coverage tier `adequate`,
3 of 6 categories scored — not coverage-capped). Trajectory:
v1 8.92 PASS (inflated, 1/6 categories) → v2 8.43 WARN (capped) →
v3 8.085 WARN (capped) → **v4 8.21 PASS (real)**. The score went
down twice as rubrics tightened and then back up slightly when
adequate coverage unlocked the verdict cap — net result is a
run-level number that finally means something.

### Added — 2 new calibrated `-eval` rubrics

- **`skills/idea-to-pdd-eval/SKILL.md`** — covers the design
  category. 5 dimensions: stress_test_agreement (0.25),
  reviewer_comment_fidelity (0.20), structural_completeness (0.15),
  archetype_coherence (0.20), concreteness (0.20). Inflation guard
  at 7.5 when PDD self-eval is 5/5 but this rubric scores ≤7.5.
  Calibration: 3 LLM-judge runs scored 8.48 / 8.52 / 8.48 (variance
  0.04), detection 3/3 against the smoke-20260428-1242 PDD's known
  issues (cross-section inconsistency on Learn-app gates, scope
  mismatch on FLW count vs LLO Pref, stress-test self-grade
  overconfidence on Verifiability).

- **`skills/pdd-to-learn-app-eval/SKILL.md`** — covers the second
  half of the commcare category. Mirror of pdd-to-deliver-app-eval
  but tuned for Learn-app concerns. 5 dimensions:
  module_count_match (0.15) with bonus-cert-module rule,
  module_order_match (0.10), assessment_score_wiring (0.30 — most
  load-bearing for Connect-side Learn→Deliver gating),
  content_topic_coverage (0.25) with placeholders-count-as-present,
  archetype_coherence (0.20). Inflation guard at 8.5 when ≥2 WARN
  auto_surfaced. Calibration: 3 LLM-judge runs all 8.50 post-cap
  (variance 0.00; pre-cap 8.80–9.075, variance 0.275), detection
  5/5. The cap binds on every Learn build today because every
  build has 3+ placeholder WARNs (M4 photos, M5 calibration set,
  M6 phone numbers) — that's the rubric correctly reflecting "live
  deployment is blocked until the LLO populates."

### Updated

- **`ACE/smoke-20260428-1242/eval-calibration/known-issues.md`** —
  added 3 PDD ground-truth issues (for idea-to-pdd-eval) and 5
  Learn-build ground-truth issues (for pdd-to-learn-app-eval).
  Total catalogued issues across all artifacts: 15. Per-rubric
  detection rate is 100% across all 12 same-model calibration
  runs run this session.

- **`ACE/smoke-20260428-1242/verdicts/opp-eval-deep-v4.yaml`** —
  re-aggregated with the 4 calibrated rubrics. First PASS verdict
  for this opp at the adequate coverage tier.

### Calibration trajectory across the session

| Rubric | First-run | Calibrated | Trend |
|---|---|---|---|
| ocs-chatbot-eval | 8.92 (inflated) | 7.62 (variance 0.09) | -1.30 over 3 iterations |
| pdd-to-deliver-app-eval | 8.575 (manual) | 8.55 (variance 0.425) | confirmed manual ≈ LLM-judge median |
| idea-to-pdd-eval | n/a | 8.48 (variance 0.04) | calibrated cleanly first try |
| pdd-to-learn-app-eval | n/a | 8.50 (variance 0.00 post-cap) | inflation cap binds; rubric working as intended |

15 same-model calibration runs total this session, all detecting
their full ground-truth set.

### Backlog (queued from 0.9.2 calibration findings — to ship in 0.9.3)

Five rubrics-each-surfaced-its-own-weaknesses observations from the
variance protocol runs:

- **OCS rubric (5):** tier the refusal cap by adversarial-prompt
  count; include out-of-scope handling in refusal score; resolve
  tone-vs-correctness double-counting on typos; split source_usage
  cap; specify multi-error per-entry.
- **Deliver-app rubric (5):** field-count split rule (shipped in
  0.9.1); inflation guard (shipped in 0.9.1); 3 more from the
  Plan-agent's pre-execution analysis remain.
- **Learn-app rubric (5):** record pre-cap and post-cap overall
  both in verdict YAML; carve out stub-answer-keys-in-Assessment-
  gate from "placeholders count as present"; pin bonus-module-rule
  scoring to 10.0 if criteria met; pin archetype_coherence M7
  vendor-education reading; pin documented platform limitations
  as INFO-only never-deduct.
- **PDD rubric (6):** split concreteness into numbers-present vs
  numbers-consistent; tier cross-section deductions by severity;
  resolve stress-test ceiling vs per-check formula composition;
  tighten reviewer-comment fidelity scoring anchors; raise
  inflation-guard threshold from 7.5 to 8.0; add a feasibility
  dimension for headline-metric-claims.

Plus the 0.9.0 backlog still open:
- Cross-model variance (Sonnet/Opus/Haiku) for "strongly
  calibrated" status.
- Operator-effort tracking in state.yaml.
- `cycle-grade` promotion to a proper -eval skill.
- `connect-program-setup-eval` (now unblocked; needs a
  non-degraded opp run to produce ground truth).

## 0.9.2 — 2026-04-28

### Fixed

- `connect_create_program`, `connect_create_opportunity`, and
  `connect_create_payment_unit` reject numeric arguments coming in as
  strings. Surfaced when a Claude Code MCP-tool call serialized
  `delivery_type: 11` and `budget: 10000` as strings; the Zod schemas
  rejected them with `"Expected number, received string"`. Switched
  the affected fields to `z.coerce.number()` so either form is
  accepted (the playwright backend was already coercing via `String(...)`
  internally).

### Restored

- 0.9.0 and 0.9.1 CHANGELOG entries below were briefly clobbered
  during the 0.8.1 → ace-connect → main merge when version-bump
  conflicts were resolved with `--theirs`. Restored verbatim from
  commit `e1b84ba`. The eval framework changes themselves were
  never lost — only the CHANGELOG / VERSION lines were.

## 0.9.1 — 2026-04-28

Second iteration of the eval calibration loop, driven by what 0.9.0's
first calibration run surfaced. Demonstrates the methodology actually
self-improves rather than just calibrating once. **Trends across the
three iterations on the smoke-20260428-1242 OCS deep transcript:**
v1 8.92 → v2 8.28 → **v3 7.62** (-1.30 total). Each rubric edit moved
the score in the right direction with deterministic, audited
deductions.

### Changed

- **`skills/ocs-chatbot-eval/SKILL.md`** — `refusal_correctness` no
  longer defaults to 10 when a suite has zero adversarial prompts.
  It now caps at **6/10 (warn)** in that case. The previous default
  was hiding 2.0 weighted points of inflation — refusal discipline
  that has never been tested is unmeasured, not perfect, and the
  weighted overall must reflect that gap. Re-run variance protocol:
  7.57 / 7.66 / 7.62 (variance 0.09 unchanged; cap is deterministic).

- **`skills/pdd-to-deliver-app-eval/SKILL.md`** — first-iteration
  fixes after LLM-judge calibration. The 0.9.0 rubric variance was
  0.425 across 3 runs — just inside the ≤0.5 target. Two fixes:
  (a) `field_count_match` clarifies how to score "split" deviations
  (parent + relevance-conditional child = one half-deviation, not
  two adds; spec-implied "free-text other" fields = zero deviation),
  and (b) inflation-guard cap at 8.5 when ≥2 `[WARN]`-tier
  auto_surfaced entries (mirrors OCS rubric pattern).

- **`skills/eval-calibration/SKILL.md`** — variance-hardening
  guidance. When 3 sequential same-model runs produce a tight
  spread (≤ 0.1), suspect anchoring. New "provisional" vs
  "strongly calibrated" distinction: provisional at ≤ 0.5
  same-model variance; strongly calibrated requires either
  cross-model spread ≤ 1.0 (different judge models) or
  shuffled-prompt-order spread ≤ 0.5.

### Demonstrated

Calibration audit trails at `ACE/smoke-20260428-1242/eval-calibration/`:

- `ocs-chatbot-eval-runs.md` — 8 runs total. Score trajectory
  8.92 → 8.28 → 7.62.
- `pdd-to-deliver-app-eval-runs.md` — first 3-run LLM-judge
  variance protocol. Median 8.55, variance 0.425, detection 4/4.

`opp-eval-deep-v3.yaml` re-aggregates: raw 8.085 (down from 8.43),
verdict still capped at WARN because coverage tier remains
"partial" (2 of 6 categories). Path to a real PASS verdict requires
lifting coverage to "adequate" (3 categories) — clearest next move
is `idea-to-pdd-eval`.

### Backlog (queued from 0.9.1 findings)

- **`idea-to-pdd-eval`** — top-leverage next rubric. Covers design
  category, lifts opp-eval from partial → adequate coverage.
- **OCS rubric 0.9.2 follow-ups:** tier the refusal cap by
  adversarial-prompt count; include out-of-scope handling in
  refusal score; resolve tone-vs-correctness double-counting on
  typos; split source_usage cap into "empty + body grounds" vs
  "empty + body fails"; specify multi-error per-entry behavior.
- **Cross-model variance** for both calibrated rubrics.
- **`connect-program-setup-eval`** — now unblocked by 0.8.0/0.8.1
  ace-connect MCP.

## 0.9.0 — 2026-04-28

Self-improving evaluation framework. The first end-to-end smoke run
exposed two real eval failures: (a) `opp-eval` returned a confident
PASS at 8.92/10 with only 1 of 6 categories actually scored — pure
inflation from the weight-renormalization math; (b) `ocs-chatbot-eval`
scored a chatbot 8.98/10 despite a contact-info typo in 12% of
responses and an empty `cited_files` API field on every entry. The
rubrics directionally noticed (source_usage was the lowest dim) but
had no hard-deduction rules, so scores landed in the safe 8–9
generosity zone. This release rewires the eval system around three
properties: ground-truth detection, inter-run stability, and
inflation discipline.

### Added

- **`skills/eval-calibration/SKILL.md`** — new skill: the calibration
  methodology. Defines the per-opp ground-truth catalogue
  (`ACE/<opp>/eval-calibration/known-issues.md`), the multi-run
  variance protocol (≥3 LLM-judge runs, variance ≤ 0.5), and the
  detection-rate metric (≥80% of catalogued issues must be flagged).
  Output is a calibrated rubric plus an audit trail
  (`<rubric-name>-runs.md`) showing each rubric edit's before/after on
  a fixed artifact.

- **`skills/pdd-to-deliver-app-eval/SKILL.md`** — new cross-artifact
  eval skill, the template for future PDD-vs-build rubrics. 5
  dimensions: field_count_match (0.20), question_order_match (0.15),
  gate_semantics_match (0.25), conditional_logic_match (0.15),
  connectify_wiring (0.25). Calibrated against the
  smoke-20260428-1242 ground-truth catalogue with 4/4 detection on
  first manual application.

### Changed

- **`skills/ocs-chatbot-eval/SKILL.md`** — calibrated rubric. Added
  `refusal_correctness` as a 5th dimension. Re-weighted: correctness
  0.30, source_usage 0.20, refusal_correctness 0.20, tone 0.15,
  tagging 0.15. Hard-deduction rules: factual error → 1-point
  Correctness deduction with hard ceiling 7; empty `cited_files`
  despite `generate_citations: true` → automatic ≤5 cap on Source
  usage; same factual error in ≥2 entries → suite-level inflation
  guard caps overall at 8.5. Manual application against
  smoke-20260428-1242 deep transcript drops 8.98 → 8.28 with 3/3
  known issues flagged.

- **`skills/pdd-to-test-prompts/SKILL.md`** — required adversarial
  coverage. Suites must include ≥1 prompt in each of 5 adversarial
  categories (`should-refuse`, `out-of-scope`,
  `hallucination-probe`, `leading-question`, `negative-frame`) and
  ≥15% of total prompts must be adversarial.

- **`skills/opp-eval/SKILL.md`** — coverage-aware run-level verdict.
  Raw weighted-mean is computed first, then coverage caps the
  verdict regardless of score: 0–1 categories → `incomplete`; 2 →
  `warn` cap; 3 → `pass` cap if raw ≥7; 4+ → full normal verdict.
  New `incomplete` verdict for runs with too few rubrics to grade
  meaningfully. The first smoke run's PASS at 1/6 coverage would
  now correctly classify as `incomplete`.

### Demonstrated

Calibration runs against `smoke-20260428-1242` artifacts written to
`eval-calibration/` and `verdicts/*-v2.yaml`:

- **OCS deep:** 8.98 → 8.28 (-0.70). Source_usage capped at 5.0 by
  empty `cited_files` rule. Correctness 8.5 by 3-typo deduction.
- **Deliver app:** new rubric scored 8.575 with 4/4 known issues
  flagged. Weakest dim: `gate_semantics_match` 7.5 (Q2 GPS
  hint-vs-validate gap).
- **opp-eval re-run:** raw 8.43 but verdict capped at `warn` (was
  PASS) because coverage is `partial` (2 of 6 categories).

The variance protocol (≥3 LLM-judge runs per rubric to confirm
score variance ≤ 0.5) is queued as a follow-on session — manual
applications used the new criteria but weren't fresh LLM-judge
invocations.

### Backlog

`pdd-to-learn-app-eval`, `idea-to-pdd-eval`, operator-effort
tracking in `state.yaml`, `cycle-grade` promotion to a proper
`-eval` skill, real LLM-judge variance runs, Connect-side
`connect-program-setup-eval` (now unblocked by 0.8.0/0.8.1's
ace-connect MCP — next session can stand it up against actual
Connect artifacts).

## 0.8.1 — 2026-04-28

Phase 3 (Connect Setup) is now fully atom-driven. The five blocked
skills under Connect's domain — `connect-program-setup`,
`connect-opp-setup`, `llo-onboarding`, `llo-launch`, `opp-closeout` —
no longer carry `## Current Workaround` blocks; they call
`ace-connect` atoms directly. `llo-invite` is a prep-only skill and
needs no Connect mutation.

### Added — 4 new opportunity-config atoms (capability map now 18, was 14)

After live-probing `/opportunity/<id>/*` against march-demo's existing
opportunity, found the post-create configuration pages and wired them
into the MCP:

- `connect_set_verification_flags` — top-level toggles (`duplicate`,
  `gps`, `catchment_areas`, `location` distance, `form_submission_*`
  time windows) plus per-deliver-unit attachment + duration checks.
  Driven from the PDD's Evidence Model Layer A.
- `connect_create_payment_unit` — name, description, amount, max_total
  / max_daily caps, date range, required + optional deliver-unit FKs.
- `connect_list_payment_units` — read-only list of payment units
  configured on an opp.
- `connect_list_deliver_units` — read-only list of deliver units. These
  come from the CommCare Deliver app's form schema, not Connect itself,
  and are not directly creatable.

### Fixed

- `connect_activate_opportunity` now drives the `active` checkbox on
  `/<id>/edit` (the previous `/activate/` URL didn't exist; the 0.8.0
  atom always 404'd).
- `getOpportunity` hydrates from `/edit` (was returning empty stubs
  derived from the list view).
- `parseOpportunitiesList` matches Connect's actual anchor-wrapped row
  layout (was using the program-card regex; returned 0 in 0.8.0).

### Changed — skill rewrites

- `connect-program-setup` calls `connect_list_programs` /
  `connect_list_delivery_types` / `connect_create_program` /
  `connect_get_program` end-to-end.
- `connect-opp-setup` adds the full post-create configuration flow:
  `connect_create_opportunity` → `connect_list_deliver_units` →
  `connect_set_verification_flags` (mapped from PDD Evidence Model
  Layer A) → `connect_create_payment_unit` (per the PDD payment plan).
- `llo-onboarding` calls `connect_send_llo_invite` to issue the
  Connect system invite at the program level (org slug, not email,
  per Connect's data model).
- `llo-launch` calls `connect_activate_opportunity` followed by
  `connect_get_opportunity` to verify `status=active`.
- `opp-closeout` calls `connect_list_invoices` / `connect_get_invoice`
  (atoms return conservative defaults until the invoice page shape is
  probed live; flagged in the skill's failure modes).
- `agents/connect-setup.md` rewritten to reflect that Phase 3 is now
  HITL-free; gates inside the phase are removed.

### Notes

- Connect's invite UI is **program-level**, not opportunity-level. The
  `connect_send_llo_invite` atom takes a program UUID as its
  `opportunity_id` arg and the invited LLO's workspace slug as
  `organization_name`. Until Connect changes its data model or we add a
  separate `connect_invite_program` atom, this naming will read a
  little oddly in skill code.
- Verification rules / payment units / delivery units have moved out
  of "TODO when found" and into "live and tested." Delivery units
  remain read-only — they're sourced from the CommCare Deliver app's
  XForm schema and Connect renders them automatically. Payment-unit
  creation depends on having at least one delivery unit on the opp.

## 0.8.0 — 2026-04-28

New `ace-connect` MCP server, mirroring the `ace-ocs` pattern. Drives
`connect.dimagi.com` through a Playwright HTTP-only session
authenticated as `ace@dimagi-ai.com` via OAuth-with-CommCareHQ.
Unblocks the six skills that have been stuck on Cal's CCC-301 work
(`connect-program-setup`, `connect-opp-setup`, `llo-onboarding`,
`llo-launch`, `opp-closeout`, plus the Connect-side prep for
`llo-invite`) — once the real REST APIs land, individual atoms flip
from PLAYWRIGHT to REST one line at a time in `capability-map.ts`.

### Added

- `mcp/connect-server.ts` registering 14 atomic Connect capabilities
  (5 Programs, 4 Opportunities, 1 lifecycle, 2 invites, 2 invoices).
- `mcp/connect/` mirroring `mcp/ocs/`'s shape: capability map, client
  interface, types, errors, logging proxy, REST stubs, Playwright
  backend, composite router.
- `mcp/connect/auth/playwright-session.ts` and `hq-oauth-login.ts` —
  automated HQ-OAuth login from `.env` creds, with manual fallback
  via the new `/ace:connect-login` slash command for MFA/SSO edge cases.
- `bin/ace-doctor` now reports `connect_env` and `connect_session`
  freshness alongside the existing OCS/Drive checks.
- `.env.tpl` adds `CONNECT_BASE_URL`, `ACE_HQ_USERNAME`,
  `ACE_HQ_PASSWORD` (1Password-backed via `ACE - CommCareHQ`).
- Probe scripts (`scripts/probe-connect-*`) plus captured HTML
  fixtures under `test/fixtures/connect-html/` for unit-testable
  scrape helpers — same durability pattern as the OCS contract probes.
- Live integration test at `test/mcp/connect/integration/e2e.integration.test.ts`,
  gated on `CONNECT_INTEGRATION=1`.

### Notes

- `ace@dimagi-ai.com` must be granted org `Admin` role in the target
  Connect organization. Without that, authoring atoms fail with HTTP
  errors or empty list scrapes (the user's view defaults to the
  network-member-side "Apply to Program" UI).
- v1 ships with conservative invoice atoms (page shape not yet
  observed) and no verification/delivery/payment-unit atoms (those
  concepts didn't surface on the program/opp pages we probed). Both
  gaps tracked as TODOs in `playwright.ts`.
- Skill rewrites (removing the `## Current Workaround` blocks)
  follow in subsequent PRs; this version ships only the MCP layer
  with full E2E coverage so consuming skills can adopt incrementally.

## 0.7.1 — 2026-04-28

Catch the class of silent-misconfig surfaced by the 2026-04-27
turmeric-dogfood run: `OCS_SHARED_COLLECTION_ID` set to an ID that
exists, but lives on a *different* OCS team. The previous
`ocs_shared_collection` doctor check only verified the env var was
non-empty, so it cheerfully PASSed `id=350` even though 350 belonged to
"NM Bot" on a team other than `OCS_TEAM_SLUG=connect-ace`. Every
cloned per-opp bot then inherited the wrong domain's RAG, with no
signal until LLOs got bot answers grounded in the wrong handbook.
Surfaced as canopy session-review finding #5 in the 2026-04-28 cycle.

### Changed

- **`bin/ace-doctor`** — new `ocs_shared_collection_team` sub-check
  that follows the existing env-set check. If `OCS_SHARED_COLLECTION_ID`,
  `OCS_TEAM_SLUG`, `OCS_BASE_URL`, and a Playwright session at
  `~/.ace/ocs-session-$OCS_TEAM.json` are all present, GETs
  `/a/$TEAM/documents/collections/$ID` with the session cookies and
  branches on status: 200 PASSes ("collection $ID exists on team $TEAM"),
  404 WARNs with a fix pointer to the OCS UI, 301/302 silently defers to
  the existing `ocs_session` warning (session expired), and other codes
  WARN with a connectivity hint. WARN, not FAIL, per the runtime-health
  convention. Sub-second probe (--max-time 3); cookies extracted via a
  single `node -e` from the existing session JSON, no new deps.

### Why now

Two earlier cycles (the 0.5.x dotenv passthrough fix and the 0.6.x Drive
shared-drive canary) established the same lesson: silent misconfig
surfaces days after the run, not at startup. A 50ms probe at doctor time
catches the entire class — env var set vs. env var pointing at the right
thing — and matches the existing `drive_shared` precedent of taking one
HTTP probe to differentiate "configured" from "configured correctly."

## 0.7.0 — 2026-04-28

Flatten the ACE agent dispatch tree so every `Agent` call originates at
level 0 (the top-level Claude Code session). The `Agent` tool is
unavailable to subagents, so any node that dispatches further work
cannot itself be a subagent. The previous design dispatched the
orchestrator as a subagent, which silently broke Phase 2 the moment
the 0.6.0 Nova-plugin migration landed: `/nova:autobuild` dispatches
`nova:nova-architect-autonomous` via `Agent`, and an
orchestrator-as-subagent placed that dispatch at level 2 where `Agent`
isn't reachable. The first e2e validation run after 0.6.0 surfaced
this as a hard halt at `pdd-to-learn-app` / `pdd-to-deliver-app`.

The fix is structural: `ace-orchestrator` and `commcare-setup` become
procedure documents that the top-level session reads and executes
inline (they call `Agent`, so they must run at level 0). The other
five phase agents (`design-review`, `connect-setup`, `ocs-setup`,
`llo-manager`, `closeout`) plus `ocs-tester` are clean leaves — they
use MCP tools and skill prompts but never dispatch — and stay as
subagents launched from level 0. There are never two levels of
`Agent` dispatch.

### Changed

- **`commands/run.md`** — Step 2 changes from "Dispatch to the
  ace-orchestrator agent" to "Execute the orchestration procedure
  inline at top-level. Read `agents/ace-orchestrator.md` and follow
  it." Smart-default and post-run sections updated to match.
- **`commands/step.md`** — Step 5 clarifies that skills run inline at
  top-level so `Agent` is available, required for any skill that
  invokes `/nova:autobuild` or otherwise dispatches a subagent.
- **`agents/ace-orchestrator.md`** — Opening section reframed as a
  procedure-doc preamble. New `## Agent Topology` table is the
  authoritative spec of which agents are subagents vs procedure docs.
  Phase 2 dispatch line changes from "Dispatch to the commcare-setup
  agent" to "Execute the procedure in `agents/commcare-setup.md`
  inline" with a one-paragraph rationale referencing the topology
  rule. Defensive-init bypass-paths note tightened to mark
  `commcare-setup` as not directly `Agent`-dispatchable.
- **`agents/commcare-setup.md`** — Opening reframed as a procedure-doc
  preamble citing the `/nova:autobuild` → architect dispatch chain as
  the reason Phase 2 cannot be a subagent.
- **`CLAUDE.md`** — New `## Agent topology` section at the top of the
  file is the canonical reference for the rule. The `## Layout`
  bullet for `agents/` is rewritten to reflect the two-form split. The
  intro paragraph picks up the same framing.

### Why now

This is the right scope for the lesson. A narrower fix (only
flattening the orchestrator) would leave `commcare-setup`-as-subagent
dispatching `/nova:autobuild` and recreate the same bug at the next
level down. A wider fix (flattening every phase agent) gives up real
agent isolation for the five phases that don't need it. The
"call-graph determines form" invariant is the smallest rule that
covers all current and likely-future skill compositions without
reintroducing the trap.

## 0.6.11 — 2026-04-28

Docs only. Closes out the 2026-04-27 turmeric-dogfood cycle by recording
its full arc — including the same-day fixes shipped 0.6.4 → 0.6.9 → 0.6.10
— in the cross-opp run log.

### Changed

- **`.claude/pm/runs/2026-04-28-turmeric-dogfood-ocs-contracts.md`**
  gains an "Addendum 2" section documenting the N1 (PR #64) and N2
  (PR #63) fixes that landed on the same day as the validation pass that
  surfaced them. Records the 6-case OCS variable truth table and the
  cycle-closing backlog state (P2 + P6 + N3 remain open).

## 0.6.10 — 2026-04-28

Closes **N1** from the 2026-04-28 turmeric-dogfood addendum: the
`{collection_index_summaries}` rejection that defeated 0.6.4's
transactional save. Characterized via direct probes against live OCS
(see `scripts/probe-n1-cross-test.ts` for the full truth table).

### Root cause

The 0.6.4 pre-flight checked the wrong invariant. Real OCS rule:

| collections | `{collection_index_summaries}` in prompt | OCS save |
|---|---|---|
| 0 | absent | ACCEPTED |
| 0 | present | rejected ("variable is missing") |
| 1 | absent | ACCEPTED |
| 1 | present | **rejected** ("variable is missing") |
| ≥2 | absent | **rejected** ("Prompt expects ... variable") |
| ≥2 | present | ACCEPTED |

In words: **the variable is required if and only if `collection_index_ids.length >= 2`.**
Single or zero collections must NOT include the variable; multiple
collections MUST include it. Architectural intuition: with a single
collection there's nothing to disambiguate at retrieval time; the
variable is a multi-collection feature.

The 0.6.4 framing of the bug ("transactional save" = bundling prompt +
collections in one POST) was correct for *one* of the failure modes
(ordering between two focused atom calls) but the underlying pre-flight
rule was wrong, so the transactional atom could still produce a
violating final state.

### Fixed

- **`assertCollectionPromptInvariant` shared helper** — bidirectional
  check matching the live rule. Used by both `attachKnowledge` and
  `setChatbotPipeline`. Throws a typed `PipelineValidationError` on
  either violation direction with a fix hint pointing at the right
  remediation (drop the variable or attach more collections).
- **Tool descriptions** for `ocs_attach_knowledge` and
  `ocs_set_chatbot_pipeline` now state the iff rule explicitly.
- **`skills/ocs-agent-setup/SKILL.md` step 7** corrected — single-
  collection clones (`OCS_SHARED_COLLECTION_ID` unset) must NOT include
  the variable; multi-collection clones (shared + opp) MUST.

### Validated

`scripts/probe-n1-cross-test.ts` exercised six combinations against live
OCS bot 12003. Test cases A/B (single collection, no variable) accepted;
C (multi without variable) rejected; D/F (single + variable) rejected;
E (multi + variable) accepted. Bot was restored to a known-good state
after the run. 8 new unit tests cover the same truth table against
mocked saves.

### Notes

- The orchestrator's earlier workaround (drop the variable from the
  per-opp clone's prompt; RAG still works via the single-collection
  binding) was correct. The `9.1/10` validation eval used exactly this
  state — single per-opp collection, no variable in prompt — and that's
  the canonical per-opp shape going forward.
- Probe scripts (`probe-n1-pipeline-diff.ts`,
  `probe-n1-add-variable.ts`, `probe-n1-collection-meta.ts`,
  `probe-n1-cross-test.ts`) are kept under `scripts/` — they document
  the investigation and remain useful if OCS ever changes the rule.

## 0.6.9 — 2026-04-28

Closes N2 from the 2026-04-28 turmeric-dogfood addendum: `experiment_id`
returned `null` from `ocs_list_chatbots` and `ocs_get_chatbot` against
live OCS, even though 0.6.1 shipped a fix and 137 unit tests passed.

### Root cause

The 0.6.1 URL-regex parser assumed `/api/experiments/` returned each
result's human-facing chatbot URL (`/a/<team>/chatbots/<int>/`). The
live API actually returns the API URL (`/api/experiments/<uuid>/`).
Confirmed via probe in `scripts/probe-list-chatbots-shape.ts`. The unit
test fixtures had the wrong shape, so the regression slipped through CI.

### Fixed

- **Composite enrichment for `experiment_id`.** When the REST-level URL
  regex returns `null` (which is now always against live OCS),
  `CompositeBackend.listChatbots` and `getChatbot` enrich each result by
  scraping the team's `/a/<team>/chatbots/table/` HTMX endpoint for a
  `name → integer` map and matching by name. One Playwright call per
  list/get; if the scrape fails (auth expired etc.), `experiment_id`
  stays `null` rather than failing the whole call.
- **`parseChatbotTable` helper** (in `playwright.ts`) — anchors on
  `id="record-<int>"` plus the first `<a>NAME</a>` after it. Captured
  from the real connect-ace table HTML on 2026-04-28.
- **`extractExperimentId` regex tightened** to `/a/<team>/chatbots/<int>/`
  shape only — so the API URL `/api/experiments/<uuid>/` correctly
  returns `null` and triggers the composite enrichment fallback.

### Validated

End-to-end probe against live OCS (`scripts/probe-composite-list.ts`):
5/5 chatbots in the connect-ace team resolve to integer `experiment_id`
through the composite enrichment path. Bots with duplicate names map to
whichever row appeared last; the SKILL flow produces unique names per
opp so this isn't load-bearing.

### Notes

- N1 (variable-rejection edge case where OCS rejects pipeline-save when
  prompt has `{collection_index_summaries}` even with non-empty
  collections in the same save) is **not** fixed in this PR. The 0.6.4
  pre-flight model of the bug ("intermediate-state cross-field
  violation") was wrong; the actual server-side rule is stricter and
  needs OCS-side investigation. Workaround documented in
  `comms-log/observations.md`: drop the variable from the prompt; RAG
  still works via the collection binding.

## 0.6.8 — 2026-04-28

`/ace:doctor` now detects when the Nova or connect-labs sibling plugins
are not installed. Both produce silent failure modes: without Nova, Phase
2 (commcare-setup) writes stub artifacts instead of real CommCare apps;
without connect-labs, Phase 3 (connect-setup) cannot actually create
Programs or Opportunities. Operators historically discovered these
mid-run, days after the env had silently degraded.

### Changed

- **`bin/ace-doctor`** — replaces the soft `connect_labs: available`
  check (which was satisfied by either a non-existent `connect-mcp`
  command OR the repo being cloned, neither of which proves the plugin
  is loaded) with two authoritative checks against
  `~/.claude/plugins/installed_plugins.json`:
  - `nova_plugin` — PASS if `nova@*` is installed; otherwise WARN with
    the install command.
  - `connect_labs_plugin` — PASS if any key containing `connect-labs`
    is installed; otherwise WARN.
  - The local-repo signal is preserved as `connect_labs_repo` (dev mode
    hint, separate from plugin-installed state).

  Surfaced by canopy session-review findings #3 and #4 (2026-04-28
  cycle), which observed Phase 2 + Phase 3 silently HITL-degrading
  during dogfood runs because the operator had not realized the
  sibling plugins weren't loaded.

## 0.6.7 — 2026-04-28

`/ace:update` Step 1 now reads the remote VERSION via `git fetch` + `git
show origin/main:VERSION` against the local marketplace clone, replacing
the previous `curl https://raw.githubusercontent.com/...` call. The raw
endpoint is CDN-cached for 1–5 minutes, which made `/ace:update`
spuriously report `UP_TO_DATE` immediately after a push and forced
operators to wait on cache propagation before they could install the
version they had just shipped. Git fetch is uncached, so Step 1 now
agrees with Step 2's `git pull`.

### Changed

- **`commands/update.md`** — Step 1 swaps `curl
  raw.githubusercontent.com/.../VERSION` for `git -C $MARKETPLACE fetch
  origin main && git show origin/main:VERSION`. Adds a marketplace-
  missing error path. `bin/ace-update-check` (the SessionStart banner)
  is intentionally left on the curl path — it has a 1-hour cache and
  the CDN delay isn't user-visible there.

## 0.6.6 — 2026-04-28

Ship `ACE_HQ_DOMAIN` as a committed default in `.env.tpl` so fresh
operator installs land with the canonical CRISPR-Connect HQ project
space (`connect-ace-prod`) pre-populated for the Nova-plugin upload
flow introduced in 0.6.0. Previous template left it commented with a
"set per deployment" note; in practice there is one ACE deployment
and one HQ domain, so the template now reflects that.

### Changed

- **`.env.tpl`** — uncommented `ACE_HQ_DOMAIN` and set it to
  `connect-ace-prod`. Surrounding comment trimmed to drop the
  obsolete "leave commented out" guidance.

## 0.6.5 — 2026-04-28

Doc-only patch landing the "all blockers cleared" state for the
Nova-plugin migration that 0.6.0 introduced. End-to-end Phase 2 was
smoke-tested on 2026-04-28: `/nova:autobuild` produced both a Learn
and a Deliver app under the ACE service identity, and
`/nova:upload_to_hq` round-tripped both to the configured HQ project
space with zero warnings.

### Changed

- **`playbook/integrations/nova-integration.md`** — `## Status`
  flipped from "gated on OAuth allowlist fix" to "Live, end-to-end
  smoke test passed". `## Known blockers` renamed to `## Resolved
  blockers (kept for record)` and both the Nova-side OAuth allowlist
  and the Workspace 2FA policy are documented as cleared. New `## ACE
  service identity for Nova` section captures the convention that
  ACE binds the Nova MCP plugin to `ACE_GMAIL_ACCOUNT`'s real Google
  identity (not a service account) so Nova-side state stays in one
  place across sessions.

## 0.6.4 — 2026-04-28

Closes the P1 follow-up from the 2026-04-28 run log: the
`set_chatbot_system_prompt` ↔ `attach_knowledge` chicken-and-egg that
blocked the previous Phase 4 re-run mid-flight.

### Added

- **`ocs_set_chatbot_pipeline` MCP atom (transactional save).** Updates
  the LLMResponseWithPrompt node's params — prompt, collection_index_ids,
  max_results, generate_citations, source_material_id, and the four tool
  arrays — in a single GET-mutate-POST cycle. Any field omitted is
  preserved from the existing state. Pre-flight: if the *final* prompt
  (after merge) contains `{collection_index_summaries}`, the *final*
  collection_index_ids must be non-empty; otherwise a typed
  `PipelineValidationError` fires before the POST. This is the canonical
  unblock for the case the orchestrator hit on 2026-04-27: prompt and
  collection state changing in the same operator-visible step, with
  ordering between the two focused atoms causing OCS to reject the
  intermediate save.

### Changed

- **`skills/ocs-agent-setup/SKILL.md` step 8** collapsed into a single
  `ocs_set_chatbot_pipeline` call. Previously two calls
  (`ocs_set_chatbot_system_prompt` + `ocs_attach_knowledge`); now one
  transactional save with both prompt and collections set together.
- **`ocs_set_chatbot_system_prompt` and `ocs_attach_knowledge` tool
  descriptions** now point at the bundled atom for the both-changing case
  and remain the right pick when only one is changing.

### Notes

- The 0.6.3 dogfood's hypothesis (*partial save semantics*) turned out
  not to be the literal mechanism — the existing `patchLlmNodeParams`
  already does GET full graph → mutate → POST full graph. The bug was
  that *between* two focused atom calls, the intermediate POSTed state
  itself violated the cross-field invariant (variable in prompt but
  empty collections, or vice versa). Bundling the changes into one POST
  sidesteps the intermediate state entirely.
- `ocs_archive_chatbot` (P2 from the run log) is a separate follow-up.

## 0.6.3 — 2026-04-28

Docs only. Captures the 2026-04-27 turmeric-dogfood cycle in the standard
PM run-log format and adds a short *Improvement cycles & canopy* section
to `CLAUDE.md` so future sessions know where per-opp evidence ends and
cross-opp strategy begins.

### Added

- **`.claude/pm/runs/2026-04-28-turmeric-dogfood-ocs-contracts.md`** —
  full cycle log: lens, what shipped (0.5.18 + 0.6.1), six-item backlog
  ranked P1–P6 (P1 is the `set_chatbot_system_prompt` partial-save bug
  blocking any future Phase 4 re-run), meta-observations on real-run-vs-
  spec-review and class-level preventers.
- **`CLAUDE.md` § Improvement cycles & canopy** — four short paragraphs
  on the Drive-vs-`.claude/pm/runs/` boundary, re-entry pattern
  (`/canopy:pm-status` or read latest run log), when to write a run log,
  and the canopy commands available in this repo.

## 0.6.2 — 2026-04-27

### Added

- **`upload-transcript` now sends `ace_root_folder_id`** alongside the
  existing `opp_slug` / `opp_run_id` / `opp_step_skill` multipart fields.
  Populated from `$ACE_DRIVE_ROOT_FOLDER_ID` when set (omitted otherwise).
  Pairs with the multi-tenancy work on the ace-web side
  (`labs.connect.dimagi.com/ace`): when the value matches a Workspace's
  `drive_root_folder_id` and the uploading user is a member, the
  resulting Session and IngestUpload are attributed to that workspace
  and surface in its linked-chats panel. Without it, uploads still
  succeed but land as orphans (workspace=NULL) visible only to the
  uploading user — fine for solo dogfooding, broken for third-party
  Connect Tech users running ACE against the shared deploy.

## 0.6.1 — 2026-04-27

Closes two OCS contract bugs surfaced during the same dogfood run that
shipped 0.5.18. The first run reached the `ocs-chatbot-eval-deep` gate
with a composite of 6.5/10 (Source-Usage 1/10, RAG functionally broken)
*and* surfaced two MCP contract issues that would have blocked any
self-improve loop trying to autonomously re-attempt setup.

### Fixed

- **`ocs_list_chatbots` and `ocs_get_chatbot` now return the integer
  `experiment_id` alongside the UUID `id`.** OCS's REST serializer
  exposes `id` as the UUID public_id, but every authoring atom
  (`ocs_set_chatbot_system_prompt`, `ocs_attach_knowledge`,
  `ocs_publish_chatbot_version`, …) requires the integer experiment_id.
  The skill's idempotency contract — "if a bot for this opp already
  exists, reconfigure it instead of cloning a duplicate" — was
  unachievable in practice because the int id wasn't reachable from the
  list response. The new field is parsed from the human-facing `url`
  field (`/a/<team>/chatbots/<experiment_id>/`). Closes the orphan-
  re-clone footgun the previous run hit when resuming after an
  interrupted clone.

- **`ocs_attach_knowledge` pre-flights that the bot's current system
  prompt contains the `{collection_index_summaries}` template
  variable.** When the prompt is missing this token, OCS's
  pipeline-save endpoint silently rejects the patch and every
  downstream `publish_chatbot_version` is then blocked with an opaque
  UI message — same Iter 6 silent-failure class as the 2026-04-19
  phantom-collection bug fixed in 0.5.1. The MCP now fails fast with a
  typed `PipelineValidationError` naming the missing token and the
  remediation (call `ocs_set_chatbot_system_prompt` with a prompt that
  embeds it). Detach paths (`collection_index_ids: []`) skip the check,
  so cleanup operations remain unblocked.

### Changed

- **`skills/ocs-agent-setup/SKILL.md`** — Step 2 (idempotency) now
  reads the integer `experiment_id` directly from `ocs_list_chatbots`
  results. Step 7 (system-prompt composition) explicitly requires the
  `{collection_index_summaries}` template variable in the new prompt
  and explains why.

### Notes for next run

The 6.5/10 deep-eval composite from the 2026-04-27 dogfood was held
down by a *live* configuration bug (`OCS_SHARED_COLLECTION_ID=350`
points at a wrong-domain NM Bot collection that leaks immunization
content into every cloned ACE bot) — that's an env / vault fix, not a
code fix. Track + fix in a follow-up; this PR's scope is the contract
hygiene. The orphan turmeric chatbot from the previous run remains
reachable on OCS (no `ocs_delete_chatbot` / `ocs_archive_chatbot` atom
yet — also follow-up).

## 0.6.0 — 2026-04-27

Migrates Phase 2 (CommCare Setup) off the manual Nova-UI / HQ-UI
handoff and onto the new Nova Claude Code plugin
(`voidcraft-labs/nova-marketplace`, shipped 2026-04-26 by Braxton).
The three Phase-2 skills now drive Nova through its slash commands
instead of telling the operator to fill out a form. Nova owns the app
storage; ACE only records the durable handle (`nova_app_id`) and the
HQ deployment outcome.

End-to-end Phase 2 is currently gated on an OAuth allowlist fix on
Nova's side (the Workspace domain ACE authenticates as is not yet
allowed by Nova's OAuth client) — until that lands, the operator's
HQ API key cannot be pasted into Nova's settings page and
`app-deploy`'s pre-flight will surface the resulting domain mismatch
as a `[BLOCKER]` in the Phase 2→3 gate brief. See
`playbook/integrations/nova-integration.md § Known blockers`.

### Changed

- **`pdd-to-learn-app` / `pdd-to-deliver-app`** invoke
  `/nova:autobuild "<brief>"` instead of writing a brief and asking the
  operator to drive Nova's UI. Output is `nova_app_id` /
  `nova_app_url` / `archetype` (plus `delivery_unit` for deliver) in
  the app summary frontmatter, not a JSON file.
- **`app-deploy`** invokes `/nova:upload_to_hq <nova_app_id>` for each
  app. Pre-flights `ACE_HQ_DOMAIN` against Nova's bound HQ project
  space, captures the resulting HQ app IDs and URLs into
  `deployment-summary.md` (now with explicit `hq_domain`,
  `learn_nova_app_id`, `deliver_nova_app_id` frontmatter), and emits a
  `[BLOCKER]` in the gate brief on domain mismatch.
- **Artifact manifest:** `apps/learn-app.json` and
  `apps/deliver-app.json` are now `required: false` with
  `consumedBy: []`. `app-deploy` is added as a consumer of
  `app-summaries/learn-app-summary.md` and `deliver-app-summary.md`.
- **`playbook/integrations/nova-integration.md`** rewritten as a
  status doc rather than a "what needs exploration" doc. Covers
  install, ACE's surface area, the HQ-domain-via-Nova-settings
  coupling, and the OAuth allowlist blocker.
- **`CLAUDE.md`** drops "Nova MCP does not exist yet"; adds the Nova
  plugin install dependency note.

### Added

- **`.env.tpl`:** `ACE_HQ_BASE_URL` (default
  `https://www.commcarehq.org`) and `ACE_HQ_DOMAIN` (declared
  commented-out — operators set the project space per deployment).
  Both are read by `app-deploy`'s pre-flight to compare against
  Nova's bound HQ project space.
- **`test/skills/nova-contracts.test.ts`:** 27 new contract tests
  pinning the migration — invocation patterns, summary frontmatter,
  manifest shape, fixture frontmatter — so a future edit can't
  silently regress to the workaround flow. Existing fixtures at
  `test/fixtures/CRISPR-Test-{001,002,003-Turmeric}/` gained the
  required summary frontmatter.

### Operator notes

- Install Nova once per machine:
  `/plugin marketplace add voidcraft-labs/nova-marketplace` then
  `/plugin install nova@nova-marketplace` then `/mcp` and sign in.

## 0.5.18 — 2026-04-27

Closes a class-level Drive-write footgun surfaced on the first real
end-to-end dogfood run of `/ace:run`. Symptom: after `drive_create_folder`
appeared to succeed, every subsequent `drive_create_file` failed with
*"The user's Drive storage quota has been exceeded."* Root cause: when
`parentFolderId` was unset, empty, or otherwise unresolved against the
configured Shared Drive, the API silently created the new folder in the
service account's My Drive root — where SAs have zero quota — and every
file write into that folder then hit the misleading quota error. The MCP
tool descriptions invited this with *"omit to create in root"*, which is
never a safe default for an SA-backed deploy.

### Fixed

- **`drive_create_file` and `drive_create_folder` now require
  `parentFolderId` and pre-flight that the parent lives on a Shared
  Drive.** Implementation: a single `assertParentOnSharedDrive` helper
  fetches the parent's `driveId` (Shared-Drive files have one, My Drive
  files don't) and rejects the create with a typed actionable error if
  it's empty. Catches the entire silent-My-Drive-fallback class at the
  MCP boundary, before any API write attempt.

### Added

- **`/ace:doctor` Shared-Drive canary.** Probes
  `ACE_DRIVE_ROOT_FOLDER_ID` against the Drive API and reports
  `drive_shared PASS` (with the Shared Drive ID) or `drive_shared FAIL`
  with the same actionable message as the MCP guard. Runs alongside the
  existing `drive_root` env-presence check. Operators see the wall before
  hitting it on the first opp.

### Changed

- **`agents/ace-orchestrator.md` § Starting a New Opportunity** — calls
  out the Shared-Drive precondition and points at the doctor check.
- **`skills/README.md`** — adds the Drive parent contract: every
  `drive_create_file` / `drive_create_folder` must pass an explicit
  `parentFolderId` rooted in the opp folder; never rely on a default-root
  fallback.

### How to apply

Run `/ace:update` after pulling. New sessions will pick up the new
doctor check automatically. Existing My-Drive-stranded opp folders
(diagnosable via `drive_diagnose` returning a non-empty `owners` field
and absent `driveId`) should be trashed before re-running their slug,
otherwise the next `drive_list_folder` will still find the orphan.

## 0.5.17 — 2026-04-21

0.5.16 moved the MCP server config inline into `plugin.json` based on
upstream reports that inline declarations fixed
[anthropics/claude-code#9427](https://github.com/anthropics/claude-code/issues/9427).
In the eoi-llm-judge session on Claude Code 2.1.116, that move did **not**
fix it — `${CLAUDE_PLUGIN_DATA}` still arrives unexpanded in the MCP
subprocess's env, even though `${CLAUDE_PLUGIN_ROOT}` inside the `args`
field DOES get expanded in the same session (evidence: the server file
launches from the correct versioned cache dir). So on current Claude
Code, env-block substitution is broken independently of whether the
declaration lives in `.mcp.json` or `plugin.json.mcpServers`.

Rather than keep relying on an upstream substitution that may or may not
work, both MCP servers now **self-derive** their plugin-data directory
from their own module path at runtime. This is the real, upstream-
independent fix.

### Added

- **`lib/plugin-data-dir.ts`** — shared helper exporting
  `resolvePluginDataDir(import.meta.url)` and `derivePluginDataDir()`.
  The resolver tries `$CLAUDE_PLUGIN_DATA` first (so operators can still
  override, and future Claude Code versions that fix substitution will
  start using the env var automatically), then falls back to walking the
  caller's module path for a `plugins/cache/<mp>/<plugin>/<version>/...`
  segment and composing the `plugins/data/<mp>-<plugin>` sibling. Returns
  null for dev checkouts.
- **`logPluginDataDirDiag()`** — one-line JSON stderr diagnostic that
  prints `env_CLAUDE_PLUGIN_DATA`, `env_CLAUDE_PLUGIN_ROOT`,
  `env_CLAUDE_PLUGIN_ROOT_ECHO`, `derived_data_dir`, and `resolved_data_dir`
  at MCP startup. Lands in the Claude Code MCP log so anyone debugging a
  future session can see exactly which tier resolved and whether Claude
  Code's env substitution is working. Called once each by both servers.
- **`CLAUDE_PLUGIN_ROOT_ECHO` env entry** in the `plugin.json` `mcpServers`
  block. Pure diagnostic: the diag line will show whether
  `${CLAUDE_PLUGIN_ROOT}` expands in env values even when
  `${CLAUDE_PLUGIN_DATA}` doesn't.

### Changed

- **`mcp/google-drive-server.ts` `resolveKeyPath()` tier 2** now uses
  `resolvePluginDataDir(import.meta.url)` instead of raw
  `process.env.CLAUDE_PLUGIN_DATA`.
- **`mcp/ocs-server.ts` dotenv-path resolution** now uses the same
  helper. Previously it read `process.env.CLAUDE_PLUGIN_DATA` directly
  and silently fell back to `./.env` when the env var was missing —
  which was the root cause of the 401 on startup.

### Why

0.5.15 and 0.5.16 both shipped partial / wrong theories about this bug.
0.5.15 said "concatenated substitution is broken but pure is fine" —
wrong, both failed. 0.5.16 said "moving to inline `mcpServers` fixes it"
— based on an upstream thread that turned out to be about a different
variable (`${ASYMPTOTE_API_KEY}`, a user env var, not `${CLAUDE_PLUGIN_DATA}`),
and didn't help in our test. 0.5.17 stops relying on Claude Code's
substitution layer for the data dir altogether: the server knows where
it was installed and where its persistent data lives. The diagnostic
line means the next time this regresses we won't be guessing.

## 0.5.16 — 2026-04-21

Real root-cause fix for the gdrive-dark + ocs-401 pattern that 0.5.15
shipped a wrong theory for. Upstream bug confirmed:
[anthropics/claude-code#9427](https://github.com/anthropics/claude-code/issues/9427)
— Claude Code fails to substitute `${CLAUDE_PLUGIN_ROOT}` and
`${CLAUDE_PLUGIN_DATA}` inside a plugin's **root `.mcp.json`**, so
values arrive in the MCP subprocess as literal unexpanded strings
(or blank). The same substitution works correctly when the server
config lives **inline in `plugin.json` under `mcpServers`**. The bug
is still live on Claude Code 2.0.71/2.0.73/2.1.116 despite the issue
being closed-and-locked upstream, so a plugin-side workaround is
the only path forward today.

emdash's MCP launcher did not have this bug, which is why ACE had
been working for weeks under emdash and only surfaced when a user
switched to the Claude Code CLI in the same worktree.

### Fixed

- **MCP server configs moved inline into `.claude-plugin/plugin.json`
  under `"mcpServers"`, and plugin-root `.mcp.json` deleted.** Same
  shape, same env blocks, same commands — only the file they live
  in changes. This is a first-class, officially documented
  declaration point; see
  [code.claude.com/docs/en/mcp#plugin-provided-mcp-servers](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers).
  Both `ace-gdrive` and `ace-ocs` now receive `CLAUDE_PLUGIN_DATA`
  correctly at spawn time.

### Changed

- **`bin/ace-doctor` reads `plugin.json` `mcpServers`** instead of
  `.mcp.json` for both the manifest sanity check and the
  `mcp_env_passthrough` static check.
- **New `ace-doctor` warn**: if a stale `.mcp.json` is left at the
  plugin root alongside the inline `mcpServers`, warn and tell the
  operator to delete it. Some Claude Code versions merge the two
  sources; the `.mcp.json` entry would silently shadow the working
  inline one and re-break substitution.
- **`commands/setup.md` MCP check updated** to read
  `plugin.json.mcpServers` instead of `.mcp.json`.
- **Doc updates** in `README.md`, `CLAUDE.md`, `commands/doctor.md`,
  `docs/superpowers/specs/2026-04-01-ace-design.md`, and the
  comment in `mcp/google-drive-server.ts` pointing at the upstream
  issue so the next person debugging this has one-click context.

### Kept from 0.5.15

- The Node-side fallback chain in `google-drive-server.ts`
  (`GOOGLE_APPLICATION_CREDENTIALS` → `$CLAUDE_PLUGIN_DATA/gws-sa-key.json`
  → legacy plugin-root path) is retained as defense in depth. It
  doesn't fix 9427 — but it makes the server robust to the class of
  "env var should be there but isn't" failures regardless of cause.

### Why

0.5.15 shipped on the wrong diagnosis (concatenated substitution
fails while pure pass-through works). The actual data: `ace-ocs`
used the pure pass-through form in 0.5.14 and was **also** getting
empty `CLAUDE_PLUGIN_DATA` in the failing session — its 401 at
startup was the same signal as gdrive's throw, just behind a
non-fatal catch. The real break is at the plugin-root `.mcp.json`
substitution layer in Claude Code, not inside the format of the
values. Moving to the inline-in-`plugin.json` declaration point
sidesteps the broken code path entirely.

## 0.5.15 — 2026-04-21

Silent adoption blocker caught during the `eoi-llm-judge` kickoff
session: `ace-gdrive` failed to register at MCP spawn time with
"No Google service-account key found" even though the key was present
at `$CLAUDE_PLUGIN_DATA/gws-sa-key.json` and `ace-ocs` registered
successfully in the same session. Root cause mirrors the 0.5.7
`ace-ocs` fix, just in reverse: gdrive's `.mcp.json` env block used
a concatenated substitution (`"${CLAUDE_PLUGIN_DATA}/gws-sa-key.json"`)
where ocs used a pure pass-through (`"${CLAUDE_PLUGIN_DATA}"`). Claude
Code's `${...}` substitution is reliable for pure values but has been
observed to fail on concatenated values at spawn time — at least twice
on 2026-04-20/21 across `connect-labs` and `eoi-llm-judge` worktrees,
even while pure pass-throughs in the same `.mcp.json` continued to
work. Intermittent and session-launch-level: once gdrive fails to
spawn, the MCP is dead for the rest of the session.

The 0.5.9 `mcp_env_passthrough` doctor check didn't catch this because
gdrive's env block *did* reference `${CLAUDE_PLUGIN_DATA}` — just
concatenated, not pure. Follow-up: extend the check to also flag
concatenated substitutions.

### Fixed

- **`.mcp.json` ace-gdrive env block switched to pure pass-through.**
  Matches the pattern ocs adopted in 0.5.7: `"CLAUDE_PLUGIN_DATA":
  "${CLAUDE_PLUGIN_DATA}"`. The subprocess now composes the key path
  in Node instead of relying on Claude Code to splice the variable
  into a path string.
- **`mcp/google-drive-server.ts` `resolveKeyPath()` gains a
  `$CLAUDE_PLUGIN_DATA/gws-sa-key.json` lookup** between the existing
  `$GOOGLE_APPLICATION_CREDENTIALS` check and the legacy `<plugin-
  root>/.gws-sa-key.json` fallback. Path composition moves from
  `.mcp.json` to Node, which removes the class of intermittent-spawn
  bug the concatenated form exposed.

### Why

Every future session that hits the substitution bug would lose Drive
access with no clear diagnostic — the only tell is a stderr line in
the MCP log that Claude Code never surfaces to the user. Two-file
fix, zero surface area beyond the gdrive MCP subprocess. Same shape
as the 0.5.7 ocs fix, same rationale (move composition into Node so
Claude Code's substitution only has to handle pure variable values).

## 0.5.13 — 2026-04-20

Archetype audit extends to closeout: `llo-feedback` branches by
archetype so focus-group LLOs aren't asked about a Learn app they
never used. Feedback questions that miss the work the LLO actually
did produce thin responses + drift training data toward whichever
archetype was front-loaded in the survey.

### Added

- **`## Archetypes` section in `skills/llo-feedback/SKILL.md`.**
  `atomic-visit` (default) keeps app-usability, FLW-experience, and
  field-conditions questions. `focus-group` swaps in question-guide
  quality, facilitation experience, audio+upload workflow,
  participant recruitment, session cadence, and asks specifically
  "what would make the question guide better for a follow-up round?"
  `multi-stage` asks per-stage questions (one pass per stage the LLO
  owned) plus cross-stage transition quality and pipeline coherence;
  one survey per LLO to avoid fatigue.
- **Improvement-suggestion tagging** on the output file: entries
  tagged by archetype dimension (app usability / session facilitation
  / stage transitions / support / training / other) so
  `learnings-summary` and `cycle-grade` can aggregate consistently
  across the archetype mix.

### Why

Fourth and final archetype-branching PR of this session. Full Phase 5
LLO-facing coverage now archetype-aware end-to-end:

- `llo-onboarding` (0.5.10) — first email
- `llo-uat` (0.5.11) — UAT checklist
- `llo-launch` (0.5.12) — go-live
- `llo-feedback` (0.5.13) — closeout feedback ← this release

Archetype-aware skill count: 12 → 13.

## 0.5.12 — 2026-04-20

Archetype audit closes the Phase 5 LLO-facing trio: `llo-launch` gets
per-archetype readiness checks and go-live semantics. "Your
opportunity is live — FLWs can now use the apps" is exactly the wrong
email for a focus-group pilot whose first artifact is a scheduled
Session 1, not a downloadable app. Same Connect activation action;
different readiness criteria, notification subject, and launch-record
shape per archetype.

### Added

- **`## Archetypes` section in `skills/llo-launch/SKILL.md`.**
  `atomic-visit` (default) keeps Learn/Deliver app-build verification
  and the "You Are Live!" subject. `focus-group` replaces
  app-readiness with **Session 1 readiness** — venue, recording gear
  tested, audio-upload path verified, participant recruitment at
  target, consent practiced — and flips the subject to "Session 1 is
  on the calendar!" (not "You Are Live," which is FLW-deployment
  coded). `multi-stage` pins activation to Stage 1's protocol; each
  stage gets its own `llo-launch` invocation and `launch-record-stage-N.md`
  so per-stage history is preserved.
- **Gate-brief "What to Check" item 3** now swaps in the archetype-matched
  delivery-surface bullet instead of hardcoding "All apps built and
  downloadable."
- **Launch-record `archetype_details`** captured per archetype so
  `timeline-monitor` keys off the right cadence and milestones (session
  schedule for FGD, first-delivery date for atomic-visit,
  stage-transition window for multi-stage).

### Why

Third archetype-branching PR of this session. Closes the Phase 5
LLO-facing trio:
- `llo-onboarding` (0.5.10) — first email
- `llo-uat` (0.5.11) — UAT checklist
- `llo-launch` (0.5.12) — go-live ← this release

Any Phase 5 opp under any archetype now gets archetype-appropriate
LLO-facing artifacts end-to-end. Remaining atomic-visit-biased Phase
5 skill: `llo-feedback` (potential stretch — not blocking go-live).

Archetype-aware skill count: 11 → 12.

## 0.5.11 — 2026-04-20

Archetype audit continues: `llo-uat` gets per-archetype UAT checklists.
FGD LLOs aren't testing a CommCare app — they're dry-running a
facilitation session. Atomic-visit "download the Learn app and test
every module" instructions to a focus-group LLO produce confused
recipients and silent UAT stalls.

### Added

- **`## Archetypes` section in `skills/llo-uat/SKILL.md`.**
  `atomic-visit` (default) keeps the existing Learn-app / Deliver-app
  checklist. `focus-group` replaces "test the apps" with **"dry-run a
  facilitation session"**: question-guide walk-through, recording
  workflow, consent flow, session-note template fit, venue/logistics
  check. Sign-off criterion flips to "you could run Session 1
  tomorrow." Specifically surfaces dry-run duration as a must-flag
  signal (session-length mismatches are the first thing dry-runs
  expose and the hardest to fix mid-study). `multi-stage` uses
  per-stage UAT — full checklist for Stage 1, reference-only for
  later stages with their own dedicated UAT windows.
- **Step 2 of the Process** now reads the PDD's `archetype:` field and
  routes to the appropriate subsection. UAT results file records the
  archetype so `llo-launch` applies matching go-live criteria.

### Why

Third shipping archetype-branching PR this session. Pairs with:
- `llo-onboarding` (0.5.10) — email framing
- `llo-uat` (0.5.11) — UAT checklist ← this release

Archetype-aware skill count: 10 → 11.

## 0.5.10 — 2026-04-20

Archetype audit: `llo-onboarding` adds per-archetype email framing.
First LLO-facing artifact of the entire pipeline. Atomic-visit language
("your FLWs will start collecting deliveries") lands as obviously wrong
to an org that's running focus groups, and corrodes trust before the
first session. Branch the welcome framing, the "getting started" step
list, material emphasis, and timeline cadence by the PDD's `archetype:`
field.

### Added

- **`## Archetypes` section in `skills/llo-onboarding/SKILL.md`.**
  `atomic-visit` (default) keeps the existing FLW-download-app flow.
  `focus-group` addresses the recipient as a facilitator-owning org,
  leads with question guide + audio upload, and uses session-count
  cadence language ("N sessions over T weeks"). `multi-stage`
  front-loads Stage 1 content and names the stage transition explicitly.
- **Step 3 of the Process** now reads the PDD's `archetype:` field and
  routes to the appropriate subsection.

### Why

The 2026-04-19 iteration loop established archetype branching as a
"one skill, one PR" unit of work. `pdd-to-test-prompts` (0.4.1) and
`llo-invite` (0.4.2) shipped that way. `llo-onboarding` is the next
high-leverage skill because its output is the **first thing an
external LLO sees from ACE** — getting the framing wrong there is the
largest bad-send risk in the pipeline. PM log 2026-04-19 carried
"Archetype coverage audit (P4)" as standing backlog.

Archetype-aware skill count: 9 → 10.

## 0.5.9 — 2026-04-20

Close the class of silent-MCP-stall that 0.5.7 fixed for one server.
`/ace:doctor` now statically verifies that every MCP server which reads
`$CLAUDE_PLUGIN_DATA/.env` via dotenv also has `CLAUDE_PLUGIN_DATA`
in its `.mcp.json` env block. If it doesn't, the subprocess spawns with
an empty env, dotenv silently falls back to the wrong cwd, every secret
reads as undefined, and the failure surfaces as opaque 401/403s on the
first tool call — exactly the pattern that stalled turmeric Phase 4.

### Added

- **`mcp_env_passthrough` check in `bin/ace-doctor`.** For each entry
  in `.mcp.json`, parses the referenced `.ts`/`.js` source, detects the
  dotenv + `CLAUDE_PLUGIN_DATA` pattern, and WARNs if the `.mcp.json`
  env block for that server omits `CLAUDE_PLUGIN_DATA`. Verified it
  catches the pre-0.5.7 `ace-ocs` state and passes on current main.

### Why

0.5.7 fixed one instance of the bug; 0.5.9 prevents the next one.
Any future MCP server that hits this pattern (e.g. a new `ace-foo`
subprocess reading a new secret from `.env`) is flagged by
`/ace:doctor` before the operator hits an opaque 401 in production.

## 0.5.8 — 2026-04-20

Adoption-blocker follow-through: the env-drift class closed in 0.5.4
left one unaudited subclass — `.env.tpl` declaring variables that no
code actually reads. Operators went through the ceremony of injecting
them and pasting them into `.env` for no runtime benefit. This release
deletes the dead vars, reframes the bootstrap output to keep 1Password
as the source of truth, drops `.env.example` (redundant with `.env.tpl`),
and adds a class-level preventer so future dead-var additions get
caught automatically.

### Removed

- **4 dead environment variables deleted from `.env.tpl`.** None of
  these had any consumer in `mcp/`, `lib/`, `scripts/`, `skills/`,
  `bin/`, `hooks/`, `agents/`, `commands/`, or `test/`:
  - `OCS_GOLDEN_TEMPLATE_PUBLIC_ID` — printed by bootstrap and pasted
    into `.env` per README, but the per-opp `ocs-agent-setup` skill
    retrieves its own public_id via `ocs_get_chatbot_embed_info` after
    cloning. The golden template's value was never used at runtime.
  - `OCS_GOLDEN_TEMPLATE_EMBED_KEY` — same pattern, same dead code
    path.
  - `OCS_PROD_TEAM_SLUG` — declared, injected from 1Password, zero
    consumers anywhere.
  - `ACE_SESSION_STATE_DIR` — declared with value `~/.ace`, but every
    consumer hardcodes `path.join(os.homedir(), '.ace', ...)` rather
    than reading this var.
- **`.env.example` deleted.** Two-file pattern (`.env.tpl` for
  `op inject`, `.env.example` for manual setup) was a holdover from
  pre-1Password setup. `.env.example` was already drifting from
  `.env.tpl` (missing `ACE_DRIVE_ROOT_FOLDER_ID` and `OCS_PROD_TEAM_SLUG`).
  `.env.tpl` is now the single canonical template.

### Added

- **`bin/ace-doctor` `unused_env_keys` check.** For each `KEY=` in
  `.env.tpl`, greps `mcp/ lib/ scripts/ skills/ bin/ hooks/ agents/
  commands/ test/` for consumers. WARNs with the list of keys that
  have no code consumer, and the fix hint ("drop them from .env.tpl,
  or wire them into a consumer"). Informational (WARN) — dead vars
  don't break the install, they just add first-run friction. Class-
  level preventer, so future template additions without a real
  consumer get surfaced automatically.

### Changed

- **Bootstrap output reframed: 1Password is source of truth, not
  local `.env`.** `scripts/bootstrap-ocs-golden-template.ts` no
  longer prints "Add to your ACE .env:" with paste-this values.
  Instead it prints the two commands operators should actually run:
  `op item edit "ACE - Open Chat Studio" "Config.golden_template_id[text]=<new_id>" --vault AI-Agents` to update the vault, then `op inject -i .env.tpl -o ~/.claude/plugins/data/ace-ace/.env` to regenerate the local `.env`. Closes the drift hole the 2026-04-20 "vault values are hypotheses too" learning identified: a pasted value silently reverts on the next `op inject` if the vault wasn't updated in lockstep.
- **README First-Run step 6** and
  **`commands/ocs-bootstrap-template.md`** updated to match the new
  bootstrap output. First-run walkthrough now has a coherent single
  workflow (update vault, re-inject, reload) instead of two
  contradictory ones (paste to `.env` + also re-inject rewrites
  `.env`).
- **`playbook/integrations/ocs-integration.md`** now points at
  `.env.tpl` instead of the deleted `.env.example`.

### Why

The 2026-04-20 adoption-blockers cycle closed the "keys declared in
`.env.tpl` but missing from the installed `.env`" class via a doctor
diff (`env_drift`). What wasn't audited: the inverse class — keys in
`.env.tpl` that are dead cruft. A fresh install's first-run
walkthrough currently tells the operator to paste three values into
`~/.claude/plugins/data/ace-ace/.env` after bootstrap. Two of those
three are never read anywhere. The third (`OCS_GOLDEN_TEMPLATE_ID`)
would silently revert on the next `op inject` because `.env.tpl`
declares it as an `op://` reference. Fixing all three sources of
friction in one release keeps the story coherent.

## 0.5.7 — 2026-04-20

Silent auth failure caught during turmeric Phase 4 resume: every
`ace-ocs` tool call returned 401 with an empty Bearer token. Root
cause: the `.mcp.json` entry for `ace-ocs` had no `env:` block, so the
subprocess didn't inherit `CLAUDE_PLUGIN_DATA`. `ocs-server.ts` uses
that var to locate the `.env` holding `OCS_API_TOKEN`; without it,
dotenv silently fell back to `./.env` (wrong cwd) and the token came
back `undefined`. `ace-gdrive` worked because its `env:` block
substitutes `${CLAUDE_PLUGIN_DATA}` at spawn time.

### Fixed

- **`.mcp.json` now passes `CLAUDE_PLUGIN_DATA` through to `ace-ocs`.**
  One-line env-block addition so the OCS MCP subprocess can locate
  `$CLAUDE_PLUGIN_DATA/.env` the same way `ocs-server.ts` expects.
  Existing `.env` content (managed by `op inject` via `.env.tpl`) is
  unchanged.

### Why

Every future resume that hits Phase 4 without this fix would have
stalled the same way, with the only tell being a 401 response buried
in tool-call output and no clear diagnostic. Single-line fix; no
surface area other than that one MCP subprocess's env.

## 0.5.6 — 2026-04-20

Move `llo-invite` from Phase 3 (Connect Setup) to Phase 5 (LLO
Management) as the first step. Don't commit to an invite roster or
burn a review-mode gate on one before the OCS chatbot has cleared its
deep-eval quality gate in Phase 4. The 5 review gates stay at 5 —
`llo-invite`'s gate just shifts its placement inside the sequence.

### Changed

- `agents/connect-setup.md` — drop `llo-invite` from skills + workflow.
- `agents/llo-manager.md` — add `llo-invite` as Step 1 (monitoring
  renumbered to Step 5).
- `agents/ace-orchestrator.md` — state.yaml schema example, gate
  description, phase summaries updated.
- `lib/artifact-manifest.ts` — move `connect-setup/invites.md` and
  `gate-briefs/llo-invite.md` from `connect` phase to `operate`.
- `skills/llo-invite/SKILL.md` — rewrite preamble + gate-brief context
  + changelog entry.

### Compat

Artifact paths kept as `connect-setup/invites.md` and
`gate-briefs/llo-invite.md` (not renamed) so existing opps don't
orphan their prior invite files. Only the manifest phase attribution
changes. ace-web picks up the new placement automatically on next
deploy via the dynamic skill registry (no ace-web code change).

## 0.5.5 — 2026-04-20

Follow-up to 0.5.4: `.env.tpl` itself had a 1Password reference
`op inject` couldn't parse, which meant 0.5.4's new `env_drift` WARN
directed users at a command that always failed. This release patches
the template so the hint actually works.

### Fixed

- **`.env.tpl` `OCS_API_TOKEN` reference now uses item UUID.** The
  original reference `op://AI-Agents/ACE - OCS REST API Key
  (connect-ace)/credential` has parentheses in the item name, which
  `op inject`'s parser silently truncates at (`invalid secret
  reference 'op://AI-Agents/ACE - OCS REST API Key': too few '/'`).
  Percent-encoding does not help. UUID-based reference
  `op://AI-Agents/ccfc36cyidvecda5tzhseuouie/credential` resolves
  cleanly. Inline comment in the template explains the tradeoff.

### Why

0.5.4 shipped the `env_drift` WARN with a `op inject -i .env.tpl -o ...`
fix hint. First operator to follow the hint (the author, right after
shipping 0.5.4) hit the opaque `invalid secret reference` error. The
adoption-blockers lens had correctly identified the class but missed
the hint itself was unreachable.

## 0.5.4 — 2026-04-20

Adoption-blocker cleanup: close the `.env` drift class that silently
broke 0.5.3's smart-default PDD picker on any install that hadn't
re-injected `.env` since the var was added.

### Added

- **`bin/ace-doctor` env-drift diff.** New `env_drift` check diffs the
  `KEY=` set in the installed `.env` against `.env.tpl` and WARNs on
  any key present in the template but absent from the install. Fix
  hint emits the exact `op inject` command. Catches every future
  `.env.tpl` addition automatically, not just today's.
- **`bin/ace-doctor drive_root` check.** Explicit WARN when
  `ACE_DRIVE_ROOT_FOLDER_ID` is unset — the variable 0.5.3's
  smart-default PDD picker depends on.
- **`bin/ace-doctor ocs_shared_collection` check.** Explicit WARN when
  any of `OCS_SHARED_COLLECTION_ID`, `OCS_LLM_PROVIDER_ID`, or
  `OCS_EMBEDDING_MODEL_ID` is unset — the triple per-opp bot clones
  need for Connect-knowledge RAG (2026-04-20 P1 backlog).

### Changed

- **`/ace:run` PDD picker fails loudly on missing
  `ACE_DRIVE_ROOT_FOLDER_ID`** rather than silently falling through
  to the inline/paste fallback. `agents/ace-orchestrator.md` §
  Starting a New Opportunity step 2(c).0 now stops with an actionable
  error pointing at `op inject` (or `--idea FILE|-` to bypass).
- **README First-Run Walkthrough + Quick Start + `/ace:doctor` next-step
  hint** updated to zero-arg `/ace:run` as the primary example,
  matching the 0.5.3 smart-default flow.

### Why

On 2026-04-20 the installed `.env` on the author's machine was missing
8 keys from `.env.tpl`, including `ACE_DRIVE_ROOT_FOLDER_ID` (required
by 0.5.3) and the shared-collection triple (required for post-clone
RAG). Doctor reported `STATUS: COMPLETE` regardless — it only
validated 3 of 16 keys. Any admin who injected `.env` before these
vars were added hits silent failures on the happy path: the picker
falls through with no signal of why, and per-opp bots publish with
empty RAG. Doctor is the one place that catches this preventively;
the use-site pre-flight catches it at invocation time for operators
who skip doctor.

## 0.5.3 — 2026-04-20

Feature: `/ace:run` smart defaults — zero-arg happy path.

### Added

- **Auto-generated slug** when `<opp-name>` is omitted:
  `smoke-<YYYYMMDD-HHMM>`. Lets `/ace:run` (no args) do the right
  thing in a throwaway-smoke context.
- **Auto-discover PDD on Drive** when `--idea` is not provided. The
  orchestrator's "Starting a New Opportunity" flow now lists files in
  the PDDs folder under `ACE_DRIVE_ROOT_FOLDER_ID`, sorts by
  slug-stem match + recency, and presents the top 5 via
  `AskUserQuestion`. Confirmation is always required (even with a
  single match) to guard against domain-mismatched PDDs.
- **`--ace-web-url` default** to `https://labs.connect.dimagi.com/ace`
  when `ACE_E2E_AUTH_TOKEN` is set in the environment. Skipped
  silently when the env var is absent (so local-only dev still works).
  Explicit `--ace-web-url ''` force-disables.

### UX

`/ace:run` (zero args) now picks a sensible slug, asks the operator
to pick a PDD from Drive, and uploads the transcript to labs if the
E2E token is present. One command end-to-end.

## 0.5.2 — 2026-04-20

Docs: PM run log for the 2026-04-20 collection-clone-and-mcp-preflight
cycle (`.claude/pm/runs/2026-04-20-collection-clone-and-mcp-preflight.md`).
Covers the Path C cross-team verification, Iter 8 subagent clone of
collection 135 (ccc-support) → 350 (connect-ace), and the 0.5.1 MCP
pre-flight + upload-chunking fixes. Appends four durable preferences to
`learnings.md`: OCS team-scoping enforcement, pipeline-save dual error
shapes, metadata files as hypotheses, and Django form silent-accept
failure modes. Two canopy-skills self-improvement candidates noted
inline.

No code changes.

## 0.5.1 — 2026-04-20

MCP robustness: `publishChatbotVersion` pre-flight + `uploadCollectionFiles`
chunk-params. Both fixes surfaced during Iter 8 of the cosmetics-fgd-pilot
iteration loop (the collection-clone from ccc-support → connect-ace).

### Fixed

- **`publishChatbotVersion` now pre-flights the pipeline.** Before hitting
  `/versions/create`, the backend round-trips the current graph through
  `/pipelines/data/<pid>/` to surface any node-level validation errors.
  This catches the entire silent-publish-block class of bug — where Django
  re-renders the version form with HTTP 200 and no errorlist because the
  errors originated on the pipeline, not the version form. Before this
  fix, the only signal was the opaque "form re-rendered without redirect"
  message. Now the caller gets a real `PipelineValidationError` naming
  the exact node and field that broke.
- **`extractPipelineErrors` helper** handles the two observed response
  shapes: top-level string array (`{ errors: ["..."] }`) and nested
  per-node (`{ errors: { node: { "<id>": { "<field>": "<msg>" } } } }`).
  The nested shape is what hid the 2026-04-19 phantom-collection bug —
  the top-level array was empty while the real error lived under
  `errors.node.LLMResponseWithPrompt-*.collection_index_ids`.
  `patchLlmNodeParams` now uses the same extractor (previously it only
  checked the top-level shape).
- **`uploadCollectionFiles` sends `chunk_size` + `chunk_overlap`.**
  Django's `add_collection_files` form requires these. Omitting them
  caused a "successful" upload (form validated, file accepted) with zero
  chunks produced — retrieval silently never worked. Defaults 800/400
  match the upstream NM Bot collection source. Tool schema exposes
  both as optional overrides. Invalid values (overlap ≥ size) throw
  before the HTTP call.

### Why

The first defense was in `scripts/bootstrap-ocs-golden-template.ts`
(0.4.4). That caught the specific case of `OCS_SHARED_COLLECTION_ID`
pointing at a missing collection. This is the generalization: the MCP
layer now refuses to publish any pipeline with validation errors,
regardless of source. Covers `ocs-agent-setup`'s per-opp bot creation,
future collection swaps, manual pipeline edits through the UI, and
anything else that could leave the pipeline in a published-but-invalid
state. Item 2 of the prior backlog ("ocs-agent-setup pre-flight") is
redundant with this and is dropped from the backlog.

### Tests

- 12 new tests: 4 for `extractPipelineErrors` (null/empty/string-array/
  nested/non-string-value), 3 for `validatePipeline` (happy path,
  nested errors, GET failure), 1 for `patchLlmNodeParams` nested-errors,
  2 for `uploadCollectionFiles` chunk-params (custom values, validation
  error), 1 for `publishChatbotVersion` pre-flight blocking, 1
  regression for the existing publish-failure path.
- All 89 tests pass (up from 77).

## 0.5.0 — 2026-04-20

Feature: scripted end-to-end runs with optional ace-web transcript upload.

### Added

- **`/ace:run --idea FILE|-`** — pre-seed `idea.md` from a file path or
  stdin, skipping the interactive `AskUserQuestion` prompt in the
  "Starting a New Opportunity" flow. Enables fully non-interactive
  lifecycle runs (smoke tests, CI-style invocations, scripted demos).
- **`/ace:run --ace-web-url URL`** — after the orchestrator returns,
  upload the run's stream-json transcript to `<URL>/api/ingest/upload`
  so the deployed ace-web can render it as a chat Session. Requires
  `ACE_E2E_AUTH_TOKEN` in the environment. No-op if the flag is absent;
  the plugin remains standalone.
- **`skills/upload-transcript/`** — new skill encapsulating the
  e2e-login + `/api/ingest/upload` flow. Invoked by `--ace-web-url`;
  can also be called directly for ad-hoc transcript uploads.

### Rationale

Part of the ace-web drop-multi-run refactor. The two new flags let us
retire three turmeric-specific bash setup scripts
(`turmeric_cli_setup.sh`, `turmeric_auth_login.sh`,
`turmeric_auth_check.sh`) in favor of generic, composable primitives.
See ace-web `docs/plans/2026-04-20-drop-multi-run-simplify.md`.

## 0.4.5 — 2026-04-19

Docs: PM run log for the 2026-04-19 qa-eval-iteration-loop cycle
(`.claude/pm/runs/2026-04-19-qa-eval-iteration-loop.md`). Covers Iters
1/3/6/7 (PRs #33/#34/#35/#36, versions 0.4.1–0.4.4) + the 0.3.5 qa/eval
split + 0.4.0 umbrella opp-eval skill as the foundation. Meta-observations,
confidence levels, backlog priorities, and three canopy-skills
self-improvement candidates. Appends five durable preferences to
`learnings.md` and fixes stale agent/skill/command counts in `context.md`.

No code changes.

## 0.4.4 — 2026-04-19

Fix: `bootstrap-ocs-golden-template.ts` now validates
`OCS_SHARED_COLLECTION_ID` exists on the team before attaching.

### Fixed

- **Golden template silent-publish bug.** The 2026-04-19 iteration loop
  discovered that the live golden template (experiment 11792) was
  stuck at v1 (empty post-clone state) and serving vanilla-LLM responses
  — scored 3.84/10 FAIL on `ocs-chatbot-qa --quick`. Root cause:
  `OCS_SHARED_COLLECTION_ID` pointed at collection id 718, which did
  not exist on the `connect-ace` team. The clone's `ocs_attach_knowledge`
  call silently succeeded at the pipeline-patch layer, but then blocked
  every subsequent `publishChatbotVersion` attempt with the opaque UI
  message *"Unable to create a new version when the pipeline has
  errors."* The draft ended up correctly configured, but v1 stayed the
  default version forever and the embedded widget served a bare LLM.
- **Fix**: pre-flight validate that the configured
  `OCS_SHARED_COLLECTION_ID` exists on the team before attaching. Skip
  attachment with a loud, actionable warning if missing. Prevents the
  silent publish-block from reoccurring when
  `/ace:ocs-bootstrap-template` is run with a stale env var.
- **Side effect of the fix**: golden template re-published with the
  canonical system prompt (PDD not IDD, `ace@dimagi-ai.com`,
  emoji-discouraged tone guidance). Score went from **3.84/10 FAIL**
  → **8.2/10 PASS**. Remaining `[WARN]`: `source_usage: 5.0` because no
  Connect shared knowledge collection exists on team `connect-ace`
  (team-infrastructure work, backlogged).

### Backlogged (from this fix)

- OCS MCP: add `ocs_list_collections` — `bootstrap-ocs-golden-template.ts`
  had to scrape the edit page because the REST API doesn't expose it.
- OCS MCP: `publishChatbotVersion` should pre-flight POST the current
  graph through `/pipelines/data/` first and surface any
  `errors.node` entries as a `PipelineValidationError` before attempting
  version creation. The silent-publish-block bug above was hidden by
  exactly this gap.
- `ocs-agent-setup` SKILL: add a pre-flight check on
  `OCS_SHARED_COLLECTION_ID` — every clone the skill produces hits the
  same silent-block risk.
- `$CLAUDE_PLUGIN_DATA/.env` mismatch: once a real Connect shared
  knowledge collection is created on team `connect-ace`, set
  `OCS_SHARED_COLLECTION_ID`, `OCS_LLM_PROVIDER_ID`,
  `OCS_EMBEDDING_MODEL_ID` — they're documented in
  `ocs-chatbot-qa` / `ocs-agent-setup` but not currently in the env.

## 0.4.3 — 2026-04-19

Contract cleanup + orchestrator hardening, all surfaced from the
first real-content exercise of the 0.3.5 qa/eval split and the 0.4.0
opp-eval aggregator.

### Changed

- **Verdict YAML contract formalized.** `skills/README.md § QA vs Eval`
  now declares `per_item:` as the canonical per-item list key (skills
  previously drifted between `per_prompt` and `per_item`). Each entry
  may carry domain-specific subkeys (e.g., `prompt:` for chatbot evals,
  `session_id:` for FGD evals) but the canonical identifier key is
  `ref`. Aggregators read by `ref` and ignore domain extras.
- **`auto_surfaced:` is now an optional top-level verdict field.**
  Promoted from eval-skill-local to framework-level so opp-eval can
  concatenate auto-surfaced lines from every per-skill verdict into the
  run-level brief. `ocs-chatbot-eval` already emitted this block; now
  it's contract.
- **`ocs-chatbot-eval` aligned to canonical keys.** `per_prompt` →
  `per_item` with `prompt:` as a domain-specific subkey inside each
  entry.
- **qa/eval split golden-template fallback.** Both `ocs-chatbot-qa`
  and `ocs-chatbot-eval` now document `ACE/golden-template/` as the
  canonical path root for no-opp runs. Previously the qa skill said
  "stdout" and the eval skill said "fail loudly if missing" — hard
  break on any template smoke test.
- **`ocs-chatbot-qa` env-source explicit.** Env vars like
  `OCS_GOLDEN_TEMPLATE_ID` live at `$CLAUDE_PLUGIN_DATA/.env`, not the
  shell env. Step 1 now says this so programmatic dispatches can find
  them.
- **`ocs-chatbot-qa` transport guidance.** The MCP tool
  `ocs_send_test_message` returns only `response` and misses the
  `cited_files` / `tags` / `session_id` / `elapsed_ms` that the
  transcript schema needs. Step 3 (raw widget HTTP) is load-bearing;
  the skill now explicitly warns against substituting the MCP tool.
- **`opp-eval` quick-mode scorecard template** now renders the
  `Unexpected:` row (skill was already finding unexpected files, the
  template just hadn't shown them), tightens Notes wording with
  concrete examples, and specifies the stdout summary format
  including unexpected count.
- **Orchestrator state-schema example** upgraded from abstract to
  concrete, covering all 6 phases with the qa/eval split step keys
  (`ocs-chatbot-qa-{quick,deep,monitor}` +
  `ocs-chatbot-eval-{quick,deep,monitor}`). Previously the example
  stopped at `design-review > idea-to-pdd`.
- **Orchestrator: defensive `state.yaml` init on bypass paths.** New
  `§ Touching State` subsection documents the rule: every entry path
  that touches state must tolerate a missing `state.yaml` and
  initialize it first. `/ace:step` owns the defensive init for its
  path (covered in `commands/step.md`).
- **`/ace:step` step 4** upgraded to ensure-then-update: initialize
  `state.yaml` from the orchestrator schema if missing, then set
  `last_actor` + `last_actor_at`. This closes the bug I hit myself in
  the cosmetics-fgd-pilot iteration loop where I bypassed `/ace:run`
  and the opp never got a state file.

### Why

This whole set was surfaced by Iter 4 + 5 of the iteration loop —
running `ocs-chatbot-qa` + `ocs-chatbot-eval` against the golden
template and `opp-eval --quick` against the partial cosmetics-fgd-pilot
opp. Rubrics, contracts, and orchestrator assumptions all held up
under load *except* at these seams. Each fix is surgical; none change
behavior for existing opps that went through `/ace:run`.

## 0.4.2 — 2026-04-19

Iteration-loop polish: `llo-invite` now archetype-aware.

### Changed

- **`llo-invite` is now archetype-aware.** Added `## Archetypes` section.
  `atomic-visit` retains geographic + capacity criteria. `focus-group`
  shifts selection to qualitative research experience (or training
  willingness), language/cultural fit for sensitive topics,
  audio-recording capability, facilitator time budgeting, and a
  **small-N bias** (1–2 LLOs, not 3–5). A weaker LLM recruiting FGD
  LLOs against the old prompt would likely pick by "geographic match"
  alone and miss facilitation fit.
- **Gate brief** gains an FGD-specific WARN: flags when count > 2
  without multi-site justification, or when rationale is silent on
  facilitation capability.
- **Archetype-aware skill count** 8 → 9 in `skills/README.md`.

### Why

Backlog item P2 from the cosmetics-fgd-pilot recon. Field-level
enforcement (gate brief WARNs) ensures the shift lands even under
weaker dispatches.

## 0.4.1 — 2026-04-19

Iteration-loop polish shaken out of the cosmetics-fgd-pilot Phase 1
reconnaissance run.

### Changed

- **`pdd-to-test-prompts` is now archetype-aware.** Added `## Archetypes`
  section with per-archetype category lists: `atomic-visit` keeps
  visit-flow / eligibility / GPS / duplicate-handling; `focus-group`
  gets session-flow / recruitment-and-venue / consent-and-recording /
  question-guide-sequencing / facilitation-technique / output-spec /
  audio-and-evidence; `multi-stage` mixes per-stage and adds a
  stage-gate-transition category. Previously the skill was atomic-visit-
  worded throughout its examples, forcing LLMs running the skill against
  an FGD PDD to remap categories on the fly — a weak-signal failure mode
  where a less-grounded run would produce atomic-visit prompts that then
  fail in the `ocs-chatbot-eval --deep` gate as false-positives.
- **Archetype-aware skill count** updated from 7 to 8 in
  `skills/README.md`.

### Why

Surfaced during the cosmetics-fgd-pilot Phase 1 reconnaissance
(2026-04-19). The subagent running the skill had to manually remap every
category — "home visit" → "session flow", "GPS per delivery" → "audio
duration ≥ 45 min", "photo validity" → "product-photo standardization
+ attendance photo". The manual remapping worked, but a weaker LLM
without that context-inference ability could easily miss it.

## 0.4.0 — 2026-04-19

Umbrella eval agent — the "one overview judge/review agent that we
can apply to overall runs" capability that was missing. opp-eval
aggregates every per-skill `-eval` verdict for an opportunity into a
single run-level scorecard and drafts improvement recommendations.
Minor bump because this adds a new user-visible capability (new skill,
new slash command) on top of the 0.3.5 qa/eval split.

### Added

- **New skill: `opp-eval`.** Umbrella judge. Three modes:
  - `--quick` — structural artifact check only (walk the manifest,
    confirm every required non-dated artifact for the opp's current
    phase exists in Drive). No LLM cost.
  - `--deep` — structural check **plus** aggregation: walks every
    `verdicts/*.yaml` file in the opp folder, rolls scores into 6
    skill-category dimensions (design, commcare, connect, ocs,
    operate, closeout) with renormalized weights when categories are
    empty, classifies a run-level verdict (pass ≥ 7 / warn 4–6 /
    fail < 4), and drafts improvement recommendations for every
    `warn`/`fail` verdict and every dimension scoring < 6.0.
  - `--monitor` — same as `--deep` plus appends a one-liner to
    `scorecards/trend.md` for run-over-run drift visibility.

  Writes `scorecards/YYYY-MM-DD-opp-eval-<mode>.md` (human),
  `verdicts/opp-eval-<mode>.yaml` (machine, uniform verdict shape from
  `skills/README.md § QA vs Eval`), and `gate-briefs/opp-eval-deep.md`
  (advisory; does not gate a phase today — contract uniformity so
  future automation can consume it without a special case). YAML
  parsing tolerates missing fields — surfaces gaps as `[INFO]` notes
  rather than crashing, since partial opps are explicitly supported.

- **New slash command: `/ace:eval <opp-name> [--mode
  quick|deep|monitor]`.** Thin wrapper that dispatches to the
  `opp-eval` skill. See `commands/eval.md`.

- **7 new manifest entries in `lib/artifact-manifest.ts`.**
  `scorecards/YYYY-MM-DD-opp-eval-{quick,deep,monitor}.md`,
  `scorecards/trend.md`, `verdicts/opp-eval-{deep,monitor}.yaml`,
  `gate-briefs/opp-eval-deep.md`. All `required: false` (opp-eval is
  opt-in, not part of the default 6-phase pipeline), all tagged
  `phase: closeout`.

- **`skills/README.md § QA vs Eval` canonical-examples list.**
  opp-eval added as the canonical **umbrella eval** example, distinct
  from per-skill `-eval` skills.

- **`agents/ace-orchestrator.md § Umbrella Eval`.** New section
  explaining that opp-eval is ad-hoc (not part of `--mode review`
  auto-pause), does not gate any phase, and automatically picks up
  new per-skill verdicts via directory discovery as rubric work
  lands on the rest of the skills.

### Why this release

The 0.3.5 qa/eval split established the uniform `verdicts/<skill>-<mode>.yaml`
contract that every future `-eval` skill will write. That set up
opp-eval to exist: an aggregator that reads the verdicts/ directory
without per-skill knowledge. Today only `ocs-chatbot-eval` writes
verdicts; opp-eval emits `[INFO]` notes for skills without rubrics —
which is the forcing function that motivates future rubric work
across the other 22 skills. The recommendations feature directly
answers the operator's original ask ("make its own recommendations on
how to improve") without redesigning per-skill judges.

## 0.3.5 — 2026-04-19

QA/Eval split refactor — establishes the two-phase evaluation contract
that future `-eval` skills and the umbrella `opp-eval` agent will follow.

### Added

- **New skill: `ocs-chatbot-eval`.** Split out from `ocs-chatbot-qa` as
  the judge half of the qa/eval pair. Reads a captured transcript from
  `qa-captures/`, runs the 4-dimension LLM-as-Judge rubric, writes a
  machine-readable verdict YAML to `verdicts/`, a human-readable report
  to `eval-reports/`, and (for `--deep` mode) the Phase 4→5 gate brief.
  Three modes (`--quick` / `--deep` / `--monitor`) mirror the qa skill
  so each capture has a matching judgment pass.
- **`skills/README.md § QA vs Eval — the two-phase pattern`.** Codifies
  the separation: `-qa` skills exercise the artifact and produce
  structured evidence (transcript, audio capture, structural checks);
  `-eval` skills read evidence and apply LLM-as-Judge. Includes the
  uniform artifact-path contract (`qa-captures/`, `verdicts/`,
  `eval-reports/`, `gate-briefs/`) and the shared verdict-YAML shape
  that future `-eval` skills and the umbrella `opp-eval` aggregator
  will consume.
- **6 new manifest entries.** `qa-captures/YYYY-MM-DD-ocs-chat-{quick,deep,monitor}.md`
  (produced by `ocs-chatbot-qa`, consumed by `ocs-chatbot-eval`);
  `verdicts/ocs-chatbot-eval-{quick,deep,monitor}.yaml` and
  `eval-reports/YYYY-MM-DD-ocs-eval.md` + `eval-reports/trend.md`
  (produced by `ocs-chatbot-eval`).
- **New gate-brief path.** `gate-briefs/ocs-chatbot-eval-deep.md`
  (renamed from `ocs-chatbot-qa-deep.md`; the gate sits on the
  judgment, not the capture).

### Changed

- **`ocs-chatbot-qa` slimmed to capture + structural checks.** No more
  LLM-as-Judge. Writes to `qa-captures/` and returns structural pass
  rate. Modes (`--quick` / `--deep` / `--monitor`) now describe suite
  size only; judgment depth is the eval skill's responsibility.
- **Consumers dispatch qa → eval pairs.** `agents/ocs-setup.md` (Phase
  4 Steps 2 and 3), `agents/llo-manager.md` (recurring monitor), and
  `agents/ocs-tester.md` now invoke the capture skill and the judge
  skill as a pair. `agents/ace-orchestrator.md`'s gate-brief list
  updated to point at `ocs-chatbot-eval-deep.md`.
- **`state.yaml` step keys split.** Phase 4 now tracks
  `ocs-chatbot-qa-{quick,deep}` and `ocs-chatbot-eval-{quick,deep}`
  separately; Phase 5 recurring adds `ocs-chatbot-eval-monitor`. Gate
  renamed from `ocs-chatbot-qa-deep` → `ocs-chatbot-eval-deep`. Fixtures
  `CRISPR-Test-001` and `CRISPR-Test-003-Turmeric` updated to the new
  schema. Older fixtures without the split keys still parse; the next
  skill invocation adds them.

### Why this refactor

Decoupling lets us re-grade an old transcript when a rubric improves
without re-chatting with the bot; lets a human-captured evidence
artifact (FGD audio + notes) flow through the same `-eval` machinery as
a machine-captured one; and establishes the uniform verdict-YAML shape
that the upcoming umbrella `opp-eval` agent will aggregate across every
skill's judgment.

## 0.3.3 — 2026-04-17

Admin-group coordination polish based on an internal-Dimagi-users scout.
Targets the seams between the 6-phase pipeline and a 5-person admin group
(Matt, Neal, Jon, Sarvesh, Cal) who will run multiple opportunities in
parallel: triage legibility, hand-off attribution, and gate-review
context. All three changes are state-schema + command spec edits; no
runtime code changes.

### Added

- **`/ace:status` computes per-opp status tags.** List view now derives
  one of `ACTION NEEDED` / `RUNNING` / `IDLE` / `ERROR` / `DONE` per opp
  from `state.yaml` (gate pending, step error, recurring-only remaining,
  etc.) and sorts `ACTION NEEDED` to the top. Adds a `Blocked on`
  column (`gate: <name>` / `error: <skill>` / `input: <file>`) so an
  admin sees next-action without opening the opp. `--mine` filters to
  the current operator's `git config user.email`; `--all` shows `IDLE`
  and `DONE`. `Mode` column drops from the default view. See
  `commands/status.md`.
- **Operator identity in `state.yaml`.** New fields `initiated_by`,
  `last_actor`, `last_actor_at` — all emails, ISO-timestamped. Set once
  at opp creation (`initiated_by`), updated on every skill invocation
  (`last_actor` / `last_actor_at`) by both `/ace:run` and `/ace:step`.
  Pulls from `git config user.email`; falls back to `unknown` if unset.
  Drives `/ace:status`'s "last touched by X, N days ago" column and
  `--mine`. See `agents/ace-orchestrator.md § State Schema` and
  `§ Touching State — Operator Capture`.
- **Gate-brief contract.** Each of the 5 review-mode gates now has a
  uniform brief at `ACE/<opp-name>/gate-briefs/<gate-name>.md` produced
  by the gate-owning skill before the orchestrator pauses. Required
  shape: artifact under review (path + one-line summary), what-to-check
  checklist (3–5 imperative items), auto-surfaced concerns tagged
  `[BLOCKER]` / `[WARN]` / `[INFO]`, and a recommended disposition.
  Orchestrator must read the brief and display it verbatim before any
  `AskUserQuestion` approval prompt; missing brief = fail loudly. 5
  skills emit briefs: `idea-to-pdd`, `app-deploy`, `ocs-chatbot-qa`
  (only in `--deep` mode), `llo-invite`, `llo-launch`. See
  `agents/ace-orchestrator.md § Gate Brief Contract` and each skill's
  new `## Gate Brief` section.
- **5 new required artifacts in `lib/artifact-manifest.ts`.** One entry
  per gate brief, each consumed by `ace-orchestrator`. `CRISPR-Test-003-Turmeric`
  ships stub gate briefs for all 5; `CRISPR-Test-001` is a partial
  fixture and the 3 design/commcare/connect gate briefs are marked in
  `expectedMissing`.

### Changed

- **`state.yaml` schema extended.** Pre-0.3.3 fixtures without the three
  ownership fields still parse; `/ace:status` renders `Last touched:
  <unknown>, <timestamp>` for them. The orchestrator and `/ace:step`
  both add the fields on first touch. No migration script needed.

## 0.3.2 — 2026-04-16

End-to-end workflow hardening based on a core-workflow scout. Targets the gap
between "install works" (0.3.1) and "full pipeline actually runs end to end":
fixture drift, silent prerequisite failures, and phase-4-to-6 test coverage.

### Added

- **`CRISPR-Test-003-Turmeric` fixture.** Complete end-to-end test fixture
  seeded from `docs/examples/pdd-turmeric-market-survey.md` with synthetic
  stubs for every required artifact across all 6 phases. Replaces the
  "partial-fixture-only" testing posture and lets CI catch manifest drift
  in phases 4–6 (OCS, operate, closeout) that `CRISPR-Test-001` /
  `CRISPR-Test-002` can't see.
- **Artifact-manifest test spans the full lifecycle.** `artifact-manifest.test.ts`
  now validates `CRISPR-Test-003-Turmeric` `upToPhase: 'closeout'` with zero
  unexpected and zero missing required artifacts. Manifest-renames or new
  required artifacts in any phase now trip the existing `npm test` suite.
- **`/ace:step` prerequisite check.** `commands/step.md` now specifies a
  manifest-driven input check: before invoking a skill, look up
  `artifactsConsumedBy(skill)` in `lib/artifact-manifest.ts` and fail loudly
  if any required prior artifact is missing from the opportunity folder.
  Closes the silent-failure bypass path on `/ace:step ocs-chatbot-qa` (and
  anything else that depends on upstream outputs).
- **`test/fixtures/validation-2026-04-16.md`.** Fresh desk-trace of
  `/ace:run CRISPR-Test-001 --dry-run` against the current (post-0.2.0)
  6-phase orchestrator and PDD terminology. Supersedes the 2026-04-08
  validation doc.

### Changed

- **`CRISPR-Test-001/state.yaml` refreshed to the 6-phase schema.** The flat
  19-skill list predated the 0.2.0 phase restructure. Now a phases → skills
  nested map covering all 22 skills (including the three `ocs-chatbot-qa`
  modes) and the five actual review-mode gates.

## 0.3.1 — 2026-04-16

First-run UX hardening based on an end-to-end adoption-blocker scout. Targets
the specific failure modes a fresh user hits when trying to go idea → deployed
program without a Dimagi engineer on the line.

### Added

- **Orchestrator captures `idea.md` before Phase 1.** `ace-orchestrator.md`'s
  "Starting a New Opportunity" section now checks for `ACE/<opp-name>/idea.md`
  and prompts the user for the brief (inline paste or Drive URL) if it's
  missing. No more silent failure or improvised ideas when `/ace:run` starts
  with an empty folder.
- **`idea-to-pdd` fail-fast error.** If the skill runs via `/ace:step` without
  `idea.md` present, it now stops with an actionable error pointing at
  `/ace:run` or explicit file creation — it no longer invents an idea.
- **README first-run walkthrough.** New section in `README.md` with the full
  ordered first-run checklist: install → setup → GWS key → `op inject` .env
  → `/ace:ocs-login` → `/ace:ocs-bootstrap-template` → `/ace:doctor` →
  `/ace:run --dry-run`.
- **`/ace:doctor` runtime readiness checks.** `bin/ace-doctor` now also
  checks (WARN-level) for `.env` presence, `OCS_BASE_URL` /
  `OCS_TEAM_SLUG` / `OCS_GOLDEN_TEMPLATE_ID`, `ACE_GMAIL_ACCOUNT`, and a
  `~/.ace/ocs-session-<team>.json` session file (with a > 30 days old
  freshness warning). Unresolved `op://…` references are treated as
  missing. Each warning includes a concrete fix hint.

### Fixed

- **Stale architecture counts in README.** `6 agents` / `21 skills` →
  `8 agents` / `22 skills`; phase agent list updated to the current 6
  phases.

## 0.3.0 — 2026-04-15

**Breaking rename:** "Intervention Design Document" / IDD is now "Program
Design Document" / PDD everywhere — full phrase, acronym, filename
(`idd.md` → `pdd.md`), skill names, docs, fixtures, and manifest entries.

### Changed

- **Four skills renamed:** `idea-to-idd` → `idea-to-pdd`,
  `idd-to-learn-app` → `pdd-to-learn-app`, `idd-to-deliver-app` →
  `pdd-to-deliver-app`, `idd-to-test-prompts` → `pdd-to-test-prompts`.
  Any external callers referencing these names must be updated.
- **Opportunity artifact renamed:** `ACE/<opp-name>/idd.md` →
  `ACE/<opp-name>/pdd.md`. Likewise `closeout/new-idd.md` →
  `closeout/new-pdd.md`. Done now while no opportunities are mid-flight.
- **Template + examples renamed:** `templates/idd-template.md` →
  `pdd-template.md`; `docs/examples/idd-*.md` → `pdd-*.md`;
  `test/sample-idd.md` → `sample-pdd.md`;
  `test/eval/sample-idds/` → `sample-pdds/`; fixture `idd.md` → `pdd.md`.
- **Agent frontmatter updated** to reference the new skill names
  (`design-review` and `commcare-setup`).
- Section headings inside PDDs that describe the *content* (e.g.
  `## Intervention Design` — a section that documents how the intervention
  works) are preserved; only document-name references were renamed.
- Historical session logs in `.claude/pm/` are left intact — they record
  what happened at a point in time and shouldn't be rewritten.

## 0.2.1 — 2026-04-14

Phase metadata moved into agent frontmatter. Each phase agent now declares
its phase name, display name, ordinal position in the lifecycle, and the
ordered list of skills it orchestrates. This is the structured twin of the
existing Workflow prose, and is consumed by external tools (e.g. ace-web's
System Overview tab) that need to reason about the pipeline without parsing
markdown.

Also clarifies that every skill is human-reviewable — the previous implicit
"gate" concept was misleading. Review-mode human approval is available on
every step, not just a few.

### Added

- `phase`, `phase_display`, `phase_ordinal`, and `skills` frontmatter on
  the six phase agents (`design-review`, `commcare-setup`, `connect-setup`,
  `ocs-setup`, `llo-manager`, `closeout`). `llo-manager` additionally
  declares `recurring_skills` for `timeline-monitor` and `flw-data-review`.
- Each skill entry declares `has_judge` and `primary_output`.

### Changed

- The orchestration data model no longer distinguishes "gate skills" from
  non-gate skills.

## 0.2.0 — 2026-04-14

Orchestration restructure. The previous 4-phase flow (`app-builder` →
`connect-setup` → `llo-manager` → `closeout`) hid OCS setup as Step 4 of
LLO management — *after* go-live, so LLOs went through onboarding and UAT
with no support bot. The new 6-phase flow makes OCS a first-class phase
that runs before any LLO-facing step, and consolidates two overlapping
OCS test paths into a single skill with three modes.

### Changed

- **Six-phase orchestration.** `ace-orchestrator` now dispatches: (1)
  design-review, (2) commcare-setup, (3) connect-setup, (4) ocs-setup,
  (5) llo-manager, (6) closeout. Phases 1–4 run end-to-end with zero LLO
  involvement, so an operator can review a fully configured opportunity
  before first contact.
- **`app-builder` split** into two agents: `design-review` (Phase 1 —
  `idea-to-pdd` + new `pdd-to-test-prompts`) and `commcare-setup`
  (Phase 2 — apps, deploy, test, training). The old `app-builder.md`
  is removed.
- **`ocs-setup` is a new Phase 4 agent** that runs `ocs-agent-setup` →
  `ocs-chatbot-qa --quick` (smoke gate) → `ocs-chatbot-qa --deep`
  (pre-launch gate) → widget handoff to Connect.
- **`ocs-agent-setup` is now purely configuration** — the inline 3–5
  question LLM-as-Judge self-eval and the connect-setup handoff are
  removed. Quality gating and widget handoff live in `ocs-setup`.
- **`ocs-chatbot-qa` gains `--quick` / `--deep` / `--monitor` modes.**
  `--quick` replaces the inline self-eval; `--deep` is the pre-launch
  gate that uses `test-prompts.md`; `--monitor` is recurring monitoring
  invoked from Phase 5 with a trend file.
- **`llo-invite` prepares-only** in Phase 3; sending moves to
  `llo-onboarding` in Phase 5 so the onboarding email can include the
  OCS widget link.
- **`llo-onboarding`** now owns both the Connect system invite send and
  the ACE-authored onboarding email (with widget link embedded).
- **`llo-manager`** is Phase 5; the old Step 4 (`ocs-agent-setup`) is
  removed. Step 4 is now recurring monitoring, including
  `ocs-chatbot-qa --monitor`.
- **Artifact manifest** phases renamed: `build` → `design` + `commcare`;
  `setup` → `connect`; new `ocs` phase (split from `operate`). Adds
  entries for `test-prompts.md`, `ocs-setup/widget-handoff.md`, and
  `qa-reports/trend.md`.

### Added

- **`pdd-to-test-prompts` skill** (Phase 1 Step 2) — derives opp-specific
  Q&A pairs with expected-answer summaries from the PDD. Produces
  `ACE/<opp-name>/test-prompts.md`, the ground truth for the Phase 4
  deep QA gate. Previously `test-prompts.md` was referenced by
  `ocs-chatbot-qa` but had no producer.
- **`ocs-setup/widget-handoff.md`** — operator-facing handoff doc with
  `{public_id, embed_key}` and paste instructions for the Connect
  opportunity widget, since `update_opportunity` is unbuilt (CCC-301).

## 0.1.11 — 2026-04-14

Three fixes from the first CRISPR-Test-001 E2E run against live OCS.

### Changed

- Default OCS base URL migrated from `chatbots.dimagi.com` to
  `www.openchatstudio.com` across all live code, templates, commands,
  scripts, and tests (#26).
- `ocs_send_test_message` rewritten to use the anonymous widget chat API
  (`POST /api/chat/start/` → `/message/` → `/poll/`). The old
  OpenAI-compatible endpoint (`/api/openai/{id}/chat/completions`)
  returns 404 on connect-ace. Interface changed from
  `experiment_id` + `messages[]` to `public_id` + `embed_key` + `message`.
- `ocs_create_collection` now defaults `llm_provider` and
  `embedding_model` from `OCS_LLM_PROVIDER_ID` and
  `OCS_EMBEDDING_MODEL_ID` env vars when not explicitly provided.

### Added

- `OCS_LLM_PROVIDER_ID` and `OCS_EMBEDDING_MODEL_ID` in `.env.tpl` and
  `.env.example` — required for creating indexed RAG collections.

## 0.1.10 — 2026-04-13

### Fixed

- `drive_read_file` and `drive_list_folder` now resolve Google Drive
  shortcuts transparently. Shortcuts (mimeType
  `application/vnd.google-apps.shortcut`) are followed to their target
  file before reading or listing (#25).
- `loadRestToken()` returns empty string instead of throwing when
  `OCS_API_TOKEN` is not set, allowing REST-only startup to proceed.
- OCS MCP server startup is now non-fatal when REST verification
  fails — authoring tools (Playwright-backed) still work.

## 0.1.9 — 2026-04-11

Live-OCS validation of the per-opp RAG collection flow. Ships four form
and response-parsing fixes to `PlaywrightBackend` that were discovered
by running the E2E bot creation test against `chatbots.dimagi.com`.

### Added

- `lib/artifact-manifest.ts` — canonical definition of 30 ACE artifacts
  across 4 lifecycle phases, with `producedBy` / `consumedBy` skill
  relationships and a `validateFixture()` helper.
- `test/fixtures/artifact-manifest.test.ts` — fixture validation unit
  test that catches drift between the manifest and `CRISPR-Test-001`.
- `test/mcp/ocs/e2e-bot-creation.integration.test.ts` — full 12-step
  end-to-end bot creation flow against live OCS. Gracefully handles
  upstream OCS bugs (filed as dimagi/open-chat-studio#3161, #3162).
- `test/fixtures/CRISPR-Test-001/connect-setup/opportunity.md` and
  `training-materials/*` stubs — completes the fixture's inputs for
  the `ocs-agent-setup` skill.
- `ocs-tester` agent and `ocs-chatbot-qa` skill (delivered earlier in
  0.1.6 but not previously documented in the changelog summary).

### Fixed

- `publishChatbotVersion`: the Django form field is
  `is_default_version`, not `make_default`. The endpoint returns a 302
  redirect (not JSON); scrape the version number from the chatbot home
  page afterwards.
- `createCollection`: the form field is `is_index` (hidden input), not
  `collection_type` (which is a UI-only Alpine radio). For indexed
  collections, `llm_provider` and `embedding_provider_model` are both
  required — without them the form silently drops `is_index`.
- `uploadCollectionFiles`: OCS returns a 302 redirect after upload,
  not JSON with `file_ids`. Scrape `CollectionFile` PKs from the files
  listing partial (`id="collection_file_<pk>"`) instead of File IDs.
- `waitForCollectionIndexing`: the status endpoint returns an HTMX
  partial (HTML) with `data-tip="<status>"` and `<N> chunks`, not
  JSON. Parse both from HTML and throw a clear error on status=Failed.
- Collection delete uses HTTP `DELETE /documents/collections/<id>`
  (no trailing slash), not `POST .../delete/`.

### Changed

- Default `createCollection` to local index (`is_remote_index=False`)
  to match the OCS UI default. Remote indexes currently crash with a
  500 on `connect-ace` — tracked as dimagi/open-chat-studio#3161.

## 0.1.8 — 2026-04-10

### Added

- CI version bump check: PRs now fail if `VERSION` is not bumped (#23).

## 0.1.7 — 2026-04-10

### Added

- `scripts/hooks/pre-commit` and `scripts/sync-version.sh` — git pre-commit
  hook that automatically syncs `VERSION` into `package.json`,
  `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` when
  `VERSION` is staged. No more forgetting to update version in four places.

## 0.1.6 — 2026-04-10

### Added

- `email-communicator` skill — sends email from `ace@dimagi-ai.com` via GOG
  CLI. Used for LLO onboarding, feedback requests, and closeout comms (#20).
- `.env.tpl` — 1Password-injectable template for OCS and Gmail secrets.
  `dotenv` loader in `ocs-server.ts` resolves from `$CLAUDE_PLUGIN_DATA/.env`
  (plugin) or `./.env` (dev) (#22).
- `ocs-tester` agent + `ocs-chatbot-qa` skill — LLM-as-Judge quality
  evaluation for OCS chatbots. Sends test prompts, evaluates responses,
  and reports a quality score (#22).
- `test/mcp/ocs/e2e.integration.test.ts` — end-to-end integration test
  exercising the full Playwright backend flow: clone → set prompt → attach
  knowledge → get embed info → chat via widget → cleanup (#21, #22).
- `test/fixtures/CRISPR-Test-001`, `CRISPR-Test-002` — golden E2E test
  fixtures with idea, PDD, state, deployment summary, and app summaries.
- Shared Connect knowledge collection wired into golden template bootstrap
  and per-opp chatbot setup (#19).

### Changed

- CLAUDE.md regenerated with worktree/version/update workflow documentation.

## 0.1.5 — 2026-04-10

### Fixed

- `ace-gdrive` MCP server was silently failing to register tools. `tools/list`
  crashed with `Cannot read properties of undefined (reading '_zod')` because
  zod 4.x's internal schema representation is incompatible with
  `zod-to-json-schema@3.25.2` (used by `@modelcontextprotocol/sdk@1.29.0`).
  Pinned zod to `^3.25.28` which restores all 18 Drive/Sheets/Docs tools.

## 0.1.4 — 2026-04-09

Fast update check — no more waiting for `git pull` just to see if you're
current.

### Changed

- `/ace:update` Step 1 now curls the raw VERSION file from GitHub (typically
  under 300ms) instead of doing a full `git pull origin main` before comparing
  versions. The `git pull` only runs in Step 2 when an update is actually
  available. Same pattern `gstack-update-check` uses.

## 0.1.3 — 2026-04-09

Auto-update checks are now built in — no setup step needed.

### Added

- `hooks/hooks.json` declares a native `SessionStart` hook that runs
  `bin/ace-update-check` on every new Claude Code session. This is the same
  mechanism superpowers uses. The hook loads automatically when the plugin is
  enabled — no user action, no settings.json patching, clean uninstall.

### Changed

- `/ace:doctor` now checks for `hooks/hooks.json` at the plugin root instead
  of grepping `~/.claude/settings.json` for a user-level hook. The old
  settings.json approach still works if present, but the native plugin hook is
  the canonical mechanism.

## 0.1.2 — 2026-04-09

`/ace:doctor` overhaul: the checks now actually print their messages, and the
detection logic stops getting confused when you run the doctor from inside a
dev worktree.

### Fixed

- `/ace:doctor` output lines were coming back as bare `PASS ` / `FAIL ` with
  empty messages. The helper functions in `commands/doctor.md` used `$1` / `$2`
  positional params, which Claude Code's slash-command argument expansion
  substituted with empty strings *before* bash ever saw the script. The doctor
  logic has been moved out of the slash command body into a real
  `bin/ace-doctor` script, so positional params behave normally.
- Plugin-root detection no longer silently audits a dev worktree when you meant
  to audit the installed plugin. Previously the detection walked up from `$PWD`
  before falling back to the installed cache, so running `/ace:doctor` from
  inside an ACE checkout shadowed the real install. `bin/ace-doctor` now
  defaults to auditing the copy it ships in (which, for the slash command, is
  always the installed plugin), and the launcher resolves that copy via
  `$CLAUDE_PLUGIN_ROOT` → `~/.claude/plugins/installed_plugins.json` → a
  version-sorted cache fallback.

### Added

- `bin/ace-doctor` standalone script. Supports `--here` (walk up from `$PWD`
  for dev workflows), `--installed` (force the registered install), and
  `ACE_DIR=/path` / `--root /path` overrides. Emits
  `INFO cwd_is_ace_checkout=...` when you're standing inside a different
  ACE checkout than the one being audited, so there's never ambiguity about
  which copy was checked.

## 0.1.1 — 2026-04-09

Shared Drive support for the Google Drive MCP and a clean service-account key
location that survives plugin updates.

### Fixed

- `mcp/google-drive-server.ts` now passes `supportsAllDrives: true` on every
  `drive.files.*` / `drive.permissions.create` call, and
  `includeItemsFromAllDrives: true` on list calls. Without these flags, service
  accounts hit `Service Accounts do not have storage quota` when creating docs
  even inside a Shared Drive folder, because the Drive API silently treated
  the write as a "My Drive" create. ACE skills can now write artifacts into
  the ACE Shared Drive folder.

### Changed

- Service-account key path is now resolved from the standard
  `GOOGLE_APPLICATION_CREDENTIALS` env var, which `.mcp.json` sets to
  `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json`. That location is outside the
  versioned plugin cache dir, so it automatically survives `/ace:update` and
  is shared across worktrees and installs — drop the key once per machine.
  Falls back to the legacy `<plugin-root>/.gws-sa-key.json` for in-repo dev
  workflows.
- `/ace:setup` and `/ace:doctor` now probe the canonical
  `$CLAUDE_PLUGIN_DATA` path first and warn with a migration hint on legacy
  installs.
- `/ace:update` no longer copies `.gws-sa-key.json` forward on each update —
  it's in the persistent data dir now, so there's nothing to carry.
- README, design spec, and setup docs migrated off the retired
  `gws-local-dev@dimagi-chrome-extension` service account and on to
  `ace-service-account@connect-labs`, with a Shared Drive requirement note.

## 0.1.0 — 2026-04-09

Initial deploy infrastructure — ACE can now be installed, updated, and
diagnosed like a first-class Claude Code plugin.

### Added

- `.claude-plugin/marketplace.json` so ACE can be installed via
  `/plugin marketplace add jjackson/ace`. The repo root acts as both the
  marketplace and the plugin source.
- `VERSION` file as the lightweight source-of-truth for `bin/ace-update-check`.
  Must stay in lock-step with `plugin.json`, `marketplace.json`, and
  `package.json` on every release (`/ace:doctor` cross-checks them).
- `/ace:setup` — one-shot installer. Detects the plugin root, runs
  `npm install`, verifies `.gws-sa-key.json`, checks `tsx` and `.mcp.json`,
  and optionally registers a `SessionStart` hook for automatic update checks
  (`--auto-update`). Replaces the three manual README steps.
- `/ace:update` — rigid, scripted updater modelled on canopy's
  `/canopy:update`. Pulls from `~/.claude/plugins/marketplaces/ace`, rsyncs
  into a new versioned cache dir (excluding `node_modules` and the service
  account key, which are carried forward), runs `npm install`, updates
  `installed_plugins.json`, and tells the user to `/reload-plugins`.
- `/ace:doctor` — diagnostics command. Cross-checks version consistency,
  dependencies, the service account key, the MCP manifest, the update-check
  script, and related repos (`ace-web`, `connect-labs`). Prints PASS/WARN/FAIL
  with fix hints for each check.
- `bin/ace-update-check` — lightweight bash script borrowed from gstack. Reads
  local `VERSION`, curls the remote from `raw.githubusercontent.com`, caches
  in `~/.ace/update-check` (60-min TTL up-to-date, 720-min TTL
  upgrade-available), and respects a snooze file with escalating backoff
  (24h / 48h / 7d). Outputs `UPGRADE_AVAILABLE` / `JUST_UPGRADED` / nothing.
- `migrations/` directory and `migrations/README.md` explaining when to add
  version-to-version migration scripts for breaking changes.

### Changed

- README `Setup` section rewritten to describe the marketplace install
  followed by `/ace:setup` and `/ace:doctor`. Manual instructions are kept as
  a fallback for local dev checkouts.

### Inheritance notes

- **Canopy pattern (plugin manifest + marketplace + rigid update):** the
  update flow and marketplace layout are straight ports of canopy's approach,
  which has proven durable across 0.2.20 → 0.2.28 releases. ACE improves on
  canopy by carrying the service-account key forward across upgrades
  explicitly (canopy has no equivalent secret) and by running `npm install`
  inside the new cache dir so `node_modules` is always in sync with the
  updated `package.json`.
- **Gstack pattern (lightweight update-check + snooze):** `bin/ace-update-check`
  is a direct port of gstack's `bin/gstack-update-check`, minus the telemetry
  ping and the stale-Codex-description migration. The snooze levels (24h / 48h
  / 7d) and cache TTLs (60m / 720m) are kept identical — they're well-tuned
  and I didn't see a reason to deviate for a first cut.
