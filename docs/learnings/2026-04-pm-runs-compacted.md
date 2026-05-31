# Learning: April 2026 PM cycles — compacted

**Date**: 2026-05-22 (compaction)
**Context**: 10 PM scout cycle logs from April 8 → April 29, 2026, distilled into the durable signals that shaped subsequent platform behavior. Originals deleted in the same change; git history preserves them under `.claude/pm/runs/2026-04-*.md`.
**Status**: Resolved — every cycle's findings either shipped or were re-surfaced in a later durable learning.

## Why compact

The early-April logs predate the 0.13.x rewrites. Their lens-by-lens cadence narrates *how* the platform reached its current shape. None of the per-cycle Do-It / Backlog / Skipped sections are read by any agent or skill today; the parts worth keeping are the **cross-session patterns** and the **decisions that hardened into conventions**.

Per `CLAUDE.md § Improvement cycles & canopy` the convention is to copy the structure of the most recent run when writing a new log. That convention is intact; only the historical pile is being cleared.

## Cross-cycle patterns (what these 10 sessions taught the project)

### 1. Archetypes are first-class (Apr 8 → cycle-defining)

The Apr 8 focus-group-framework cycle found that every skill was hard-coded to one delivery archetype: "one FLW visit = one photo + GPS + form." The variation-points-per-skill approach (not fork-the-framework) became the canonical fix. This is the seed of CLAUDE.md's *Archetypes are first-class* Convention. Subsequent FGD work (PR series May 2026) validated the model end-to-end.

### 2. Real run > spec review (recurring across Apr 19, Apr 28, throughout)

Every cycle that exercised the live skill chain against real content surfaced bugs invisible to spec review. The Apr 28 turmeric-dogfood cycle made it explicit: "real run > spec review" — same observation logged in the Apr 19 cycle. **This is the load-bearing reason `/ace:qa-deep`, the per-skill `-eval` chain, and live MCP integration tests exist.** Dogfooding against real PDDs surfaced the OCS `{collection_index_summaries}` cross-field rule, the `experiment_id` regression class, the partial-save bug, the wrong-team collection class, and the env-drift class — none of which were predictable from the spec.

### 3. Class-level preventers > instance-level fixes (Apr 19 → Apr 20)

Each cycle that landed a fix that "caught only the case in front of us" produced another instance of the same class next cycle. The Apr 20 collection-clone-and-mcp-preflight cycle ended by adding MCP-layer defenses against the silent-block class (not just the one collection). The Apr 20 env-drift cycle added a doctor probe for `.env.tpl` drift (not just the one missing key). This pattern is now the *Class-level preventers* Convention in CLAUDE.md.

### 4. Doctor probes are how invariants survive (Apr 20)

The Apr 20 morning env-drift cycle proved the failure mode: `.env.tpl` adds keys, installed `.env` doesn't auto-update, doctor reported COMPLETE on 3-of-16 keys. The fix shape that stuck: doctor probes a live HTTP call per MCP, names the exact remediation per failure. The 0.7.1 `ocs_shared_collection_team` probe (50ms HTTP request that turns "configured" into "configured correctly") was the canonical follow-on.

### 5. Operator-can-fix vs operator-can't-fix (Apr 29 → eval architecture)

Three rubrics (connect-program-setup-eval, app-summary-eval, ocs-chatbot-eval) independently surfaced the same noise pattern: penalizing skills for upstream platform constraints the operator can't address. The fix shape that landed in 0.10.6 → 0.10.10: introduce a category that **describes** the constraint instead of **deducting** for it. This is now the structural shape of every `-eval` rubric. See `docs/eval-calibration-learnings.md` for the full methodology.

### 6. Stale metadata is more dangerous than missing metadata (Apr 20)

The Apr 20 collection-clone cycle was anchored on the wrong premise (collection 718 didn't exist on connect-ace) because `~/.ace/connect-ocs-bot.json` was stale by 11 days. Reading that file as ground truth burned a half-day chasing a non-existent team-infrastructure problem. This learning hardened into the CLAUDE.md Gotcha: **"Drive metadata files (`~/.ace/*.json`) are hypotheses, not truths. Stale snapshots have anchored multi-day investigations down wrong paths. Re-probe live state before acting on metadata older than ~7 days."**

## Findings that shipped (high-traffic items)

| Source cycle | Finding | Where it landed |
|---|---|---|
| Apr 8 | Archetype as PDD field with skill-level branches | CLAUDE.md Convention + `Archetype:` PDD frontmatter |
| Apr 15 | `/ace:setup`, `/ace:doctor`, `/ace:update` first-run polish | Stable since 0.3.x |
| Apr 16 | State.yaml lifecycle / fixture drift catches | `lib/artifact-manifest.ts` + `test/fixtures/ACE-Test-*` |
| Apr 17 | Per-opp ownership in state schema | `opp.yaml` / `run_state.yaml` split |
| Apr 19 | qa+eval two-axis pattern + opp-eval umbrella | CLAUDE.md Convention + per-skill `-eval` siblings |
| Apr 20 (am) | Cross-team collection scoping | `ocs_shared_collection_team` doctor probe |
| Apr 20 (pm-1) | `.env.tpl` drift detection | doctor `[Auth liveness]` block |
| Apr 20 (pm-2) | Dead `.env.tpl` keys | grep-based unused-key audit, removed 4 dead vars |
| Apr 28 | OCS `{collection_index_summaries}` cross-field rule | `assertCollectionPromptInvariant` + `scripts/probe-n1-cross-test.ts` |
| Apr 29 | Operator-can-fix vs constraint categories | Every `-eval` rubric since 0.10.6 |

## What did NOT carry forward (dropped during compaction)

The early cycles each carried a P1-P7 Backlog block. Most rolled forward across cycles and either shipped (see table above) or got recharacterized in later work. A few died on the vine and aren't worth restoring:

- **"fgd-synthesis" skill** (recurring P6/P7 backlog) — superseded by the May 2026 FGD archetype refactor where the OCS chatbot became the primary facilitator surface, no separate synthesis skill needed (see `project_fgd_archetype_complete` memory).
- **Per-cycle "Self-improvement (canopy-skills meta-PRs)" sections** — these were prompts/cadence tweaks for the canopy PM-scout skill itself, not ACE. Lived their useful life in the cycle they shipped.
- **Per-cycle "Confidence on validation"** — meta-prompt-engineering notes that no longer apply.

## How to apply

If you find yourself wondering "why is X the way it is?" about a CLAUDE.md Convention or Gotcha, the original cycle log probably explains the forcing function. Git-blame the Convention or Gotcha and trace back to the PR; from there, the contemporary PM run log (now in git history) gives the full forensic narrative. The convention itself is the durable artifact — this learning is the index into the archaeology.
