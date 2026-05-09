# qa-eval-system Lens Runner (ACE-specific)

You are running ACE's **`qa-eval-system`** lens — a project-local lens that audits ACE's per-skill QA + Eval registries against the current state of the code, producer SKILL.md bodies, and the MCP-improvement candidates list.

This runner is dispatched by canopy's `improve-lens` skill (Phase 3b) when its 2-step resolution finds this file at `<ace>/.canopy/lenses/qa-eval-system.runner.md`. Without this file, `improve-lens` would fall back to canopy's bundled `lens-types/qa-eval-system.md` — which doesn't exist — and the dispatcher would error or have to walk the signals manually.

## Status

Stable. Codifies the manual signal-walk that ran during the initial registry buildout (PR #188, audit on 2026-05-09).

## Inputs

You will receive:
- The lens descriptor at `<project_dir>/.canopy/lenses/qa-eval-system.yaml` (already loaded by the dispatcher).
- `evidence_pointers` mapping the descriptor's `evidence:` keys to absolute paths.
- No `cross_model_evidence` / `holistic_evidence` — this lens declares no dispatcher-side probes.

The evidence sources you will read:

| Pointer | Path |
|---|---|
| `source.qa_eval_registries` | `<project>/skills/_qa-decisions.md` + `<project>/skills/_eval-decisions.md` |
| `source.qa_template` | `<project>/skills/_qa-template.md` (heuristic source of truth) |
| `source.eval_template` | `<project>/skills/_eval-template.md` (heuristic source of truth) |
| `source.artifact_manifest` | `<project>/lib/artifact-manifest.ts` (`producedBy` truth source) |
| `source.producer_skills` | `<project>/skills/<producer>/SKILL.md` (read on demand for inline-QA citation checks) |
| `source.mcp_improvement_list` | `<project>/skills/_qa-decisions.md § MCP-improvement candidates surfaced by the audit` |
| `per_run.verdicts` | `<project>/runs/<run-id>/<phase>/<skill>-eval_verdict.yaml` (per-skill eval verdicts produced this run; optional — skip if no `--run` was bound) |
| `per_run.qa_results` | `<project>/runs/<run-id>/<phase>/<skill>-qa_result.yaml` (per-skill QA result YAMLs; optional) |
| `per_run.run_state` | `<project>/runs/<run-id>/run_state.yaml` (which producers ran this run; optional) |

## Process

### Step 1 — Walk signal detectors

For each signal declared in the descriptor's `signals:` block, run the matching probe and emit findings.

#### `registry_row_drift` (probe: `registry_citation_validation`)

For each `inline QA` row in `_qa-decisions.md` whose rationale cites a SKILL.md section by anchor (e.g. "§ Process step 4a", "§ Step 6"):
1. Open the cited `skills/<producer>/SKILL.md`.
2. Grep for the section heading. Tolerate case + minor punctuation variation.
3. If absent: emit a `medium` finding pointing at the registry row + the missing anchor. Propose updating the row's anchor to a section that exists, OR flipping the row to a different status if the inline check has been removed.

For each `has eval` / `has QA` row whose rationale references a `skills/<companion>/SKILL.md` filepath:
4. Confirm the companion skill directory exists.
5. If absent: emit a `high` finding (registry claims a skill exists that doesn't) + propose either restoring the skill or flipping the row back to `not yet migrated`.

For each row referencing an MCP atom name (e.g. `connect_get_program`, `synthetic_generate_from_manifest`):
6. Grep `<project>/mcp/**/capability-map.ts` and the relevant backends for that atom name.
7. If absent: emit a `medium` finding (MCP boundary cited no longer exists) + propose updating the rationale to the renamed atom or flipping the row.

#### `fake_qa_introduced` (probe: `fake_qa_pattern_match`)

For each `has QA` row with a companion `<producer>-qa` skill:
1. Read `skills/<producer>-qa/checks.ts` (if present) and `skills/<producer>-qa/SKILL.md`'s `## Checks` table.
2. For each check, judge against `_qa-template.md § When to skip QA`'s triple test:
   - Is the artifact's downstream consumer LLM-driven (not regex/parser)?
   - Does no code path branch on the artifact's structure?
   - Does the companion `-eval` skill already grade the quality concern this check tries to enforce?
3. If all three are true: emit a `medium` finding ("check `<id>` is fake QA per the heuristic") + propose dropping the check, or — if every check fails the heuristic — propose flipping the producer's row to `NO QA`.

#### `mcp_gap_closed` (probe: `mcp_capability_diff`)

Walk `_qa-decisions.md § MCP-improvement candidates surfaced by the audit` (7 entries today). For each:
1. Read the cited "Currently filled by" inline-QA block from the affected producer's SKILL.md.
2. Check the cited MCP source (e.g. Nova's `validate_app`, CCHQ's build endpoint) — is the upstream fix referenced anywhere ACE-side? Look for: a CHANGELOG entry naming the MCP/upstream fix, the `inline QA` producer's SKILL.md change-log mentioning the fix shipped, a flipped row from `inline QA` to `NO QA` not yet reflected in this candidate list.
3. If evidence of closure: emit a `low` finding + propose:
   - Removing the row from the MCP-improvement candidates table.
   - Flipping the affected producer's row from `inline QA` to `NO QA`.
   - Removing the inline check from the producer's SKILL.md.

If no evidence: emit a `low` `[INFO]` "no closure" entry per candidate (audit trail; not a finding to act on).

#### `deferred_trigger_fired` (probe: `deferred_trigger_evidence_search`)

For each row with status `not yet migrated`:
1. Read the row's "Revisit when" condition.
2. Search per-run evidence for triggers:
   - "Connect-Labs MCP rejects manifest" → grep recent `runs/*/6-synthetic/synthetic-narrative-plan*` for rejection logs.
   - "canopy:walkthrough rejects spec" → grep `runs/*/6-synthetic/walkthrough-*` for rejection logs.
   - "HITL review caught structural issue a QA could have caught" → grep `runs/*/7-solicitation*/` for human-corrected scoring/recommendation files.
3. If trigger fired: emit a `high` finding + propose flipping the row from `not yet migrated` to the appropriate status (typically `has QA` / `has eval`) and shipping the corresponding skill.

After PR #188 (2026-05-09) all 13 deferred rows were closed; this signal should currently emit zero findings unless a *new* row gets added with `not yet migrated` status.

#### `missing_registry_row` (probe: `producer_registry_coverage`)

This is the same coverage check as `test/lib/registries-coverage.test.ts`. The CI lint enforces it on every PR, so this signal exists as a defense-in-depth audit hook (catches the case where the lint was bypassed or the test file was deleted).

1. Walk `lib/artifact-manifest.ts` and extract every `producedBy` value.
2. Skip exempted producers per the lint test (`PRODUCER_EXEMPTIONS` set + `*-qa` / `*-eval` companions).
3. For each remaining producer, confirm a row exists in BOTH `_qa-decisions.md` AND `_eval-decisions.md`.
4. If missing: emit a `high` finding + propose adding the row with one of the 4 QA statuses (or 5 eval statuses) and a rationale.

#### `heuristic_drift` (probe: `heuristic_application_audit`)

For each `NO QA` and `NO eval` row, sanity-check the rationale against current code:
1. If the rationale cites "downstream consumer is LLM-driven" — confirm the manifest's `consumedBy` chain doesn't include a new consumer that regex-parses the artifact.
2. If the rationale cites an MCP boundary check — confirm that MCP atom still exists and still validates what the row claims.
3. If the rationale cites "covered by sibling eval" — confirm the sibling eval still exists.

If any rationale no longer holds: emit a `medium` finding + propose updating the rationale and reclassifying if the heuristic no longer applies.

### Step 2 — Bound proposal count

Per `--max-proposals N` (default 3): if more findings surface than the cap allows, prioritize by severity (high → medium → low) and rank within severity by `signal` order in the descriptor. Truncate the proposals list — keep all findings (cheap to surface) but only propose fixes for the top N.

### Step 3 — Return findings + proposals YAML

Per the lens-runner contract from `improve-lens § Phase 3b`:

```yaml
findings:
  - id: <8-char hex>
    signal: <signal-id from descriptor>
    target_skill: <producer or eval/qa skill>
    severity: low | medium | high
    description: "<one-sentence finding>"
    evidence_refs:
      - "<file:line or anchor>"
proposals:
  - id: <8-char hex>
    finding_id: <id>
    target_file: skills/_qa-decisions.md | skills/_eval-decisions.md | skills/<skill>/SKILL.md | skills/<skill>/checks.ts | skills/_qa-template.md | skills/_eval-template.md
    target_section: "## ..."
    proposed_edit: |
      <unified diff or replacement-text block>
    rationale: "<short explanation tying back to the heuristic / signal>"
```

### Verification

The descriptor declares `verify.type: observational`. The dispatcher (canopy's improve-lens Phase 4) will:
1. Apply the proposed edit on a worktree copy.
2. Run `npm test` (which includes `test/lib/registries-coverage.test.ts`).
3. Diff-inspect: confirm changes are confined to `proposes.edit_targets` patterns.
4. Pass if no test regressions and diff matches declared targets.

`auto_merge.enabled: false` per descriptor — every proposal lands as a PR for human review. Registry/heuristic edits affect classification of all future producers; the cost of a wrong classification cascades.

## Notes

- This runner deliberately does NOT propose MCP-side fixes. The MCP-improvement candidates list lives in `_qa-decisions.md` to surface upstream targets for the canopy/Nova/CCHQ teams; the runner's job is registry hygiene, not upstream fixes.
- When in doubt between proposing a registry edit vs a SKILL.md edit, prefer the registry edit — it's the canonical answer for "does skill X have QA/eval, and why or why not?" and SKILL.md drift is a downstream consequence.
- Keep proposals atomic. One proposal = one signal hit on one target. If a single registry row needs multiple changes, split into multiple proposals — keeps verification + review tractable.
