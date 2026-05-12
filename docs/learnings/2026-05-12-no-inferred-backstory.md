# No Inferred Backstory in Agent Procedure Docs

**Date**: 2026-05-12
**Status**: Active heuristic — applies to all `agents/*.md` procedure docs, `mcp/*/selectors/*.yaml`, and any other agent-read reference that asserts external-system behavior.

## The class of bug

Agent procedure docs accumulate sentences of the form:

> "Connect's `/opportunity/init/` *now* tolerates these wrappers (post-2026-04
> server fix), so Phase 3 succeeds."

A one-time live observation gets paraphrased into a load-bearing background
claim with no citation. Weeks later, a new agent reads the doc, anchors on the
claim, and chases wrong hypotheses when the next regression happens. The
"tolerated" behavior was never verified end-to-end against the upstream code
— it was inferred from "Phase 3 succeeded a few times." Confirmation bias
freezes the wrong causal story into the doc.

This is structurally similar to MCP-vs-skill-doc drift
(`docs/learnings/2026-04-28-mcp-vs-skill-doc-drift.md`) — a high-trust local
doc disagreeing with the running code — but the failure mode is different:
drift docs are *wrong about a schema*; inferred-backstory docs are *wrong
about why something works*.

## The two instances that motivated this heuristic

| Symptom | Inferred claim | Real cause | Cost | Correction |
|---|---|---|---|---|
| turmeric run `20260511-2053` Phase 3 — 5× HTTP 500 on `connect_create_opportunity` | `agents/commcare-setup.md` background asserted "Connect *now* tolerates Nova's in-form `<assessment xmlns="…connect…">` wrappers post-2026-04 server fix" (introduced commit `6967df5`) | `short_description` 50-char varchar trap — serializer says 255, model says 50, Postgres `DataError` bubbles as HTTP 500. Nothing to do with wrappers. Prior runs survived because their headlines happened to be ≤50 chars. | ~80 min of wrong-hypothesis retries | PR #246 / commit `e5aceb1` — replaced the claim with bisect-cited provenance + `docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md` |
| Connect 2.62.0 `btn_start` "silent FLW-client noop" | `mcp/mobile/selectors/connect-2.62.0.yaml` carried a 2026-04-30 inferred diagnosis that the tap "silently no-ops on the FLW client" | Server-side: uncaught `CommCareHQAPIException` in `commcare-connect/users/views.py:107` `start_learn_app` returns HTTP 500 with no body. Filed as CI-660. Client correctly swallows the failed response — looked like a noop. | Weeks of mis-attributed Phase 5 blockers | PR #249 / commit `caba0b8` — selector retained, diagnosis explicitly REFUTED with logcat evidence + Jira link |

Both claims looked plausible. Both were written from a single live
observation. Both became load-bearing because nothing in the doc told a
future reader "this was a guess."

## The heuristic

> Any claim of the form "[external system] now tolerates / handles / accepts /
> silently fails on [X]" in an agent doc or selector map MUST cite ONE of:
>
> 1. A **probe artifact** — path to a `scripts/probe-*.ts`, a test file, or
>    a recorded bisect transcript that demonstrates the behavior.
> 2. An **upstream PR or commit hash** — link to the commcare-connect /
>    commcare-hq / nova / labs commit that introduced or fixed the behavior.
> 3. A **learning-doc post-mortem** — `docs/learnings/<date>-*.md` with bisect
>    evidence, ideally with a deterministic A/B reproduction.
>
> If no citation can be added, the claim should be **removed**, not retained.
> Inferred-backstory is worse than silence — it produces false anchoring for
> the next debugging session.

### Example — bad → good

Bad (the `commcare-setup.md` Step 2.8 background, pre-PR-#246):

> "Connect's `/opportunity/init/` now tolerates these wrappers (post-2026-04
> server fix), so Phase 3 succeeds."

Good (post-PR-#246):

> "Verified against commcare-connect main on 2026-05-12: the parser is pure
> in-memory iteration with no DB queries, HTTP fetches, or locks per-block.
> An earlier comment claimed 'Connect *now* tolerates these (post-2026-04
> server fix)' — that was wrong about provenance. There was no Connect
> server fix; prior Phase 3 successes happened because the payload's
> `short_description` happened to be ≤ 50 chars (the actual DB-enforced cap).
> See `docs/learnings/2026-05-12-connect-opp-short-description-50-char-trap.md`."

The good version is longer because it carries its receipts. That's the
trade. Doc bytes are cheap; wrong anchoring is expensive.

## Application

When writing or editing an agent procedure doc or selector map:

1. Before asserting external-system behavior in prose, ask: "what would
   convince a skeptical future reader this is true?" If the answer is "I saw
   it work once," do not write the assertion as a fact.
2. If the assertion is load-bearing for the agent's decisions, build the
   citation first (probe script, bisect transcript, or upstream link) and
   reference it inline.
3. When you discover an old inferred claim is wrong, do not silently delete
   it — leave a short retraction in place (as PR #246 and PR #249 both did)
   so the next agent sees the previous mis-diagnosis and doesn't re-derive
   it from scratch.
4. Date-stamp claims with provenance: "Verified against commcare-connect
   main on <date>" or "Refuted by logcat 2026-05-12, see CI-660" beats
   "post-2026-04 server fix."

## The sweep

A one-time pass over `agents/*.md` and `mcp/mobile/selectors/*.yaml` for
patterns matching `tolerat|silently (accept|handle|tolerat)|server-side fix|
post-2026|since 202\d`:

| Hit | Status |
|---|---|
| `agents/commcare-setup.md:300–322` — Step 2.8 "wrappers benign for Phase 3 sync" | Already cited (bisect 2026-05-12, code paths, learning-doc link) — landed in PR #246. Exemplar. |
| `mcp/mobile/selectors/connect-2.62.0.yaml:147` — `btn_start` purpose block | Already cited (Connect 2.62.0, ACE_Pixel_API_34, turmeric opp date, CI-660 Jira link, source file path) — landed in PR #249. Exemplar. |
| Version-anchored claims in `connect-setup.md`, `ace-orchestrator.md`, `qa-and-training.md` ("As of 0.8.1 …", "since 0.10.65 …") | All cite the ACE version that introduced the behavior. In-scope; out-of-bug-class. |

**Zero uncited inferred-backstory claims remain** in the swept files. The
class has been actively pruned by the two motivating PRs; this learning is
the procedural backstop so it stays that way.

## Generalization

This is the fourth instance of CLAUDE.md's "class-level preventers >
instance-level fixes" pattern, alongside the `.env-drift` doctor check
(0.5.4), the `ocs_shared_collection_team` HTTP probe (0.7.1), and
MCP-vs-skill-doc drift (0.9.4). The boundary between two systems is where
silent disagreement hides; closing it at the boundary means asserting the
boundary's behavior only with receipts. No receipts, no assertion.
