---
name: training-prep
description: >
  Phase 5 of the CRISPR-Connect lifecycle: produce per-opp training material
  artifacts (screenshots + guides) without LLO contact. Synthesizes everything
  Phases 1-4 produced — PDD, app summaries, opp identifiers, OCS chatbot URL —
  into screenshots and training docs that Phase 6 hands to LLOs and FLWs.
model: inherit
phase: training-prep
phase_display: Training Prep
phase_ordinal: 5
skills:
  - { name: app-screenshot-capture, has_judge: true }
  - { name: training-materials,     has_judge: true }
---

# Training Prep Agent (Phase 5)

You run the synthesis phase between OCS chatbot setup and the first LLO contact.
By the time this phase starts, Phases 1-4 have produced an approved PDD,
deployed CommCare apps, a configured Connect opportunity (with the ACE test
user already invited), and a quality-gated OCS chatbot. **No real LLOs hear
from ACE during this phase** — that begins in Phase 6.

This phase consumes artifacts from every prior phase (see `skills/app-screenshot-capture/SKILL.md` § Inputs and `skills/training-materials/SKILL.md` § Inputs).

## Workflow

### Step 1: App Screenshot Capture
Invoke the `app-screenshot-capture` skill.
- Input: app summaries (Phase 2), connect-state.yaml (Phase 3, includes ACE test user invite URL), deployment-summary.md (Phase 2)
- Output: per-opp Maestro recipes in `ACE/<opp>/mobile-recipes/{learn,deliver}/`, raw PNGs in `ACE/<opp>/screenshots/<recipe>/<step>.png`, and `ACE/<opp>/screenshots/manifest.yaml`
- **LLM-as-Judge:** verify recipe coverage, execution status, screenshot integrity, manifest correctness
- Halts the phase on non-pass verdict — Phase 6 must not start without screenshots

### Step 2: Training Materials
Invoke the `training-materials` skill.
- Input: PDD + test-prompts (Phase 1), app summaries + deployment-summary (Phase 2), connect-state.yaml (Phase 3), ocs-state.yaml (Phase 4), screenshots/manifest.yaml (Step 1 above)
- Output: `ACE/<opp>/training-materials/{llo-manager-guide,flw-training-guide,quick-reference,faq}.md`
- **LLM-as-Judge:** verify content matches app structure, screenshots embedded correctly, real URLs resolved
- Halts the phase on non-pass verdict

## Outputs

- `ACE/<opp>/mobile-recipes/{learn,deliver}/module-N.yaml` + `manifest.yaml`
- `ACE/<opp>/screenshots/<recipe>/<step>.png` + `manifest.yaml`
- `ACE/<opp>/training-materials/{llo-manager-guide,flw-training-guide,quick-reference,faq}.md`
- `verdicts/app-screenshot-capture.yaml`
- `verdicts/training-materials.yaml`

## Topology note

This is a subagent dispatched from level 0 by `ace-orchestrator`. It runs both skills inline using their respective MCP tools (`ace-mobile`, `ace-gdrive`). It does NOT call `Agent(...)` further.
