import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const ORCH = readFileSync(join(ROOT, 'agents', 'ace-orchestrator.md'), 'utf8');
const IDEA = readFileSync(join(ROOT, 'agents', 'idea-to-design.md'), 'utf8');
const REFERENCE = readFileSync(join(ROOT, 'agents', 'orchestrator-reference.md'), 'utf8');
const EVAL_TEMPLATE = readFileSync(join(ROOT, 'skills', '_eval-template.md'), 'utf8');

/**
 * dimagi-internal/ace#2145 — three docs disagreed on whether a sub-gate eval
 * composite halts a run.
 *
 *   `skills/_eval-template.md`  : emit `[BLOCKER]` when overall < gate (7.0)
 *   `agents/ace-orchestrator.md`: "A `[BLOCKER]` halts immediately"
 *   `agents/idea-to-design.md`  : "a `verdict: fail` here does NOT halt"
 *
 * Follow the first two and the run halts; follow the third and it proceeds.
 * On `bednet-check-2-visit/20260906-2228` the Phase 1 agent emitted
 * `[BLOCKER]` at 6.62 exactly as the shared contract mandates, then argued in
 * the same breath that it was non-halting — and the orchestrator stopped the
 * run to ask a human which document to believe.
 *
 * De facto behaviour was already "proceed": `20260817-1720` (7.14 fail) and
 * `20260828-0629` (6.96 fail) both continued to later phases.
 *
 * These are prose contracts an LLM executes, so the enforceable property is
 * the cheapest one that is VISIBLE WHEN ABSENT — the disambiguation is
 * present, and the specific sentence that used to contradict it is gone.
 */
describe('ace#2145 — a sub-gate eval composite must not read as a halting BLOCKER', () => {
  it('the shared eval template still MANDATES the emission (we did not "fix" it there)', () => {
    // Deliberately unchanged: a sub-gate composite genuinely is a gate failure
    // worth surfacing. Editing this file would change severity semantics for
    // every -eval skill at once. If this assertion ever fails, the fix moved
    // to the wrong layer.
    expect(EVAL_TEMPLATE).toMatch(/Overall score is below the gate threshold/i);
  });

  it('the orchestrator distinguishes BLOCKER-by-cause rather than by the word alone', () => {
    expect(ORCH).toMatch(/Not every `\[BLOCKER\]` is a halting `\[BLOCKER\]`/);
    expect(ORCH).toMatch(/ace#2145/);
    // The four causes must all be named, so the table cannot silently lose a row.
    expect(ORCH).toMatch(/Composite below the gate threshold/i);
    expect(ORCH).toMatch(/dimension ≤ 3\.0/i);
    expect(ORCH).toMatch(/hard-deduction rule/i);
    expect(ORCH).toMatch(/status: error/);
  });

  it('the orchestrator records that this codifies observed behaviour, not a loosened gate', () => {
    // Without this, a future reader reasonably reads the change as weakening a
    // quality gate and reverts it.
    expect(ORCH).toMatch(/codifies what ACE already did/i);
    expect(ORCH).toMatch(/20260817-1720/);
    expect(ORCH).toMatch(/20260828-0629/);
  });

  it('idea-to-design no longer carries the two clauses that fired against each other', () => {
    // The old text said a fail "does NOT halt" and then that "[BLOCKER]
    // concerns pause" — both true at once at any sub-gate score.
    const oldContradiction =
      /does NOT halt the run on its own — the Phase 1→2 gate uses the producing skill's verdict files and `\[BLOCKER\]` concerns pause/;
    expect(IDEA).not.toMatch(oldContradiction);
    expect(IDEA).toMatch(/ace#2145/);
    // and it must still say what DOES halt, or the carve-out becomes a blanket pass.
    expect(IDEA).toMatch(/Halt only when/i);
  });
});

/**
 * dimagi-internal/ace#2127 — `TaskCreate`/`TaskUpdate` resolve in no session,
 * while the orchestrator makes them a mandatory pre-flight step (Step 4) and a
 * mandatory boundary-fence step (Turn N+1 step 6), with no fallback.
 *
 * Measured on `bednet-check-2-visit/20260906-2228`: `ToolSearch
 * select:TaskCreate,TaskUpdate` returned "No matching deferred tools found",
 * with no tool gating in any settings file. The orchestrator had to invent a
 * fallback mid-run. An orchestrator silently dropping a step it was told was
 * mandatory is the shape that hides a real omission later.
 */
describe('ace#2127 — a mandatory step whose tool may be absent must state its fallback', () => {
  it('Step 4 tells the orchestrator to skip-and-note rather than improvise or halt', () => {
    expect(ORCH).toMatch(/If `TaskCreate` does not resolve, SKIP this step/);
    expect(ORCH).toMatch(/ace#2127/);
    expect(ORCH).toMatch(/do not improvise, and do not halt/i);
  });

  it('the fallback names run_state.yaml as the actual source of truth', () => {
    // The reason the skip is safe. Without it the rule reads as "silently drop
    // a mandatory step", which is the thing we do not want normalised.
    expect(ORCH).toMatch(/progress view, not run state/i);
  });

  it('the boundary-fence TaskUpdate step carries the same fallback', () => {
    // Step 4 and the fence are two separate mandatory sites; fixing only one
    // leaves the run to improvise at every phase boundary instead of once.
    const fence = ORCH.slice(ORCH.indexOf('## Phase boundary fence'));
    expect(fence).toMatch(/SKIP silently if the tool does not resolve/);
    expect(fence).toMatch(/ace#2127/);
  });

  it('points at the alternate name the rest of the repo uses', () => {
    // skills/turn/SKILL.md calls the same capability TodoWrite, pinned by
    // test/skills/turn-self-check-is-a-checkpoint.test.ts. An orchestrator that
    // only knows one name concludes "unavailable" too early.
    expect(ORCH).toMatch(/`TodoWrite`/);
  });

  it('the reference doc no longer asserts TaskCreate resolves via select:', () => {
    // orchestrator-reference.md:1841 used to state this as fact, and it is the
    // justification for the fully-prefixed ToolSearch form — so a reader
    // trusts it. Verified false: EnterPlanMode resolves, TaskCreate does not.
    const claim = REFERENCE.slice(REFERENCE.indexOf('shortcut resolves only built-in'));
    const sentence = claim.slice(0, 200);
    expect(sentence).not.toMatch(/TaskCreate/);
    expect(sentence).toMatch(/EnterPlanMode/);
  });
});
