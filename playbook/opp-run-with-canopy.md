# Per-opp run with canopy improvement loop

Operational playbook for running an opp through `/ace:run` while capturing canopy improvement signal in the same session. Addresses the "I built many tools in parallel; I've forgotten the ideal way to use them together" pattern by giving a fixed per-opp sequence.

## When to use

- Any `/ace:run` on an opp where you want to capture session-derived improvement findings while they're freshest.
- Skip for `/ace:step`, hotfixes, or one-off ops — the overhead isn't worth it.
- One opp at a time. Don't try to fan this across multiple opps in parallel — VERSION-bump churn and worktree sprawl will dominate.

## Pattern

Fire canopy's `perf` lens **in-session at a gate pause** (it reads `~/.claude/canopy/session-log.jsonl` and benefits from live transcript signal). Fire `judge`, `production`, and `qa-eval-system` lenses **off-session against run artifacts** (they read Drive verdicts, not the JSONL). Capture proposals during the run; implement them in a separate session to avoid worktree + VERSION churn during the run.

## Sequence

1. **Pre-flight (30s).**
   - `/canopy:pm-status` — see the proposal backlog. If a stack of unactioned proposals exists, decide whether to clear them first; they'll resurface at any Phase 5 gate.
   - `git worktree list | wc -l` — confirm worktree count. If already >20, you're at higher VERSION-collision risk; treat mid-run perf proposals as capture-only.

2. **Launch `/ace:run <opp>`.** Let it execute through early phases.

3. **At the first natural gate** (Gate 1 after PDD, Gate 2 after scenarios, or whichever you naturally pause at — see `agents/orchestrator-reference.md § Pause-points catalog`):
   ```
   /canopy:improve-lens --lens perf --project <ace-worktree-path>
   ```
   The `perf` lens analyzes sequential tool calls, redundant reads, and MCP loops from the current session's JSONL. This is the *only* lens that meaningfully benefits from being in-session.

4. **Capture, don't ship.** When perf surfaces proposals at its Phase 5 gate, **decline implementation** for now. Approving mid-run creates worktree + VERSION-bump churn that collides with whatever active worktrees you already have in flight. Proposals are persisted to `~/.claude/canopy/proposals/` and survive until you act on them.

5. **Resume the run.** Complete remaining phases to natural stop (run completion, or a stable pause like Gate 8 awaiting awardee).

6. **Off-session lenses post-run.** In a fresh session, against the run's artifacts:
   ```
   /canopy:improve-lens --lens judge --project <ace-worktree-path>
   /canopy:improve-lens --lens production --project <ace-worktree-path>
   /canopy:improve-lens --lens qa-eval-system --project <ace-worktree-path>
   ```
   These read Drive verdicts and don't need the session log. Run in a fresh session to keep context clean.

7. **Implement.** In yet another session, approve the captured proposals from steps 3 and 6. Each becomes its own PR via canopy's Phase 5 Agent dispatch. Auto-merge handles VERSION collision via `scripts/version-bump.sh`.

## Per-opp checklist

Copy this block into a `.claude/pm/runs/<date>-<opp>-loop.md` log when you start:

- [ ] `/canopy:pm-status` — backlog reviewed
- [ ] `git worktree list` — collision risk assessed
- [ ] `/ace:run <opp>` launched
- [ ] At first gate: `/canopy:improve-lens --lens perf` fired (capture only, declined implement)
- [ ] Run resumed + completed (or stable pause reached)
- [ ] New session: `/canopy:improve-lens --lens judge` against run verdicts
- [ ] New session: `/canopy:improve-lens --lens production` against run artifacts
- [ ] New session: `/canopy:improve-lens --lens qa-eval-system` against QA decisions
- [ ] New session: approve + ship captured proposals
- [ ] Run log written to `.claude/pm/runs/`

## Gotchas

- **VERSION collision is the main risk.** Many active worktrees + canopy auto-bumping = rebase storms. Use `scripts/version-bump.sh` (worktree-safe). Don't accept mid-run perf proposals into PR — capture them, ship later.
- **`/canopy:improve` (no `-lens`) is too broad.** It sweeps all recent sessions across all projects. For this playbook always use `/canopy:improve-lens` with explicit `--project`.
- **Don't fire perf lens before Phase 1 finishes.** The session log is too thin to surface meaningful patterns. Wait for the first gate.
- **`judge` lens has `auto_merge.enabled: true` for anchor-tightening.** Review the lens descriptor before approving — auto-merge means it ships without your eyes on the diff. Set the flag false in `.canopy/lenses/judge.yaml` for this run if you want manual review.
- **Lens runners are Agents at level 0.** They can't dispatch further Agents. If you find yourself wanting a lens to itself dispatch work, that's a sign the lens descriptor is wrong, not that you need recursion.

## Cross-references

- Canopy lens dispatcher: `~/.claude/plugins/cache/canopy/canopy/<v>/skills/improve-lens/SKILL.md`
- ACE phase + gate map: `agents/orchestrator-reference.md § Pause-points catalog`
- Lens descriptors: `.canopy/lenses/{perf,judge,production,operational,qa-eval-system}.yaml`
- Version-collision recipe: `CLAUDE.md § Git worktrees and merging to main`
- Run-log template: latest file in `.claude/pm/runs/`
