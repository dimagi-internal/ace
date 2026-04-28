# Learning: MCP-vs-skill-doc drift

**Date**: 2026-04-28
**Context**: 0.9.4 — `connect-opp-setup` SKILL.md described the `location` verification flag as a meters threshold (e.g. "10m"). The actual `connect_set_verification_flags` MCP atom takes a boolean toggle; the threshold itself is currently un-settable via the MCP. A reader of the skill couldn't have produced a working call.
**Status**: Active — class-level pattern, not a single bug.

## Problem

ACE skills frequently document the *fields they expect to pass to MCP atoms* inline in the skill body (in tables, code blocks, or prose). When the underlying atom's schema changes — or, more commonly, when the inline doc was paraphrased rather than copied from the atom's tool description — the skill drifts from the MCP's actual contract.

The 0.9.4 case: `skills/connect-opp-setup/SKILL.md` said `location` was a per-PDD distance-threshold value mapping to "10m"-style settings. The atom's Zod schema accepts only a boolean. An LLM reading the skill would attempt to pass a number, the atom would reject the call, and the skill's authoring step would silently fail or fall back to a workaround that no longer exists (Phase 3 went HITL-free in 0.8.1).

This is structurally the same as a stale README — a high-trust local doc disagreeing with the running code. The skill is the loud voice; the MCP is the source of truth.

## Root cause

Inline schema documentation in skills is an undeclared duplicate of the atom's tool description. There's no automated check that the two agree, and the natural editing pattern (write the skill once, edit the atom later) creates drift in one direction.

Two contributing factors:
1. **Workaround-removal exposure.** When 0.8.1 removed `## Current Workaround` blocks from the five blocked Connect skills, the inline schema docs that *replaced* the workarounds got more load-bearing — they became the only operational guidance. Anything wrong in them now shows up live.
2. **Atom schemas evolve faster than the skills that consume them.** `connect_set_verification_flags` was probed live across 0.8.0 and 0.8.1; the skill was written from PDD-side intent ("location distance verification") rather than atom-side reality ("boolean toggle, threshold not yet settable").

## Fix / Key takeaway

**Class-level preventer (preferred):** when a skill needs to document an atom's argument shape, link to the atom's MCP tool description, don't paraphrase. Best form is a one-line reference + the atom name; agents can read the live schema via the tool registration. Second-best is a verbatim copy with a comment marker (`<!-- mirror of ocs_set_chatbot_pipeline schema -->`) so future edits know what to keep in sync.

**Instance-level discipline:** when changing an atom's signature, `grep -l "<atom_name>" skills/` and update each hit. When writing inline schema in a skill, immediately read the atom's tool description and verify your phrasing against it.

**Doctor extension (future):** an automated check could parse atom Zod schemas and grep skills for argument-name references, flagging mismatches. Out of scope for this learning, but the right shape if drift recurs.

This is the third instance of a pattern named in CLAUDE.md's "Class-level preventers > instance-level fixes" convention — alongside the `.env-drift` doctor check (0.5.4) and the `ocs_shared_collection_team` HTTP probe (0.7.1). All three say the same thing: the boundary between two systems is where silent disagreement hides; close it at the boundary.
