# Static-recipe preventer suite — the shift-left principle

**Date**: 2026-05-25
**Status**: Resolved. Preserved as the canonical worked example of the shift-left principle for mobile recipes.

## Durable principle

**Failure classes that are deterministic from artifacts available at phase boundary N should be detected at N, not N+M.**

Mobile recipes are syntactically valid YAML but can be structurally broken in ways that are obvious from the recipe text + adjacent Nova/Connect data alone. That data is in-scope at Phase 3 (recipe-write time) but not at Phase 6 (run time, after expensive AVD bootstrap). Linting at Phase 3 turns 5–10-minute Phase 6 wall-clock burns into ~1-second pre-flight rejections.

The corollary: **when a SKILL.md tightening lands post-incident, ship the code-level check in the same PR.** Prose alone is not a preventer — the next opp will re-hit the class until the rule is internalized.

## Preventers shipped under this principle

Four checks in `mcp/mobile/recipe-lint.ts` + `mcp/mobile/recipe-sanity-probe.ts`:

1. **`inputText-scalar-with-sibling-option`** (recipe-lint) — `- inputText: "x"\n  optional: true` shape, Maestro rejects with `expected <block end>`.
2. **`form-advance-without-answer-tap`** (sanity-probe) — two or more consecutive `form-advance` invocations with no answer step between, stalls on "Sorry, this response is required."
   - **Label-screen carve-out (ace#858, 2026-07-27).** The original rule was screen-blind and false-positived on any content-rich Learn app: `label` fields have no answer to tap and can ONLY be crossed by consecutive nav-next taps, so a *correct* walk over N consecutive labels reads as a chain of N+1. Because the SKILL.md remediation is a no-op for a label screen, the `incomplete` halt looped forever. The probe now takes optional per-form `fields` and raises the threshold to (longest run of consecutive `label` screens) + 2. Labels *inside* a group don't count — a field-list is one screen however many labels it holds. The carve-out deliberately trades recall for precision: a missed chain fails loud on-device with forensics, a false positive blocks the phase outright.
3. **`group-field-list-per-question-walk`** (sanity-probe, ace#862, 2026-07-27) — a `form-advance` sitting strictly BETWEEN two children of the same Nova `group`. A group compiles to a CommCare field-list (all children on ONE screen), so there is nothing to advance to; the tap fires with required siblings unanswered. Detection is narrow on purpose — an advance between two matched same-group children is unambiguous, whereas the wider "count advances against a screen budget" alternative false-positives on multi-visit Deliver smokes, and #858 is exactly what a careless false positive costs.
4. **`brief-label-drift`** (sanity-probe) — `tapOn:text:"X"` matching brief naming patterns (`^[LFM]\d+ — `, `^Stage \d+ — `) that Nova rewrites during autobuild.

Plus a whole-palette CI gate (`test/mcp/mobile/static-palette-health.test.ts`) that asserts every file in `mcp/mobile/recipes/static/` parses, declares `appId:`, passes lint, and resolves every `${SELECTOR:...}` ref against the active selector map.

Plus the atlas-drift harvester (`scripts/probe-atlas-drift.ts` + `lib/atlas-drift.ts`) — read-only — harvesting selector-drift signal from accumulated `runRecipeWithDumps` XMLs.

## Where the principle still has slack

When a new mobile failure mode surfaces in Phase 6, ask first: "is this deterministic from the recipe text + the live Nova/Connect data?" If yes, the fix belongs in `recipe-lint.ts` or `recipe-sanity-probe.ts`, not in a tighter SKILL.md paragraph. Today's known candidates that still ship to Phase 6:

- **Recipe provenance staleness** — generated journey recipes on Drive don't carry `ace_version` / `selector_map_sha`, so a Phase 6 run can dispatch a recipe written against an older selector map. Class-level finding #1 in `2026-05-14-phase6-validation-arc.md`.

## Tooling trap to remember

`scripts/dump-atom-schemas.ts` is string-aware but comment-unaware. A bare `'` in a JS line comment inside any `mcp/*-server.ts` (e.g. `// Maestro's parser`) starts a phantom string that the parser walks through, silently dropping every `server.tool(...)` after it from `docs/atom-schemas.md`. Symptom: the staleness gate fails and the catalog is missing atoms from one server. Workaround: rephrase the comment. Structural fix (teach the parser about `//` + `/* */`) deferred.
