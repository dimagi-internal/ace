# Learning: Static-recipe preventer suite — shift Phase 6 wall-clock burns left to Phase 3 lint

**Date**: 2026-05-25
**Context**: 0.13.391–0.13.395 lifecycle (PRs #471, #473, #474). End-of-day session lens after a careful review of how `app-test-cases` (Phase 3) generates the recipes that `app-screenshot-capture` (Phase 6) runs.
**Status**: Resolved

## Problem

Phase 6 smoke runs were repeatedly burning 5–10 min of AVD wall-clock to surface failure classes that are structurally detectable at recipe-write time. Three documented in-vivo incidents:

- **leep Phase 5 attempt 8 (2026-05-12)** — `- inputText: "..."\n  optional: true` shape ships, Maestro rejects with `expected <block end>` parse error.
- **malaria-rdt run 20260522-1002 Phase 6** — J1 chains `runFlow: form-advance.yaml` across 10+ required-input quiz questions with zero answer-selection steps, stalls on `warning_root` ("Sorry, this response is required").
- **jjackson/ace#115 finding 2** — recipes carry brief-style labels like `L0 — Why this matters` that Nova rewrites to `1. Why this matters` during autobuild; `tapOn:text` never resolves on the live screen.

In each case the SKILL.md prose was tightened post-incident, but no code-level check enforced the rule — so the same class would recur on the next opp until the human-readable guidance was internalized.

## Root Cause

Three classes, one shape: **the recipe is syntactically valid (passes `mobile_validate_recipe`) but structurally broken in a way that's deterministic from the recipe text + adjacent Nova/Connect data alone.** That data is in-scope at Phase 3 (recipe-write time) but not at Phase 6 (run time, after expensive AVD bootstrap).

Generalizable principle: **failure classes that are deterministic from artifacts available at phase boundary N should be detected at N, not N+M.** This is the same shift-left logic as the OPP_NAME mismatch check, the selector-resolution gate (Step 3.4), and the recipe-sanity-probe — applied to three more classes.

## Fix / Key Takeaway

Three structural checks landed in `mcp/mobile/recipe-lint.ts` + `mcp/mobile/recipe-sanity-probe.ts`:

1. **`inputText-scalar-with-sibling-option`** (recipe-lint) — regex-detects `- inputText: "x"\n  optional: true` before YAML parse; surfaces with rule-named error from `mobile_validate_recipe`.
2. **`form-advance-without-answer-tap`** (sanity-probe) — flags two-or-more consecutive `runFlow: form-advance.yaml` / `${SELECTOR:form-nav-next}` / `id:nav_btn_next` steps with no answer step (tapOn:text/index/id or inputText) between them.
3. **`brief-label-drift`** (sanity-probe) — flags `tapOn:text:"X"` where X matches the brief naming patterns (`^[LFM]\d+ — `, `^Stage \d+ — `) that Nova rewrites during autobuild.

Plus a **whole-palette CI gate** (`test/mcp/mobile/static-palette-health.test.ts`) that asserts every file in `mcp/mobile/recipes/static/`:
- parses as multi-document YAML
- declares `appId:`
- passes `lintRecipeText`
- every `${SELECTOR:foo}` ref resolves against the active selector map
- post-substitution YAML still parses + lints

Plus the **atlas drift harvester** (`scripts/probe-atlas-drift.ts` + `lib/atlas-drift.ts`) — read-only — that closes the consume half of the side-channel-capture learning by harvesting selector-drift signal from accumulated `runRecipeWithDumps` XMLs.

### Side observation worth pinning

While shipping PR #471, the `scripts/dump-atom-schemas.ts` parser silently dropped every atom following a JS line comment that contained a bare `'` (apostrophe). The parser is string-aware but comment-unaware, so `// Maestro's parser` starts a phantom string that consumes the rest of the file. Worked around by rephrasing the comment + documenting the trap inline at the affected `server.tool` call. The structural fix (teach the parser about `//` and `/* */`) is deferred but cheap if it bites again.

### What this leaves on the table

- `dry_run_selectors` mode in `mobile_run_recipe` (Step 3.5 in `app-test-cases/SKILL.md`) is still a no-op. The static brief-label check catches the bulk of the underlying class without it.
- `deliver-launch.yaml`'s `§ 8` certificate + `§ 9` Download Delivery surfaces still use coordinate-fallback selectors captured from one 1080×2400 turmeric session. Atlas-drift harvester surfaces new IDs whenever a Phase 6 run finally captures dumps mid-window between Learn-pass and Deliver-download.

The general lesson: when a SKILL.md tightening lands post-incident, ship the code-level check in the same PR (or the immediately-following one). Prose alone is not a preventer.
