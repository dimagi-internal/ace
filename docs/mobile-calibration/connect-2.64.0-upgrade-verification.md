# CommCare 2.64.0 upgrade — verification checklist

`skills/connect-apk-upgrade § Step 8`. Filled in on **2026-09-06** against the
ship PR for the 2.63.2 → 2.64.0 bump. Companion to the calibration report,
`docs/mobile-calibration/connect-2.64.0-2026-09-06.md`.

**Read the status column literally.** Three rows are `PENDING-OPERATOR`: they
assert things about the *activated* machine, and activation is
`/ace:setup --force-env` followed by a full Claude Code restart — both of which
the operator owns, in that order (ace#880). They are not ticks anyone can take
from inside this PR, and marking them green here would be exactly the
assert-a-check-you-did-not-run failure CLAUDE.md § issue filing calls the most
expensive one.

## A. The pin actually took

| # | Assert | Status | Evidence |
|---|---|---|---|
| A1 | `selector_map_currency` is `pass`, `pin` == `code_default` == `newest_map` == `2.64.0` | **PENDING-OPERATOR** | `pin` reads the INSTALLED `.env`, which only `/ace:setup --force-env` rewrites. `code_default` and `newest_map` are both `2.64.0` in the repo now (`test/apk-pin-currency.test.ts` green). Run `bin/ace-doctor` after activation. |
| A2 | The residual names exactly which rows are `unverified` and why | **PASS** | 45 of 91, enumerated with reasons in the calibration report § Coverage + § Residuals and in `docs/mobile-atlas/connect-2.64.0.md` § Provenance. Not zero, and not required to be — doctor passes with an `info` (`bin/ace-doctor:2964-2966`). |
| A3 | `unresolved_selectors: []` | **PASS** | All 43 distinct `${SELECTOR:…}` references across the static palette resolve against `connect-2.64.0.yaml`; `test/mcp/mobile/static-palette-health.test.ts` asserts it per file with `DEFAULT_APK = '2.64.0'`, 92 tests green. |
| A4 | `env_freshness` names no stale pid | **PENDING-OPERATOR** | Guaranteed to FAIL until the restart — every live MCP child predates the `.env` write by construction. That is the probe working. |
| A5 | The live MCP subprocess runs the merged version | **PENDING-OPERATOR** | Same restart. Confirm with the `$PPID` + inner-`VERSION` read, not the version files (§ Step 7.3). |
| A6 | The device actually runs `2.64.0` | **PASS** | `dumpsys package org.commcare.dalvik` → `versionName=2.64.0`, `versionCode=490738` (2.63.2 was `488693`), corroborated in-app by the nav drawer's `app_version` = "v 2.64.0". Re-confirmed on the fresh cold-booted `emulator-5558` during the ace#2029 validation. |
| A7 | Every `pin` site agrees; no unclassified pin site exists | **PASS** | `test/lib/apk-pin-sites.test.ts` green. Seven sites flipped in one commit, enumerated from a live `scanApkPinSites()` run rather than from memory. |

**One pin site the scanner cannot see, flipped by hand and named here rather
than left silent:** `test/mcp/mobile/static-palette-health.test.ts`'s
`DEFAULT_APK`. `lib/apk-pin-sites.ts` deliberately excludes `test/` from
`SCAN_ROOTS`, so A7 is green whether or not this one moved. Its own comment says
to keep it in step with the runtime default; it now does.

## B. The device still works

| # | Assert | Status | Evidence |
|---|---|---|---|
| B1 | A cold boot reaches the precondition | **PASS** | Full heal funnel, 232s: cold boot with `-wipe-data` → install → environment baseline → registration → `ConnectActivity` / `rvJobList` with real opportunity tiles. |
| B2 | The APK downloads — the asset convention resolved | **PASS** | `local_bootstrap: CommCare 2.64.0 not installed on emulator-5558 — downloading + installing`, then a verified install. No `APK_DOWNLOAD_FAILED`. This is the reordered `candidateUrls` probe working against `commcare_2.64.0`, which ships `app-commcare-release.apk`. |
| B3 | Registration completes | **PASS (recovery branch)** / **RESIDUAL (fresh-signup branch)** | The recovery path — the one every `+7426` demo user takes — walked end to end through the NEW email step. The fresh-signup branch (`confirm_code_view`, then photo capture) was NOT reached: it needs a demo phone with no server-side account. Its email handling is written and statically resolved, not device-observed. See § The one open device residual. |
| B4 | Claim → Learn → Deliver walks end-to-end | **NOT REACHED** | Needs a fresh `/ace:run` opportunity. Learn completion is one-way per `(test user, opportunity)` (#568), so it cannot be borrowed off an existing opp. The next Phase 6 walk on 2.64.0 is what closes this. |
| B5 | Every static recipe `validated` + `resolved` + `ran-on-device` or has a named reason | **PARTIAL** | `validated` + `resolved`: all of them, machine-checked (`static-palette-health`, 92 assertions). `ran-on-device`: `connect-register-to-otp.yaml` + `connect-register-from-otp.yaml` only. The rest are `not-reached (needs a fresh /ace:run opp)`. |
| B6 | The version-upgrade prompt branch | **UNVERIFIABLE-POST-UPGRADE** | The prompt fires only on version SKEW, and installing 2.64.0 removes the precondition — so it cannot be made to appear from here. Tested rather than assumed: a fresh CCZ install on a wiped device went straight to `StandardHomeActivity`, and `grep -l "prompt_title\|do_later_button"` over all 2.64.0 evidence dumps returns no matches. The three rows ship flagged `unverified` as defence for the next skew. The skill now says to capture this in Step 0 of the NEXT upgrade, before its pins flip. |

## C. The rest of ACE still agrees with the new pin

| # | Assert | Status | Evidence |
|---|---|---|---|
| C1 | `npm test` green | **PASS** | 452 files / 6935 tests passed, 7 files + 33 tests skipped, 0 failed. |
| C2 | `npx tsc --noEmit` clean | **PASS** | Exit 0. |
| C3 | An atlas exists for `2.64.0` | **PASS** | `docs/mobile-atlas/connect-2.64.0.md`, written from the 34 committed dumps, tagged per surface. |
| C4 | `app-release-qa`'s CCZ min-version check changed disposition | **PASS — and this is a behaviour change to watch** | See below. |
| C5 | The calibration report's residuals are carried forward, not dropped | **PASS** | R1–R6 reproduced in `docs/mobile-atlas/connect-2.64.0.md § Residuals`; R7 (calibrate unexercised) folded into the skill itself. |

**C4 in full.** `lib/ccz-min-version.ts` keys severity on whether a remedy is
*reachable*: `required <= pinned` → `ok`; `required > pinned` **with** a selector
map covering `required` → `blocker`; `required > pinned` with no such map →
`warn`. Landing `connect-2.64.0.yaml` therefore flips every run whose CCZ
requires `<= 2.64.0` to `ok` — which is the ace#1997 mismatch resolved — and
flips anything still requiring MORE than 2.64.0 from `warn` to **`blocker`**,
because repinning is now something an operator can actually do. Expect Phase 3
to start halting on mismatches it previously only warned about. Intended: the
check gets sharper as coverage lands.

## The one open device residual

**The fresh-signup registration branch on 2.64.0 has not been walked.** The
recovery branch has, end to end. Both take the same guarded email block, and the
fresh branch additionally needed its `extendedWaitUntil take_photo_button` gated
on the email screen being absent — unguarded, it would hard-fail 25s before the
email block could run.

*What would falsify it:* a fresh-signup walk that strands between the email step
and photo capture, or reaches photo capture without the email screen appearing
at all (i.e. the nav-graph action `action_personalid_email_to_personalid_photo_capture`
does not fire in practice).

*What it costs:* a demo-user rotation to a `+7426` number with no server-side
account. The map's `personalid-confirm-code-view` row is already flagged
`unverified` for the same reason, and this is R2 in the calibration report.

## Operator activation — the two commands, in this order

1. **`/ace:setup --force-env`** — rewrites the installed `.env` so
   `ACE_CONNECT_APK_VERSION=2.64.0`. `/ace:update` does NOT touch it, so the
   machine stays on 2.63.2 until this runs. Never a raw `op inject` (it drops
   local-only keys like `ACE_WEB_PAT_TOKEN`; a `config/gating.json` deny rail
   blocks that form).
2. **Then quit and reopen Claude Code — a full process restart.** Every MCP
   server calls `dotenvConfig()` at module top level and consumes the result at
   import, so a subprocess spawned before the `.env` write holds the old value
   for its whole life (ace#880). `/reload-plugins` does NOT respawn MCP
   subprocesses.

Reversing the order fails silently. A1, A4 and A5 are the rows that go green
afterwards.
