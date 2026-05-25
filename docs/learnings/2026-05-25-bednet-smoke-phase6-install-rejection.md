# 2026-05-25 — Bednet smoke run halted at Phase 6 by Deliver-CCZ on-device install rejection — root-caused

## Headline

The `bednet-spot-check / 20260525-1405` smoke run halted at Phase 6 with the device showing **"A part of your application is invalid"** on Deliver-app install. Root cause is a bad `entity_id` substitution added to `pdd-to-deliver-app/SKILL.md` in PR #445 (2026-05-24) based on a `/canopy:select-session` rescan with no captured artifact, which contradicted an explicit verified learning from one day prior. Two additional preventers surface alongside the proximate fix.

## Proximate root cause

The Deliver app shipped with `connect.deliver_unit.entity_id: "#case/case_name"`. CommCare's device-side `XFormAndroidInstaller` / `SuiteAndroidInstaller` (commcare-android `app/src/org/commcare/android/resource/installers/XFormAndroidInstaller.java:99-100, 104-106`) wraps the XPath-eval failure into `InvalidResourceException`, which `AppInstallStatus` (line 35) maps to `notification.install.invalid.title` = "A part of your application is invalid."

`#case/case_name` resolves to the `case_name` field, which on a case-create form is the hidden field with `calculate: concat(#user/username, '-', uuid())`. Per JavaRosa semantics, that field is evaluated at form-submit time — but the device's install-time parse / suite resolution touches the `entity_id` binding earlier in the resource graph and finds no resolvable value. Install rejected.

**The canonical pattern (per Vellum's own help text, `src/commcareConnect.js:243`) is `#case/case_id`:**

> "XPath expression for the entity ID associated with this Delivery Unit e.g. the case ID."

JavaRosa case-create allocates the case UUID synchronously at the start of form processing, so `#case/case_id` IS resolvable from that point. The architect's PR #445 reasoning — "`case_id` is being assigned mid-form and isn't resolvable at submission time" — was incorrect.

## Why PR #445 was wrong

- **No captured artifact.** PR #445 (commit `749888e`, 2026-05-24) came from a `/canopy:select-session` rescan citing the `e2e-malaria-rdt` 2026-05-24 run. No `validate_app` response, no error message, no app id, no reproducer was preserved.
- **Contradicted a verified learning from one day prior.** `docs/learnings/2026-04-29-nova-connect-marker-bugs.md:92-95` records that on 2026-05-23, ACE verified live against Nova app `onyIxf7jEqGKv8HmcTIS` that `entity_id: "#case/case_id"` and `entity_name: "#case/case_name"` **persisted exactly as passed on re-fetch**. That learning is marked "Status: Resolved — all bugs fixed upstream."
- **No Nova issue exists.** `gh search prs --repo voidcraft-labs/nova-plugin` returns 18 issues; none mention `#case/case_id` or `entity_id` validator rejection. PR #445 author note acknowledges: "Not yet filed as a Nova issue — needs a clean reproducer first."
- **Vellum (the source-of-truth UI) cites `case_id` as the canonical example** — `src/commcareConnect.js:243`. The Vellum fixtures bind `entity_id` to session references, never `#case/case_name`.

## Three structural preventers

### Preventer 1 — Revert PR #445 (the proximate fix; ship today)

**Action:** revert commit `749888e` against `skills/pdd-to-deliver-app/SKILL.md:391-403` and `playbook/integrations/nova-integration.md:277-302`. Restore the prior `#case/case_id` recommendation.

**Test:** rebuild the bednet Deliver app with `entity_id: #case/case_id`, redeploy + release, install on AVD, expect clean install.

**Add a learning** (`2026-05-25-entity-id-misdiagnosis.md`) documenting:
- The canonical pattern is `#case/case_id` per Vellum source
- The 2026-05-23 live round-trip verification
- The session-rescan failure mode where a finding had no captured artifact and contradicted an explicit verified learning one day older

**Process fix:** `/canopy:select-session`-style findings that recommend skill-text changes contradicting an existing verified learning must require artifact capture (the actual error string + the actual sent payload) before landing.

### Preventer 2 — Phase 3 device-install gate via `commcare-cli.jar validate`

**The gap:** every Phase 3 check today (`validate_app`, `make_build`, release, `app-release-smoke` projection) is static. None of them exercise CommCare's runtime install path. PR #445 shipped through every Phase 3 `pass`-verdict and broke at Phase 6.

**The fix exists upstream.** `dimagi/commcare-core` ships `commcare-cli.jar` with a `validate` subcommand:

- `src/cli/java/org/commcare/util/cli/CliValidateCommand.java` wraps `engine.configureApp(resourcePath)` then `engine.describeApplication()`
- Runs the SAME `ResourceTable.initializeResources` install path the Android device runs
- Triggers the SAME `XFormParser`, `SuiteParser`, `ProfileParser` → `InvalidResourceException` chain that produces "A part of your application is invalid"
- Builds via `./gradlew cliJar` → `build/libs/commcare-cli-*.jar`
- Java 17 required (matches our existing AVD-tooling JDK requirement)

**Concrete shape:**

1. **One-time bootstrap (per machine):** add to `/ace:mobile-bootstrap` or a new `/ace:commcare-cli-bootstrap` — git clone + cliJar + cache at `${CLAUDE_PLUGIN_DATA}/commcare-cli.jar`. Add freshness probe to `/ace:doctor`'s `[Auth liveness]` block.
2. **New atom `commcare_validate_ccz({ ccz_base64 })`** in `ace-connect` MCP (`mcp/connect/backends/commcare.ts`). Writes bytes to a tmp file, runs `java -jar commcare-cli.jar validate <tmp>.ccz`, parses stdout/stderr + exit code. Returns `{ verdict, failed_resource, parser_message }`.
3. **Wire into `skills/app-release-smoke/SKILL.md` as new Step 4** (pre-marker checks). Same class as existing structural checks; halts loud on the same `fail` shape. Add failure mode `device-install-invalid`.
4. **Coverage delta:** catches every defect class in `XFormParser`, `XPathException`, `SuiteParser InvalidStructureException`, and profile-XML parse errors at Phase 3 § Step 2.8 instead of Phase 6.

**Caveat:** Java-side installers don't surface Android-only behaviors (SQLite quotas, Android-only file ref schemes), but the user's symptom class — `InvalidResourceException` from XForm/Suite/Profile parse — *will* surface.

**Alternatives rejected:**
- **`adb install` of CCZ to a 2nd AVD** — infeasible. `adb install` is APK-only (PackageManager protocol); CommCare consumes CCZs via in-app `ResourceEngineTask` reachable only through "Install from URL" or Connect's claim handoff. Scripting either via Maestro on a 2nd AVD is re-implementing Phase 6 at higher cost.
- **Replicate the parser in TS** — would re-invent javarosa's XForm parser; multi-month effort; drifts from upstream.

### Preventer 3 — Registration recipe terminal-state assertion

**The gap:** `connect-register-from-otp.yaml` asserts on the intermediate `connect_verify_pin_button` screen. The demo-user flow transitions through this screen in ~2s, and Maestro's 15s assertion window can miss it. Underlying registration completes; the recipe halts a phantom failure.

**The fix:** change the success criterion to assert on the terminal state ("Connect opportunities home visible"). Document the new contract: "this recipe is done when the device shows the opp list, not when any specific intermediate screen renders."

**Backstop:** in `MobileClient.restoreDeviceUserState` (`mcp/mobile/client.ts`), after Maestro returns success OR failure, probe the device for "Connect home reachable" and treat as registered regardless of recipe verdict. The race is between Maestro's polling window and actual screen transitions; final device state is authoritative.

**Severity:** medium. Pure recipe flakiness; doesn't ship broken downstream. Just creates phantom Phase 6 halts that send operators chasing the wrong root cause (today's run is exactly that — I spent significant time chasing GMS banners before discovering the device had registered fine and a different downstream issue was the real blocker).

## Run state

- `bednet-spot-check / 20260525-1405` halted at Phase 6 with `phases.qa-and-training.status: error, verdict: incomplete`.
- Phases 1–5 all `verdict: pass`. Connect opp `0e3a980b-bbc5-4167-a0d6-a949109edc14` activated; OCS chatbot `12251` live.
- Run not resumed — operator chose to address structural preventers first.
- Live entities (Connect opp, OCS chatbot) remain — `/ace:sweep` candidates if discarded.

## Followup checklist

- [ ] Revert PR #445 (Preventer 1) — restores `#case/case_id` guidance; one-line skill diff plus learning doc
- [ ] File commcare-cli integration as a proposal — implement Preventer 2 (`commcare_validate_ccz` atom + `app-release-smoke` Step 4 + bootstrap step + doctor probe)
- [ ] File registration recipe terminal-state fix — Preventer 3 (`connect-register-from-otp.yaml` assert change + `restoreDeviceUserState` backstop)
- [ ] After PR #445 revert: re-run `pdd-to-deliver-app` on `bednet-spot-check` to rebuild Deliver app with correct entity_id, confirm install succeeds
- [ ] After Preventer 2 ships: backfill against past runs to find any other deliver_unit configs that would have failed install but passed our static gates

## Key file / PR citations

- Wrong guidance (to revert): `skills/pdd-to-deliver-app/SKILL.md:391-403`, `playbook/integrations/nova-integration.md:279-288`
- Verified canonical (to restore): `docs/learnings/2026-04-29-nova-connect-marker-bugs.md:92-95`
- Vellum source-of-truth: `voidcraft-labs/nova-plugin` Vellum `src/commcareConnect.js:240-249`
- CommCare error origin: commcare-android `app/src/org/commcare/engine/resource/AppInstallStatus.java:35`, `app/src/org/commcare/android/resource/installers/XFormAndroidInstaller.java:99-100, 104-106`, `tasks/ResourceEngineTask.java:149-151`
- CommCare offline validator: commcare-core `src/cli/java/org/commcare/util/cli/CliValidateCommand.java`, `src/cli/java/org/commcare/util/cli/CliCommand.java:67-99`, `build.gradle:151`
- Phase 3 gates (gap surface): `skills/app-release-smoke/SKILL.md:17-50, 232-249`, `mcp/connect/backends/commcare.ts:402-457, 2070-2082`
- PR to revert: jjackson/ace#445, commit `749888e` (2026-05-24)
