# app-release — reference

Extended rationale, worked examples, and incident history for
`app-release/SKILL.md`. None of this is executable: the skill executes the
Process steps, decision rules, atom calls, and gotchas in SKILL.md. This
file exists so that prose moved out of the skill (to keep the per-run
context small) is not lost.

## Why this skill exists

Nova's `/nova:upload_to_hq` writes the app to CCHQ as a **draft** (the
in-flight working copy). It does NOT make a versioned build, and does NOT
release one. By design — Nova doesn't release apps directly.

Connect, however, only sees apps that have at least one **released build**.
Specifically:
- Connect's `connect_create_opportunity` accepts the bare app id and the
  ace-connect MCP wraps it in the form-value Connect requires (0.10.1+),
  so opp creation works against unreleased apps.
- BUT `Sync Deliver Units` (the wizard step that populates per-payment-unit
  deliver-unit checkboxes) reads the *released* build's form schema. Without
  a release, the deliver-units list is empty, no payment unit can be
  created, and the opp is stuck in draft.

This skill closes that gap.

## How the endpoints were discovered

CCHQ's URL patterns are internal UI routes, not public APIs. The verified
endpoints in SKILL.md § Endpoints were discovered by network-tracing the
UI's `Make New Version` and `Released` toggle on
`/a/<domain>/apps/view/<app_id>/releases/`. They were tested live against
`0c96435881b0...` (deliver) and `76fd5f0e2834...` (learn) on
connect-ace-prod — both successfully released.

If the URL pattern shifts in a future CCHQ release, use the probe procedure
in SKILL.md to rediscover it.

## Why prefer the MCP atoms over raw Bash + curl

The orchestrator used to regenerate `/tmp/ace-release.js` scripts on every
Phase 3 run (turmeric-20260429-2330 spent ~10 min on this); the
`commcare_make_build` / `commcare_release_build` / `commcare_download_ccz`
atoms eliminate that loop. The bash/curl path documented in SKILL.md is the
fallback for when the URL contract shifts and a re-probe is needed.

## BuildRejectedError auto-fix loop — origin

The Step 4a auto-fix loop with the Nova architect was added 0.13.141 after
the leep run 20260509-2204 halt: CCHQ rejected a Learn build because Nova's
XForm emitter skipped entity-encoding `<` in an MCQ option label. PR #206
(0.13.140) made that diagnostic legible; the loop fixes the bad XForm at the
source (the Nova app) and retries.

## Why the BuildRejectedError loop is bounded at 3

A perpetually-failing form is almost certainly a Nova-emitter regression
that the architect can't see (it lives below `validate_app`'s scope). Three
attempts gives the architect a chance to fix the obvious case (literal
angle-bracket in a label) and one chance to fix a non-obvious case the first
round missed; beyond that we're burning cycles on a structural bug that
needs human eyes on the emitted XForm XML.
