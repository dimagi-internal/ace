# Video Narrative + Workbench Substrate — Design Spec

**Date:** 2026-06-07
**Status:** Approved direction, plans in progress
**Spans:** `ace-web` (frontend + apps/videos), `ace` plugin (video skills), `canopy` (DDD substrate), `canopy-web` (review package)

---

## 1. North star

The ACE video-creation system and canopy's `ddd` (demo-driven-development) system are **the same machine**: author a narrative → decompose it into typed parts → run it → eval each part → publish a reviewable package. DDD has pushed three of those further than the video work, and the video work should adopt them — **reusing canopy's substrate where it's generic, keeping ACE/Connect specifics in ACE.**

The three things DDD does that the video pipeline is missing:

1. **The narrative as a first-class, structured, judgeable object** — not implicit in beats + prose.
2. **Reasoning about which parts exist vs. are missing** — evidence classification (`documented | implemented | assumed`) + typed Gaps (`RESEARCH | CAPABILITY | DECISION`).
3. **A reviewable run-package UI that makes an AI artifact's uncertainty legible.**

Lineage note: DDD was itself built by examining the ACE video work; canopy-web's review editor's own comments say it mirrors ace-web's `videos/types.ts`. This is bidirectional cross-pollination — which strengthens the case for a shared substrate, carefully bounded.

## 2. Architecture: three layers

```
ORCHESTRATORS (thin; methodology/domain)
  canopy:ddd  (product demos)        ACE: partnership-video / connect-explainer (Connect marketing videos)
        │                                       │
        └──────────── both consume ─────────────┘
                          ▼
SUBSTRATE (canopy, generic)
  • narrative object + mechanical decomposition (narrative → parts)
  • evidence model (documented|implemented|assumed) + typed Gaps (RESEARCH|CAPABILITY|DECISION)
  • Verdict + QA-gates-Eval + visual-judge
  • run-package + hero-artifact (canopy-web ReviewRequest / Walkthrough)
                          │
            drive a pluggable RENDERER
                          ▼
RENDERERS (siblings)
  canopy:walkthrough (web screen-record)   ace-web:connect-videos (Remotion clip composite)
  [canopy]                                  [ace-web — stays ACE]
```

## 3. What canopy already separated (the audit that shaped this)

| Layer | State | Where |
|---|---|---|
| Render capability (`canopy:walkthrough`) | ✅ clean standalone; DDD reuses by spec-compatibility | `canopy plugins/canopy/skills/walkthrough` |
| Eval harness (`visual-judge` + `Verdict`) | ✅ extracted, rubric-driven, namespace-neutral; **ACE Phase 6 already calls visual-judge** | `Verdict` in `scripts/ddd/schemas/models.py` |
| Web run-package + hero artifact (`ReviewRequest` + `Walkthrough`) | ✅ storage fully generic (opaque `request_json`); `Walkthrough` already `kind=video` | `canopy-web apps/reviews`, `apps/walkthroughs` |
| Narrative / evidence-gap / decomposition / converge-loop | ❌ **welded** inside `scripts.ddd`; no neutral `lib/` | `canopy scripts/ddd/{schemas/models.py, validate.py, narrative_coherence.py, run_pipeline.py}` |

**Load-bearing fact:** canopy has **no clip-based (Remotion) renderer** — its only "video" is Playwright screen-recording → mp4. ACE's `connect-videos` Remotion engine is a *different renderer* and **stays ACE-side**. The two renderers are siblings that both plug into the substrate, exactly as `walkthrough` does today.

## 4. What goes where (the "generic → canopy, specific → ACE" rule applied)

**To canopy (generic substrate):**
- The narrative object, mechanical decomposition contract, evidence/gap model, and pure validators (falsifiability/banned-phrase, provenance-resolution, outcome-leakage, actionability cold-derive) — **extracted out of `scripts.ddd`** into a neutral module.
- The `Verdict` schema + QA-gates-Eval contract (lift out of `scripts.ddd.schemas`).
- `canopy-web` review-package generalization (so a video run renders as a package).

**Stays ACE / ace-web (specific):**
- The Remotion `connect-videos` renderer + Connect templates/brand.
- Partnership research / Connect-fit grounding, prospect-branding overlay.
- The video review **UI itself** (in ace-web), built on a shared `WorkbenchLayout` kit.

## 4b. Cross-language: shared contract, not shared code

Both ecosystems are polyglot (Python backends + DDD engine; TS frontends, MCP, and the Remotion renderer; Markdown skills as glue). The substrate is therefore shared as a **canonical contract**, not a shared import:

- **Canonical home = Python/pydantic in canopy** (`scripts/ddd` → `scripts/narrative`). pydantic dumps **JSON Schema for free** (canopy already does this via `scripts/ddd/regen_json_schemas.py` → `scripts.ddd.validate.dump_json_schemas`, committed + pre-commit-gated). That JSON Schema is the single source of truth.
- **Python consumers import it** — canopy DDD, canopy-web Django, ace-web Django (`apps/videos`).
- **TypeScript consumers generate types from the JSON Schema** — ace-web frontend already runs `openapi-typescript` (`gen:api`). `lib/verdict-schema.ts` becomes **generated**, not hand-maintained (kills the existing drift).
- **Claude skill orchestrators invoke the Python validators via CLI** — exactly how `ddd-*` skills already do (`uv run python -m scripts.ddd.spec_qa …`) and how ACE already calls `canopy:visual-judge`. "Orchestrate on top, like walkthrough." No Python imported into TS.
- **Only exception:** a validator that must run *in-process inside the Remotion/TS render pipeline* gets a TS implementation tested against **shared fixtures** generated from the Python side, so the two can't silently diverge.

Best-tool-per-layer holds: Python owns the schema + validators; TS surfaces get generated types; Markdown skills glue via CLI + capability invocation.

## 5. Locked decisions

1. **Refactor canopy** to extract the narrative/evidence-gap/decomposition/Verdict substrate out of `scripts.ddd` into a neutral module + a thin `canopy:narrative` capability skill (mirrors how `walkthrough` is a capability + `scripts/walkthrough/`). DDD becomes an orchestrator on top — re-points imports, behavior unchanged, tests stay green.
2. **Renderers stay siblings.** `connect-videos` stays in ace-web as ACE's renderer; do **not** move the Remotion engine into canopy. Formalize a renderer contract only once two renderers consume the substrate (later stage).
3. **The video review UI lives in ace-web**, built on a reusable **`WorkbenchLayout`** kit.
4. **`WorkbenchLayout` is a generic ace-web library** — left rail / center pane / right rail, every pane independently collapsible and slide-in/out configurable. It is **proven by refactoring the existing `OppWorkbenchPage` onto it first** (a real second consumer already exists — the opp workbench and the video editor are divergent copies of this pattern today). Build it props-in / dependency-clean so a future cross-repo extraction is cheap.
5. **Cross-repo UI sharing is a later, separate question.** Both apps already have left-rail shells (`AppLayout` in canopy-web, the workbench in ace-web). Converging them across two SPAs has real infra cost and earns its keep only once the ace-web kit is clean and a concrete canopy-web migration is on the table. The immediate, high-value consolidation is **intra-ace-web** (opp workbench ↔ video).

## 6. Staged plan (each stage = its own implementation plan)

- **Stage 1 — `WorkbenchLayout` kit (ace-web).** Extract a generic 3-pane (left/center/right, each collapsible + slide-configurable) layout from `OppWorkbenchPage`; re-home the opp workbench onto it (no regression); set up the slots video review will use. **Lead plan — `docs/superpowers/plans/2026-06-07-workbench-layout-kit.md`. Self-contained, no canopy dependency.**
- **Stage 2 — Narrative substrate extraction (canopy).** Lift `WhyBrief` / evidence / `Gap` / decomposition / provenance / `Verdict` + validators out of `scripts.ddd` into a neutral module + `canopy:narrative` capability; DDD re-points imports; canopy tests stay green. **Plan 2 — to be written. Self-contained refactor.**
- **Stage 3 — ACE video adopts the narrative substrate.** Promote `partnership-narratives` to a first-class structured narrative the renderer + UI consume; add the evidence/gap layer (generalize "no inferred backstory" → classified evidence + typed gaps); adopt narrative-first mechanical decomposition. Depends on Stage 2.
- **Stage 4 — ACE video adopts the eval substrate.** Per-beat `visual-judge` on rendered frames; narrative-coherence/outcome-leakage + actionability cold-derive on video narration; a narrative-review human gate before render. Depends on Stage 2.
- **Stage 5 — Reviewable video run-package.** Build the video review surface in ace-web on the Stage 1 `WorkbenchLayout` (left rail = narrative + runs; center = beat/scene detail; right = inspector). Generalize canopy-web's `ReviewRequest` dashboard derivation if/when a shared package surface is wanted. Depends on Stages 1 + 3.
- **Stage 6 (later) — Formalize the renderer contract** + evaluate cross-repo extraction of `WorkbenchLayout` into a shared package, gated on a concrete canopy-web need.

## 7. Reusable primitives inventory (what Stage 1's kit contains)

Lifted from the battle-tested `OppWorkbenchPage`; domain content plugs into slots.

- **`WorkbenchLayout`** — header slot + N panes (left/center/right), each collapsible with the `w-[…]`/`shrink-0`/`border-l`/collapse-to-icon-strip mechanics already in `OppWorkbenchPage`, plus slide-in/out config.
- **`usePaneCollapsed(storageKey, default)`** — generalized from `useChatPaneCollapsed` (localStorage-persisted collapse).
- **Run picker / runs strip** — generic (`RunSelector` is already just runs).
- **Left "entity rail" scaffold** — today `SkillList`; for video the narrative→beats list.
- **Detail-pane + inspector-rail scaffolds, `EmptyState`, `ViewSwitcher`.**
- **Edit-op engine + atoms** (`ScoreBadge` / `StatusBadge` / `PersonaChip`) — ace-web `videos/types.ts` and canopy-web `reviewApplyOps.ts` are already divergent copies; strongest dedupe candidate (deferred to Stage 5).

## 8. Risks / watch-items

- **Premature cross-repo packaging.** Mitigation: build `WorkbenchLayout` extraction-ready but keep it in ace-web until a 2nd repo consumer is real (decision §5).
- **DDD rubrics are uncalibrated** ("provisional; calibrate via defect-creator after 3 runs"). When ACE adopts the eval substrate (Stage 4), steal canopy's `walkthrough-defect-creator` calibration harness alongside the rubrics — don't trust absolute thresholds yet.
- **Substrate extraction touching DDD mid-flight.** Mitigation: Stage 2 is a pure refactor with canopy's existing tests as the regression guard; no behavior change.
- **Two ace-web sessions in parallel** (this initiative + the core-video-creation session) both bump ace-web VERSION. Mitigation: separate worktrees/branches; expect version-collision; this initiative touches `frontend/` + (later) `apps/videos` review surface, the other touches `apps/videos` ops + `video-production`.
