# Static-recipe preventer suite — the shift-left principle

**Date**: 2026-05-25
**Status**: Resolved. Preserved as the canonical worked example of the shift-left principle for mobile recipes.

## Durable principle

**Failure classes that are deterministic from artifacts available at phase boundary N should be detected at N, not N+M.**

Mobile recipes are syntactically valid YAML but can be structurally broken in ways that are obvious from the recipe text + adjacent Nova/Connect data alone. That data is in-scope at Phase 3 (recipe-write time) but not at Phase 6 (run time, after expensive AVD bootstrap). Linting at Phase 3 turns 5–10-minute Phase 6 wall-clock burns into ~1-second pre-flight rejections.

The corollary: **when a SKILL.md tightening lands post-incident, ship the code-level check in the same PR.** Prose alone is not a preventer — the next opp will re-hit the class until the rule is internalized.

## Preventers shipped under this principle

Three checks in `mcp/mobile/recipe-lint.ts` + `mcp/mobile/recipe-sanity-probe.ts`:

1. **`inputText-scalar-with-sibling-option`** (recipe-lint) — `- inputText: "x"\n  optional: true` shape, Maestro rejects with `expected <block end>`.
2. **`form-advance-without-answer-tap`** (sanity-probe) — two or more consecutive `form-advance` invocations with no answer step between, stalls on "Sorry, this response is required."
3. **`brief-label-drift`** (sanity-probe) — `tapOn:text:"X"` matching brief naming patterns (`^[LFM]\d+ — `, `^Stage \d+ — `) that Nova rewrites during autobuild.

Plus a whole-palette CI gate (`test/mcp/mobile/static-palette-health.test.ts`) that asserts every file in `mcp/mobile/recipes/static/` parses, declares `appId:`, passes lint, and resolves every `${SELECTOR:...}` ref against the active selector map.

Plus the atlas-drift harvester (`scripts/probe-atlas-drift.ts` + `lib/atlas-drift.ts`) — read-only — harvesting selector-drift signal from accumulated `runRecipeWithDumps` XMLs.

## Where the principle still has slack

When a new mobile failure mode surfaces in Phase 6, ask first: "is this deterministic from the recipe text + the live Nova/Connect data?" If yes, the fix belongs in `recipe-lint.ts` or `recipe-sanity-probe.ts`, not in a tighter SKILL.md paragraph. Today's known candidates that still ship to Phase 6:

- **Recipe provenance staleness** — generated journey recipes on Drive don't carry `ace_version` / `selector_map_sha`, so a Phase 6 run can dispatch a recipe written against an older selector map. Class-level finding #1 in `2026-05-14-phase6-validation-arc.md`.

## Tooling trap to remember

`scripts/dump-atom-schemas.ts` is string-aware but comment-unaware. A bare `'` in a JS line comment inside any `mcp/*-server.ts` (e.g. `// Maestro's parser`) starts a phantom string that the parser walks through, silently dropping every `server.tool(...)` after it from `docs/atom-schemas.md`. Symptom: the staleness gate fails and the catalog is missing atoms from one server. Workaround: rephrase the comment. Structural fix (teach the parser about `//` + `/* */`) deferred.
