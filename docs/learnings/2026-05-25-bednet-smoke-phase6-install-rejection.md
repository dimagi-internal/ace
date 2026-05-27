# Bednet install rejection — session-rescan findings need artifact capture

**Date:** 2026-05-25
**Status:** Resolved. All three structural preventers shipped in commit `ca991cd`.

## Durable governance rule (the actual learning)

**`/canopy:select-session`-style findings that recommend skill-text changes contradicting an existing verified learning must require artifact capture — the actual error string, the actual sent payload, a reproducer — before landing.**

PR #445 (2026-05-24) changed `pdd-to-deliver-app/SKILL.md` to recommend `entity_id: "#case/case_name"` based on a session-rescan finding with no captured artifact. The change contradicted a verified learning from one day prior (`2026-04-29-nova-connect-marker-bugs.md`: `#case/case_id` round-trips correctly through Nova as of 2026-05-23) and contradicted Vellum source-of-truth (`src/commcareConnect.js:243` cites `case_id` as canonical). The bednet Deliver app shipped with the wrong pattern and the device rejected install at Phase 6 with "A part of your application is invalid."

Without captured artifacts, there was no way to weigh a new finding against a prior verified learning. The rule above prevents recurrence.

## What's canonical

- **Deliver `entity_id` is `#case/case_id`** — JavaRosa allocates the case UUID synchronously at form start, so the binding is resolvable at install time.
- **`#case/case_name` is NOT a valid `entity_id`** — it's a `calculate: concat(#user/username, '-', uuid())` field evaluated at form-submit time, not install time. Device-side `XFormParser` rejects the suite resource.

## Preventers shipped (all in `ca991cd`)

1. **Revert PR #445** — `pdd-to-deliver-app/SKILL.md` restored to recommend `#case/case_id`.
2. **Phase 3 device-install gate** — new `commcare_validate_ccz({ ccz_base64 })` atom in `ace-connect` MCP runs `commcare-cli.jar validate` over the CCZ, exercising the same `XFormParser` / `SuiteParser` / `ProfileParser` chain the Android device runs at install. Wired into `app-release-smoke` as a structural check, so XForm/Suite/Profile parse failures halt Phase 3 instead of Phase 6.
3. **Registration recipe terminal-state assertion** — `connect-register-from-otp.yaml` now asserts on the terminal state (Connect home reachable) rather than the intermediate `connect_verify_pin_button` screen, eliminating phantom Phase 6 halts when Maestro's polling window misses the ~2s transition.

## Why this matters going forward

Every Phase 3 static check before `commcare_validate_ccz` (`validate_app`, `make_build`, release, the projection in `app-release-smoke`) is structural. None of them exercise CommCare's runtime install path. PR #445 shipped through every one and broke at Phase 6. The new gate closes that boundary — but only for `InvalidResourceException` class defects (XForm/Suite/Profile parse). Android-only behaviors (SQLite quotas, Android-only file ref schemes) still surface at Phase 6.

## Files

- `skills/pdd-to-deliver-app/SKILL.md` — restored `#case/case_id` guidance
- `mcp/connect/backends/commcare.ts` — `commcare_validate_ccz` atom
- `skills/app-release-smoke/SKILL.md` — wired in as a structural check
- `mcp/mobile/recipes/static/connect-register-from-otp.yaml` — terminal-state assertion
- Vellum source-of-truth: `voidcraft-labs/nova-plugin` `src/commcareConnect.js:243`
- Verified canonical: `docs/learnings/2026-04-29-nova-connect-marker-bugs.md:92-95`
