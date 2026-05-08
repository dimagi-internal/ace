# ACE × Canopy Self-Improvement Descriptors

This directory declares ACE's shape for canopy-driven self-improvement loops. Canopy is the brain (analysis, dispatch, PR shipping); this directory tells canopy what evidence ACE produces, what kinds of issues are worth proposing fixes for, and how to verify a fix before merging.

## Why descriptors live in the target repo

Canopy stays domain-agnostic. ACE-specific knowledge — what a verdict YAML looks like, which skills are producers vs evaluators, where to find run state — lives here, version-controlled with the rest of ACE. When ACE's shape evolves, this directory evolves in the same PR. Other projects (canopy itself, ace-web, etc.) declare their own `.canopy/` and get the same machinery for free.

## Three lenses, three loops

Each lens is its own loop, dispatched independently. Run them in parallel from the same human session — they don't share state and can't deadlock each other.

| Lens | The question | Verification | Auto-merge eligibility |
|---|---|---|---|
| **operational** | Did the system run cleanly? Phases complete, gates fire correctly, MCP atoms succeed, state coherent? | Observational only — fixes affect runtime, hard to verify without another run | Human review |
| **production** | Did producer skills generate good artifacts? | Sandbox-regen — re-run producer with edited prompt against same inputs, re-grade the sandbox artifact, compare verdicts | Human review |
| **judge** | Are evals catching real flaws and only real flaws? | Re-grade — apply rubric edit, re-dispatch eval against original artifact, compare verdicts | Auto-merge eligible (deterministic, reversible) |

## Layout

```
.canopy/
├── README.md                 (this file)
├── run-artifacts.yaml        (what ACE produces when it runs — per-run + opp-level)
└── lenses/
    ├── operational.yaml      (instance of canopy's `operational` lens type)
    ├── production.yaml       (instance of canopy's `production` lens type)
    └── judge.yaml            (instance of canopy's `judge` lens type)
```

`run-artifacts.yaml` describes what the system *produces* — verdicts, run state, gate briefs, summaries, opp-level cross-run state. Lens descriptors reference its entries (e.g. `per_run.verdicts`).

What's *not* here:
- **Source code** (`skills/`, `agents/`, `lib/`, `mcp/`) — canopy resolves the repo root via `orchestrator.repo_paths` and uses `Glob` from there. The lens type knows which directories matter.
- **Session transcripts** — canopy already reads recent Claude Code sessions natively via `canopy:improve` infrastructure.

## Lens types vs lens instances

Each lens descriptor in `lenses/` is a **project-specific instance** of a generic **lens type** that canopy ships:

- `lens type` (in canopy) = the fundamental concept: signal taxonomy, verification protocol, generic analyzer prompt
- `lens instance` (in this directory) = ACE's specialization: which evidence sources, which file patterns, which thresholds, which auto-merge conditions

If a project needs a wholly new lens type (e.g. `performance` for a perf-sensitive project), it can ship its own runner alongside its descriptor; canopy dispatches to the project-supplied runner if present, otherwise to canopy's default.

## How a lens runs (single-run scope, v1)

```
human:
  /canopy:improve-lens --lens judge --project ace --run runs/<run-id>

canopy:
  1. Read project's .canopy/lenses/<lens>.yaml
  2. Walk evidence sources for the named run
  3. Run the lens's signal detectors (cross-model probe for judge,
     producer-trace analysis for production, session+state for operational)
  4. For each surfaced finding:
       - draft a candidate fix
       - run the lens's verification protocol
       - if verification passed AND auto-merge conditions met:
           open PR + auto-merge
         else:
           open PR + tag for human review
  5. Write run log to ~/.claude/canopy/runs/
```

## Cross-run aggregation: deferred

ACE's per-run state is not yet stable enough for cross-run patterns to mean much — every run currently produces different improvements as the plugin matures. When that stabilizes, a cross-run aggregator will consume the same evidence shape declared here and surface "same finding tried+rejected on N separate runs" patterns. No descriptor changes required for that addition.
