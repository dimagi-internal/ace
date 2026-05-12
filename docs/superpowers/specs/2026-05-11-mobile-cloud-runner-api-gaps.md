# Mobile cloud runner — closing the API gaps

**Status:** Draft (2026-05-11)
**Related:** [2026-05-09-mobile-cloud-runner-poc.md](2026-05-09-mobile-cloud-runner-poc.md) (parent design)
**Author:** Jonathan + claude (audit pair)

## Why

The POC shipped and is in production on `emdash/mobile-recipe-cwd-fix`. Audit of the ACE ↔ ace-web HTTP contract revealed a small set of gaps where ace-web has the information internally but isn't surfacing it to the ACE plugin. This spec captures the gaps, the fix per gap, and what stays explicitly deferred.

**Out of scope** (intentionally deferred):
- **Client-side APK upload via presigned PUT.** Standard Connect APKs are baked into AMI states (`/opt/ace/states.yaml`) and installed by `ensure-running`. Custom APK upload only matters for RC testing, which we don't have yet.
- **Async `run-recipe` with polling / streaming.** Synchronous up to the 30-min SSM ceiling is fine until a real Phase 8 walkthrough hits that wall.
- **`bootTimeMs` in `ensure-running` response.** Nice-to-have for monitoring; defer.

## Gap inventory and fix per gap

### Gap 1 — `install-apk` doesn't return `version_code`

**Where:** `apps/mobile/controller.py:279-307` (`EmulatorController.install_apk`).

**Today:** Parses `package_name` and `version` (= `versionName`) from `aapt dump badging`. Doesn't extract `versionCode`. ACE's `ApkInfo` requires `versionCode: number`; the cloud backend hardcodes `0` (`mcp/mobile/backends/cloud.ts:194`).

**Why it matters:** Phase 8 `app-release` post-release verification checks installed CommCare version. `versionCode` is the monotonic integer; `versionName` is human-readable and can be ambiguous (`"2.62.0"` vs `"2.62.0-rc1"`).

**Fix:**
- Extend the `aapt dump badging` parser to also grep `versionCode='N'`.
- Add `version_code: int` field to `InstallResult` (controller dataclass + view envelope).
- Update `mcp/mobile/backends/cloud.ts` install_apk parser to consume `result.version_code` instead of hardcoding `0`.

### Gap 2 — `capture-ui-dump` returns raw XML only

**Where:** `apps/mobile/controller.py:460-474` (returns `result.stdout` as raw XML string).

**Today:** Returns `{xml: <raw_uiautomator_dump>}`. Clients have to parse it themselves. ACE's cloud backend returns `{xml, elements: []}` — `elements` is hardcoded empty.

**Why it matters:** Selector-based skills want `elements[]` to assert "this control exists" or "the value of textbox X is Y." Every client parsing the XML separately is duplicated work, and the local AVD backend already returns parsed elements.

**Fix:**
- Server-side: parse the XML once in the controller. Return `{xml, elements: [{id, text, class, bounds, clickable}]}`.
- The local AVD backend (`mcp/mobile/backends/avd.ts:capture_ui_dump`) already does this parse; lift its logic to the controller (or re-parse on the ACE side until we know callers need it).
- Update `mcp/mobile/backends/cloud.ts:246` to surface `result.elements` instead of `[]`.

**Decision: parse server-side.** Reasoning: (a) every client needs the parse, so one canonical parser beats N; (b) keeps the cloud backend's response shape parallel to the AVD backend's; (c) the raw XML is large — clients that don't need it can ignore the field.

### Gap 3 — `run-recipe` returns no structured step report

**Where:** `apps/mobile/controller.py:309-369` (returns `RunResult{exit_code, stdout, stderr, artifacts[]}`).

**Today:** Skills reconstruct step ordering from artifact filenames (`01_tap_button.png`, `02_assert_visible.png`). Fragile — depends on Maestro naming conventions and recipe authors not skipping numbers. No way to know which step failed without parsing stdout heuristics.

**Why it matters:** Phase 8 walkthroughs need to surface "step 4 of 12 failed at assertVisible(text='Submit')" — currently impossible without scraping Maestro's stdout. Eval rubrics also want structured per-step status to assert "did the recipe reach step N."

**Fix:**
- Maestro's `--debug-output` directory writes structured artifacts: `commands-(json|html)`, `screenshots/`, `maestro.log`. The JSON is one record per executed command with `command`, `metadata`, `screenshot`.
- Parse the JSON in the controller after `aws s3 cp` finishes. Build `steps: [{index, name, status: 'pass' | 'fail' | 'skipped', screenshot_name?, error?, duration_ms?}]`.
- Add `steps: list[Step]` to `RunResult` alongside existing `artifacts[]`.
- ACE `cloud.ts:CloudRunResult` gains `steps?: StepResult[]`; `RecipeRunResult` in `mcp/mobile/types.ts` similarly. Skills that don't need it ignore it; `app-screenshot-capture` becomes order-independent.

**Open question:** Does Maestro emit a per-command JSON in `--debug-output`, or only an aggregate `commands.json`? The implementation PR should verify against an actual Maestro run before nailing down the shape. If only aggregate, the per-step shape may need to be derived; we may also need to fall back to parsing `maestro.log`. **Action:** implementation PR starts by running one recipe end-to-end against the staging instance and pasting an `ls -la /tmp/run-<id>/` in the PR description, so reviewers see the actual debug-output surface.

### Gap 4 — `stop` has no busy guard

**Where:** `apps/mobile/views.py:316-331` (`stop`) and `apps/mobile/controller.py:227-236`.

**Today:** Stop endpoint deliberately bypasses the singleton lock to allow aborting a hung recipe. Means an accidental stop call mid-run kills a legitimate flow with no warning.

**Why it matters:** As we wire more skills to the cloud, accidental concurrent calls become more likely. The "abort hung recipe" path is rare and intentional; the "two skills accidentally racing" path is common and silent.

**Fix:**
- Add `force: bool = false` to the stop request body (new `StopSerializer`).
- View logic:
  - Read singleton state (without acquiring).
  - If busy and `force=false`: return `singleton-busy` error (HTTP 409) with `{current_owner}`.
  - Otherwise: existing behavior — call controller.stop().
- ACE `mcp/mobile/backends/cloud.ts:stopAvd` passes through a `{force?: boolean}` option.

### Gap 5 — `register_test_user` is unhandled on cloud

**Where:** `mcp/mobile/client.ts:registerTestUser` routes to `avd.registerTestUser` even when `useCloud=true`; `CloudBackend` has no such method, so the call throws.

**Today:** Spec (`2026-05-09-mobile-cloud-runner-poc.md:152`) says the cold-boot path on cloud already runs the +7426 demo registration recipes — `register_test_user` is meant to be a no-op on cloud. Implementation never landed.

**Fix:** In `mcp/mobile/client.ts:registerTestUser`, short-circuit when `useCloud`:

```ts
registerTestUser(avdName: string): Promise<TestUserInfo> {
  if (this.useCloud) {
    // Cold-boot path on ace-web already registers the +7426 demo user
    // before /run/ace-mobile/ready is touched; this atom is a no-op.
    return Promise.resolve({ phone: '+7426...', registered: true, source: 'cloud-baked' });
  }
  return this.avd.registerTestUser(avdName);
}
```

Pin the exact pre-baked phone number from `infra/mobile-ami/scripts/`. Add a unit test that verifies the no-op shape.

## Sequencing

| Order | PR | Repo | Independent? |
|------|----|----|------|
| 1 | Gap 5 (register no-op) | ACE | Yes |
| 2 | Gap 1 (version_code) | ace-web | Yes |
| 3 | Gap 2 (parsed elements) | ace-web | Yes |
| 4 | Gap 4 (stop busy guard) | ace-web | Yes |
| 5 | Gap 3 (structured steps) | ace-web | Yes — biggest |
| 6 | ACE-side type updates | ACE | Blocked by 2 + 5 |

PRs 1–4 can ship in parallel. PR 6 lands after the ace-web PRs are merged + deployed.

## Verification

Per PR:
- Unit test in `apps/mobile/tests/` for shape (request validation + envelope).
- Integration test (where applicable) hits the staging instance via `MOBILE_INTEGRATION=1`.

End-to-end:
- Re-run `app-screenshot-capture` on the staging cloud instance after PR 6 lands; confirm screenshots line up with `steps[]` and `versionCode` populates.

## Non-goals

- New endpoints (everything fits in existing routes).
- Client-side APK upload (deferred).
- Async / job-queue refactor (deferred).
- Changing the `{data, error}` envelope (additive only).
