# Phase 6 validation arc — durable lessons + one still-open class

**Date:** 2026-05-14
**Status:** Mostly resolved. One class-level finding (recipe provenance / stale-artifact pre-flight gate) remains unsolved and is the highest-leverage open item.

A five-retry Phase 6 debug arc surfaced 5 distinct bugs in one day, each fixed in its own PR. The specific bugs are historical (atlas-walk misunderstandings on Learn-side surfaces against turmeric, ACE v0.13.208 → v0.13.220). The durable lessons are below.

## Durable lessons

### 1. The atlas is the contract; recipes must match it

Three of the five bugs were "recipe held a stale understanding of a surface." Each time, the live UI (atlas) was correct and the recipe out of sync. The structural fix landed: `skills/app-test-cases/SKILL.md` lists the atlas as an authoritative input. Journey-recipe authoring reads atlas first, not LLM recall.

### 2. MCP boundary auto-resolution > per-caller discipline

`mobile_run_recipe` previously required callers to pre-resolve `${SELECTOR:...}` placeholders + inject `${ACE_E2E_*}` env vars. Every caller had to remember to do this; every caller occasionally forgot. The fix: `MobileClient.runRecipe` does both auto-resolutions unconditionally. Caller-provided values still win on conflict (auto-injection only fills keys the caller didn't set). Class-level preventer at the right boundary — matches `CLAUDE.md § Conventions` ("Class-level preventers > instance-level fixes").

### 3. One-fix-per-retry is the cadence

Five fixes in series, each independently testable, none coupled. Coupling would have made the debug loop quadratic. Resist the urge to bundle "while I'm in here" fixes — they couple failure modes and you can't tell which fix actually moved the needle.

### 4. Deterministic-bootstrap design is correct

The snapshot-load fast-path's failure modes (token expiry, wall-clock drift, server-side cleanup since capture) were not worth the ~20s saved per dispatch. See `2026-05-14-demo-user-no-otp.md` for the underlying cost analysis (fresh demo-user registration is ~20s, not 3–5 min).

## Open class — recipe provenance (highest-leverage unsolved item)

**Class:** When a code change renames a logical selector or restructures a recipe pattern, every previously-generated journey recipe on Drive is silently stale. Retry #3 lost a full Phase 6 dispatch to a mechanical rename that needed Drive regeneration.

**Structural fix (not yet shipped):** when `app-test-cases` writes journey recipes, embed `ace_version` and `selector_map_sha` in the recipe header. A pre-flight gate at the start of Phase 6 (in `mobile_run_recipe` or just before) refuses to run a recipe whose `selector_map_sha` doesn't match the current map, and offers regenerate.

This is the single highest-leverage unsolved item from this arc. It would eliminate an entire class of "Phase 6 fails for a reason that's actually a Phase 3 staleness problem."
