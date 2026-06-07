# Canopy Narrative Substrate Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Lift the generic narrative / evidence-gap / eval / review-package schemas out of the DDD-specific `scripts.ddd` namespace into a neutral `scripts/narrative/` package, so the contract is reusable by non-DDD consumers (ACE video, ace-web) and publishable as a canonical JSON Schema — with zero behavior change to DDD (its tests are the regression guard).

**Architecture:** Move the generic pydantic models from `scripts/ddd/schemas/models.py` → `scripts/narrative/models.py`; leave `RunState` (the DDD converge-lifecycle) in DDD. A re-export shim in the old module keeps every existing importer (DDD modules, the walkthrough recorder, tests, and `python -m scripts.ddd.*` skill entry points) working unchanged. Repoint the walkthrough recorder to the neutral module (it should not depend on `ddd`). Emit the narrative JSON Schema to a canonical path that downstream repos consume.

**Tech Stack:** Python 3.11, pydantic v2, uv, pytest. **Repo:** `jjackson/canopy`, branch off `main`. Tests run from repo root: `uv run pytest`.

**Why:** `scripts.ddd.schemas.models` packs the generic substrate (`WhyBrief`, `Evidence`, `SpineItem`, `Gap`, `Persona`, `Feature`, `Scene`, `UnifiedSpec`, `Dimension`, `Verdict`, `Decision`, `NarrationItem`, `ReviewRequest`, the `Action` union + `ACTION_KINDS`) together with the DDD-only `RunState`. `scripts/walkthrough/_lib/recorder.py` already imports the `Action` vocabulary *from ddd* (a renderer depending on a methodology — backwards). Extraction fixes that coupling and makes the contract canonical.

---

## Pre-flight

- [ ] **Step 0: Branch + baseline.** `git checkout main && git pull && git checkout -b feat/narrative-substrate`. Run `uv run pytest` from repo root; **record the pass count** — this is the regression gate for every task below. Run `python scripts/ddd/regen_json_schemas.py` and confirm it's a no-op (schemas already committed).

---

## Task 1: Create `scripts/narrative/` and move the generic models

**Files:**
- Create: `scripts/narrative/__init__.py`, `scripts/narrative/models.py`
- Modify: `scripts/ddd/schemas/models.py` (becomes a re-export shim + keeps `RunState`)

- [ ] **Step 1:** Create `scripts/narrative/__init__.py` (empty) and `scripts/narrative/models.py`. Into `models.py`, **move verbatim** from `scripts/ddd/schemas/models.py` everything EXCEPT the `RunState` class: the module header imports (`from __future__ import annotations`, `from typing import Annotated, Literal, Union`, `from pydantic import BaseModel, ConfigDict, Field`), and the classes/symbols `Evidence, SpineItem, Gap, WhyBrief, Persona, Feature, ACTION_KINDS, _ActionBase, GotoAction, ClickAction, ClickMenuAction, FillAction, SelectAction, TypeAction, PressAction, HoverAction, ScrollToAction, ScrollAction, WaitForAction, HoldAction, DrawAction, Action, Scene, UnifiedSpec, Dimension, Verdict, Decision, NarrationItem, ReviewRequest`. (Verify the exact symbol list against the file — move every top-level definition except `RunState`.)

- [ ] **Step 2:** Rewrite `scripts/ddd/schemas/models.py` as a shim that re-exports the moved symbols and keeps `RunState` (which references `Verdict`):

```python
"""DDD schema module — re-exports the neutral narrative substrate and
keeps the DDD-only RunState. The generic narrative / eval / review models
now live in scripts/narrative/models.py (the canonical contract). This
shim preserves every existing `from scripts.ddd.schemas.models import X`
importer and the `python -m scripts.ddd.*` skill entry points."""
from __future__ import annotations

from scripts.narrative.models import (  # noqa: F401  (re-export)
    Evidence, SpineItem, Gap, WhyBrief, Persona, Feature,
    ACTION_KINDS, Action,
    GotoAction, ClickAction, ClickMenuAction, FillAction, SelectAction,
    TypeAction, PressAction, HoverAction, ScrollToAction, ScrollAction,
    WaitForAction, HoldAction, DrawAction,
    Scene, UnifiedSpec, Dimension, Verdict, Decision, NarrationItem,
    ReviewRequest,
)

# RunState stays DDD-specific (the converge lifecycle); it composes the
# neutral Verdict re-exported above.
<paste the RunState class definition verbatim here, unchanged>
```

(Copy the real `RunState` class body in place of the placeholder line. If `RunState` referenced any helper that moved, it resolves via the re-exports above.)

- [ ] **Step 3:** Run `uv run pytest`. Expected: **same pass count as Step 0** (all importers resolve through the shim). If `tests/ddd/test_schemas.py` asserts a module path, update the assertion to the new location. Fix any import errors before proceeding.

- [ ] **Step 4: Commit.** `git add scripts/narrative scripts/ddd/schemas/models.py && git commit -m "refactor(narrative): extract generic schemas to scripts/narrative; ddd re-exports + keeps RunState"`

---

## Task 2: Decouple the walkthrough recorder from `ddd`

**Files:**
- Modify: `scripts/walkthrough/_lib/recorder.py`
- Modify: `tests/walkthrough/*` that import from `scripts.ddd.schemas.models`

- [ ] **Step 1:** In `scripts/walkthrough/_lib/recorder.py`, change `from scripts.ddd.schemas.models import Action, ACTION_KINDS, …` → `from scripts.narrative.models import Action, ACTION_KINDS, …`. The renderer now depends on the neutral substrate, not the methodology.

- [ ] **Step 2:** Repoint the walkthrough tests that import the action vocabulary (`tests/walkthrough/test_action_kinds_single_source.py`, `test_action_discriminated_union.py`, `test_scene_*`) to `scripts.narrative.models`.

- [ ] **Step 3:** Run `uv run pytest`. Expected: same pass count. **Commit:** `git commit -am "refactor(walkthrough): import Action vocabulary from scripts/narrative, not ddd"`

---

## Task 3: Make the narrative JSON Schema the canonical, published artifact

**Files:**
- Modify: `scripts/ddd/validate.py` (`dump_json_schemas`) and/or `scripts/ddd/regen_json_schemas.py`
- Create: `scripts/narrative/schema/json/*.json` (committed artifact)
- Modify: `.pre-commit-config.yaml` (the `regen-ddd-json-schemas` hook path, if needed)

- [ ] **Step 1:** Point the schema dump at the neutral models and a neutral output dir. In `regen_json_schemas.py`, change `out_dir = REPO_ROOT / "scripts" / "ddd" / "schemas" / "json"` → `REPO_ROOT / "scripts" / "narrative" / "schema" / "json"`, and ensure `dump_json_schemas` enumerates the models from `scripts.narrative.models` (it already imports them transitively via the shim, but make the source explicit). Keep `RunState`'s schema emitted too (DDD still needs it) — either in the same dir or a `scripts/ddd/schemas/json/` for DDD-only models. Decide based on `dump_json_schemas`'s current model list; the goal is **the generic narrative models land under `scripts/narrative/schema/json/` as the canonical contract**.

- [ ] **Step 2:** Run `python scripts/ddd/regen_json_schemas.py`; commit the generated `scripts/narrative/schema/json/*.json`. Update the pre-commit hook's `files:`/output path so the gate tracks the new location.

- [ ] **Step 3:** Run `uv run pytest` + run the pre-commit hook (`pre-commit run regen-ddd-json-schemas --all-files`) to confirm it's clean. **Commit:** `git commit -am "feat(narrative): publish canonical narrative JSON Schema under scripts/narrative/schema/json"`

---

## Task 4 (optional, follow-up): expose validators as a `canopy:narrative` capability

The generic validators (`spec_qa.spec_qa`, `narrative_coherence`, `validate` provenance checks, `why_qa.why_qa`) are already independent `(obj) -> Verdict` functions invocable via `python -m scripts.ddd.<mod>`. ACE can call them today. A thin `plugins/canopy/skills/narrative/SKILL.md` capability (mirroring `visual-judge`) that documents "given a narrative spec, run falsifiability + coherence + provenance + actionability and return Verdicts" makes the reuse explicit. **Out of scope for the core extraction; track separately.**

---

## Done criteria
- `uv run pytest` pass count unchanged from Step 0 throughout.
- Generic narrative/eval/review models live in `scripts/narrative/models.py`; `RunState` stays in DDD.
- The walkthrough recorder imports `Action` from `scripts/narrative`, not `ddd`.
- Canonical narrative JSON Schema committed under `scripts/narrative/schema/json/`.
- No `from scripts.ddd.schemas.models import` site broke (re-export shim covers them).

## Downstream (separate, not this plan)
ACE consumes the published JSON Schema to generate TS types + invokes the canopy validators from its video skills — see `2026-06-07-ace-adopt-narrative-contract.md` (ACE repos).
