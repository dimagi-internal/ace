# Phase 6 validation arc — 5 retries, 11 PRs, 1 breakthrough

**Date:** 2026-05-14
**Opportunity:** `turmeric / 20260513-2243`
**Final outcome:** Phase 6 J5 passes end-to-end on ACE v0.13.220.

## The arc

Each retry surfaced exactly one structural bug. Each bug got a focused PR. This is the one-fix-per-retry pattern the operator coined mid-session — "the cheapest possible debug gate."

| Retry | Surfaced | Fix |
|---|---|---|
| 0 (`/ace:run`) | Phase 6 halt at `assertVisible` against empty `connect_fragment_jobs_list`. Misattributed to invite-propagation timing for ~weeks. | — |
| 1 (atlas walk) | Manual AVD walk: snapshot's wall-clock froze → cached Connect Token real-time-expired → 401. | PR #281: `syncDeviceClockToHost` (band-aid). |
| 1.5 (architecture pivot) | Operator: "demo users skip OTP, re-register is ~20s, snapshot fast-path isn't worth the bugs." | PR #282: drop snapshot tier-1 entirely; always `pm clear` + `registerTestUser` on every dispatch. `docs/learnings/2026-05-14-demo-user-no-otp.md` anchors the no-OTP fact. |
| 2 (Phase 6 retry) | Heal works. `connect-claim-opp.yaml` had wrong assumptions: newest invite at the BOTTOM of the jobs list (not top), and `tvTitle` is `clickable=false` (must scope `tapOn` by `below: text`). | PR #283. |
| 2.5 (selector audit) | The recipes referenced selectors that didn't match the atlas — `unverified: true` placeholders never updated when the atlas walk reached those surfaces. | PR #285: rewrote selector map + 4 static recipes against atlas-grounded values. |
| 3 (Phase 6 retry) | Stale per-journey recipes on Drive (`J1`, `J5` generated at v0.13.209 used renamed selectors). Selector-resolve halt before any AVD navigation. | Mechanical rename: `form-question-next` → `form-nav-next`, etc. across J1 + J5 on Drive. |
| 3.5 (Phase 6 retry) | `connect-claim-opp.yaml`'s post-`btn_start` assertion was on `tv_learn_modules_list` (the PRE-claim teaser). Reality: post-claim auto-launches StandardHomeActivity. The teaser is bypassed entirely. | PR #288: anchor on `nsv_home_screen` instead. |
| 4 (Phase 6 retry) | Atlas mislabeled: Learn-app has **2** MenuActivity levels (module list → form list → FormEntryActivity), not 1. Earlier atlas walk drilled only one level deep. | PR #290: atlas §6 rewritten; J5 patched to chain TWO `learn-tap-module` invocations. |
| 5 (Phase 6 retry) | **J5 PASSES.** Two harness gaps surfaced as workarounds: `mobile_run_recipe` doesn't auto-inject `ACE_E2E_*` env vars or resolve `${SELECTOR:...}` placeholders. | PR #291: `recipe-resolver.ts` — both auto-injections happen unconditionally in `MobileClient.runRecipe`. |

## What the arc proves

- **The heal layer works** (validated 5 dispatches in a row, every one returning `healed_via: local-bootstrap`).
- **The atlas is now ground truth** for navigation. Recipes that contradict the atlas fail; recipes that match the atlas pass.
- **The deterministic-bootstrap design is correct** — the snapshot fast-path's failure modes were not worth the ~20s saved per dispatch.
- **Single-bug-per-retry is the right cadence.** Five fixes in series, each independently testable, none coupled. Coupling would have made the debug loop quadratic.

## Class-level findings (worth carrying forward)

### 1. Stale Drive artifacts vs current code

When a code change renames a logical selector or restructures a recipe pattern, **every previously-generated journey recipe on Drive is silently stale.** Retry #3 lost a full Phase 6 dispatch to a mechanical rename that needed Drive regeneration. The structural fix: when `app-test-cases` writes journey recipes, embed `ace_version` and `selector_map_sha` so a pre-flight gate can detect stale artifacts before running.

Filed as a future work item — not landed this session.

### 2. The atlas is the contract; recipes must follow

Three of the five bugs were "recipe held a stale understanding of a surface." Each time, the atlas was correct and the recipe out of sync. PR #285 + #288 + #290 all fixed the same class: recipe-vs-atlas drift.

The structural fix that DID land: `skills/app-test-cases/SKILL.md` now lists the atlas as an authoritative input (PR #286). Future journey-recipe authoring reads atlas first.

### 3. MCP atom boundaries should auto-resolve conventions

`mobile_run_recipe` previously required callers to pre-resolve placeholders + inject env vars. Every caller had to remember to do this. The retry agent dutifully reinvented the workaround twice (retry #5 explicitly mentions writing resolved recipes to disk before invoking the runner).

The class-level fix (PR #291): `MobileClient.runRecipe` does both auto-resolutions unconditionally. Caller-provided values still win on conflict — the auto-injection only fills KEYS the caller didn't already set. Class-level preventer at the right boundary; matches the pattern from `CLAUDE.md § Conventions` ("Class-level preventers > instance-level fixes").

## What's still gappy

- **Atlas Deliver walk** — deferred. Phase 6 J1 documents the gap at the Learn-complete boundary; passing the Final Assessment + walking Deliver-side surfaces is ~45 min interactive work. Worth doing in a focused session.
- **Stale-artifact pre-flight gate** — see class-level finding #1.
- **Maestro driver self-repair convergence** — retry #2 needed manual intervention (`pm uninstall dev.mobile.maestro{,.test}`). The heal-layer probe's `repairDriver` should drive to convergence within one atom call. Filed as the "harness-gap" in retry #5; worth a small PR.
- **ace-web fork alignment PR #348** — open, awaiting manual merge.

## Process notes

- **9 ACE PRs + 1 ace-web PR shipped today**, with ace plugin going from v0.13.208 → v0.13.220.
- **Each Phase 6 retry took ~5-15 min** (the heal warm-up plus J1/J5 walk). Total wall-clock for 5 retries: ~1 hour.
- **The pattern that worked**: ship ONE fix → re-dispatch → ship next fix → re-dispatch. Resist the urge to bundle "while I'm in here" fixes — they couple failure modes.
- **The atlas was the load-bearing artifact.** Without ground-truth documentation of every surface, each retry would have re-litigated "what does the post-claim screen look like?" The atlas grew from 7 screens to a fully-documented Learn-side pipeline over the course of the day.
