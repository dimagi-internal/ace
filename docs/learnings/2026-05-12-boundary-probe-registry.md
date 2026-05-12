# Boundary Probe Registry

**Date:** 2026-05-12
**Status:** Living doc — append rows as probes ship; move from Pending → Shipped as they land.

## What this is

ACE has a pattern called **boundary probes**: load-bearing client-side pre-flight checks that convert opaque upstream failures (30s hangs, HTTP 500 with no body, silent dedup, stored-vs-sent divergence, "user storage quota exceeded" red-herrings) into actionable Zod/structural errors *before* the network round-trip. Each probe targets a class-of-bug, not a single instance — once shipped, every future occurrence of the same shape fails fast with a remediation hint in the error message. The canonical example is the 0.7.1 `ocs_shared_collection_team` doctor probe (cited in `CLAUDE.md § Gotchas`): a 50ms HTTP request that turns "configured" into "configured correctly." This registry catalogues the pattern so the convention "Class-level preventers > instance-level fixes" (`CLAUDE.md § Conventions`, last paragraph) is enumerable rather than tribal.

## Shipped probes

| Probe | Location | Class of failure caught | Origin / learning |
|---|---|---|---|
| `assertParentOnSharedDrive` | `mcp/google-drive-server.ts:172` | Drive `parentFolderId` on My Drive instead of a Shared Drive — silent fallback to SA's My Drive root, every subsequent write fails with misleading "user storage quota exceeded." | `CLAUDE.md § Gotchas` ("Drive `parentFolderId` is required and must live on a Shared Drive"). |
| `assertCollectionPromptInvariant` | `mcp/ocs/backends/playwright.ts:102` | OCS `{collection_index_summaries}` cross-field rule: required iff `collection_index_ids.length >= 2`, must be absent for single-collection clones (the canonical per-opp case). | Reproducer: `scripts/probe-n1-cross-test.ts`. `CLAUDE.md § Gotchas` ("OCS `{collection_index_summaries}` cross-field rule"). |
| `ocs_shared_collection_team` doctor probe | `bin/ace-doctor:808` | `OCS_SHARED_COLLECTION_ID` resolves to a collection on a *different* team than `OCS_TEAM_SLUG` — cloned per-opp bots fail to attach RAG, or attach a different team's collection. 50ms HTTP, WARN not FAIL. | 0.7.1 — the canonical class-level preventer. `CLAUDE.md § Conventions`. |
| `short_description.max(50)` Zod cap | `mcp/connect-server.ts:218,276` | Connect `Opportunity.short_description` serializer (`max_length=255`) vs model (`max_length=50`) mismatch. Over-cap payloads produced HTTP 500 with no body from `program/api/views.py:102` (Postgres `DataError` falls through the narrow except clause). | `docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md` + commit `e5aceb1` (0.13.177). |
| `app-deploy` XML-escape lint | `skills/app-deploy/SKILL.md:61` (Step 2.5) | Literal `<`/`>`/`&`/`"` in form label/option/hint text. Nova's `validate_app` reports OK (operates on the structured blueprint), but CCHQ's `make_build` parser rejects the emitted XForm. | `docs/issues/nova-validate-app-misses-xml-escapes.md`; `docs/learnings/2026-04-29-nova-connect-marker-bugs.md § Bug 4`. |
| `app-release` CCZ projection check | `skills/app-release/SKILL.md:222` (Step 6) | `commcare_download_ccz.projected_connect_state.collision_count` MUST be `0` AND per-type record counts > 0. Catches (a) Nova `compile_app` slug collisions (N forms emit same `<learn:deliver id>`, Connect's sync silently dedupes, non-first forms unpaid) and (b) missing Connect markers in CCZ (Nova autobuild's vague-spec skip). | `docs/learnings/2026-04-29-nova-connect-marker-bugs.md`. |
| `cloud_emu` doctor probe | `bin/ace-doctor:1480` | ace-mobile cloud backend: 401/403/404/network on `GET $ACE_WEB_BASE/api/mobile/diagnose`. Surfaces PAT-invalid, ace-web-too-old, VPN/DNS, and emulator-unhealthy distinctly, each with a concrete fix command. | PR #248 (commit `0e5b4ad`, 0.13.178). |
| `mobile_probe_maestro_driver` | `mcp/mobile-server.ts:143` (atom) → `mcp/mobile/client.ts:169` (impl); auto-invoked by `mobile_ensure_avd_running` | Maestro driver gRPC health check + auto-heal. Catches the "AVD up, Maestro driver wedged" case where every recipe times out without a recipe-side error. | PR #233 — commit `8b6e4f0` ("auto-heal Maestro driver in mobile_ensure_avd_running"). |

## Pending probes

Class-level preventers we know are needed but haven't shipped:

| Probe | Class of failure to catch | Source |
|---|---|---|
| **CI-660 pre-flight** — call `create_hq_user_and_link` directly via the HQ API before the Connect `start_learn_app` POST | Connect's `users/views.py:107` doesn't wrap `create_hq_user_and_link` in try/except, so any failure inside that helper surfaces as opaque HTTP 500 on `start_learn_app`. Identical class to the `short_description` 50-char trap: server has a deterministic narrow `except` and the unhandled exception type 500s with no body. ACE-side shim should pre-resolve HQ-user/link state before the Connect call. | Discovered in PR #249 (commit `8677225`). |
| **Selector-map currency probe** — `bin/ace-doctor --preflight` cross-checks recipes in `mcp/mobile/recipes/static/` vs `mcp/mobile/selectors/<APK>.yaml` for the deployed APK version | Recipes go stale when Connect APK ships UI changes; current symptom is silent `btn_start` no-op at recipe runtime. Same class as `cloud_emu` but for selector-map vs deployed-APK skew. | Implied by `CLAUDE.md` ("`REPLACE_*` selectors that must be filled via `maestro studio` against the Connect APK before live runs") + the 2026-04-30 `btn_start` noop refuted in commit `caba0b8`. |
| **`mobile_resolve_selectors` at Phase 2 authoring gate** — shift-left of the Phase 5 selector-resolution gate into `app-test-cases` | Same selector-currency class as above but a *producer-side* preventer (catch at authoring time, not at runtime). Currently the only check is the Phase 5 recipe-execution gate; an authoring-gate probe would fail closed before any mobile run. | Sibling of selector-map currency; surfaces when authoring touches a recipe whose selector map hasn't been re-resolved for the current APK. |
| **Generalized serializer-vs-model length probe** — pattern-match across commcare-connect's `CharField` definitions, surface mismatches at MCP startup | The `short_description` 50-char trap is one instance; any other field where DRF serializer `max_length` exceeds the model `max_length` is the same bug class. A static scan over commcare-connect's `models.py` + `serializers.py` would surface all candidates as Zod caps. | Generalization of `docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md § Generalization`. |

## Pattern characteristics

What makes a good boundary probe — synthesized from the cases above:

- **~50ms cost order.** Cheap enough to run on every call, or unconditionally at session start. Doctor probes batch into a single dashboard; MCP-atom-level probes run inline in Zod validation.
- **Catches a class-of-bug, not a single instance.** Pattern-matches the *failure shape* (length-cap mismatch, parent-folder type mismatch, team-scope mismatch). The next variant of the same shape gets caught for free.
- **Names the remediation in the error.** Failing field, the right value, an upstream-issue link, or the exact remediation command. Goal: a future operator reads the error and knows the fix without bisecting.
- **Caught at the right boundary.** MCP atom for input-shape invariants; doctor probe for environment/auth liveness; producer skill (e.g., `app-deploy` Step 2.5, `app-release` Step 6) for authoring-time invariants the MCP can't enforce because the data was assembled by an LLM, not a Zod schema.
- **Idempotent + safe to retry.** A probe fails closed and never mutates. Re-running is free; a probe is never the proximate cause of state corruption.

## When to add a row

Every time a `docs/learnings/<date>-*.md` post-mortem identifies a "class-level preventer would have caught this" follow-up, append a row to the **Pending probes** table here with a pointer to the learning doc. When the preventer ships, move the row to **Shipped probes**, update the location column with the concrete file path + line, and link the commit/PR. This makes recurrence visible: if a class of bug keeps showing up in post-mortems but its preventer never gets a `mcp/`-rooted location, that's a signal the preventer is overdue.
