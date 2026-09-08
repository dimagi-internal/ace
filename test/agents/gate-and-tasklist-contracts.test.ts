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
 * dimagi-internal/ace#2127 / #2173 / #2210 — the Claude Code to-do tools
 * (`TaskCreate`/`TaskUpdate`/`TodoWrite`) and ACE's progress reporting.
 *
 * #2127 and #2173 fixed the SYMPTOM: a mandatory step whose tool is absent,
 * with no fallback, deadlocks the executor. That guarantee is preserved below
 * and must not be deleted.
 *
 * #2210 fixed the FRAMING. Claude Code 2.1.233 withheld TodoWrite/TaskCreate/
 * TaskGet/TaskUpdate/TaskList from Opus 4.8, Sonnet 5, Fable 5, Mythos 5 and
 * newer unless the operator sets CLAUDE_CODE_ENABLE_TODO_TOOLS=1. So absence
 * is the documented DEFAULT, not an anomaly — and both prior issues recorded
 * the wrong premise ("resolve in no session"), which is why the same ground
 * was investigated three times. The docs must now carry the cause.
 */
describe('ace#2127/#2173/#2210 — the to-do list is optional legacy, not the default', () => {
  it('run_state.yaml is stated as THE run-progress mechanism, not a fallback', () => {
    const step4 = ORCH.slice(ORCH.indexOf('**Step 4 —'), ORCH.indexOf('**Step 5 —'));
    expect(step4).toMatch(/`run_state\.yaml` is \*\*the\*\* run-progress mechanism/i);
    expect(step4).toMatch(/optional legacy/i);
  });

  it('a step whose tool may be absent still never halts and never improvises', () => {
    // THE GUARANTEE FROM #2127/#2173. Inverting the default must not reopen
    // the deadlock those issues closed: an executor meeting an absent tool
    // still needs an unambiguous instruction.
    const step4 = ORCH.slice(ORCH.indexOf('**Step 4 —'), ORCH.indexOf('**Step 5 —'));
    expect(step4).toMatch(/Never halt, never improvise a substitute tracker/i);
    expect(ORCH).toMatch(/ace#2127/);
  });

  it('the docs record the ROOT CAUSE, so a fourth investigation is not needed', () => {
    // The absence of this fact is what cost #2127, #2173 and a third
    // investigation: each re-derived "the tool is gone" and none could say why
    // or whether it would come back.
    const step4 = ORCH.slice(ORCH.indexOf('**Step 4 —'), ORCH.indexOf('**Step 5 —'));
    expect(step4).toMatch(/2\.1\.233/);
    expect(step4).toMatch(/CLAUDE_CODE_ENABLE_TODO_TOOLS/);
    // Model-gated, not permanent — the premise both prior issues got wrong.
    expect(step4).toMatch(/Opus 4\.7|older models/i);
  });

  it('the per-run "task list skipped" disclosure is explicitly NOT required', () => {
    // The noise #2210 targets. Absence is the documented normal case, so
    // narrating it every run is a false signal of anomaly.
    const step4 = ORCH.slice(ORCH.indexOf('**Step 4 —'), ORCH.indexOf('**Step 5 —'));
    expect(step4).toMatch(/is\s+noise\s+—\s+omit it/i);
  });

  it('ACE records that it deliberately does NOT enable the env var, and why', () => {
    // Operator decision. Without the rationale the next reader "fixes" this by
    // turning the tools back on, re-adding per-turn context cost.
    const step4 = ORCH.slice(ORCH.indexOf('**Step 4 —'), ORCH.indexOf('**Step 5 —'));
    expect(step4).toMatch(/does not set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, deliberately/i);
    expect(step4).toMatch(/run-summary page|README\.md/);
  });

  it('the dead batching guidance for a tool no current model has is gone', () => {
    // Advice optimising the call pattern of a tool that never loads. Not
    // reworded — removed.
    expect(ORCH).not.toMatch(/Issue all phase `TaskCreate` calls in one parallel block/);
    expect(ORCH).not.toMatch(/emit a 2nd sequential `TaskCreate`/);
    expect(REFERENCE).not.toMatch(/Issue all phase TaskCreate calls in one parallel block\.\*\*/);
    // The ~30s-of-model-output rationale went with it.
    expect(ORCH).not.toMatch(/`TaskCreate → TaskCreate/);
  });

  it('the boundary fence keeps its four-way gate and treats TaskUpdate as optional', () => {
    const fence = ORCH.slice(ORCH.indexOf('## Phase boundary fence'));
    expect(fence).toMatch(/optional legacy/i);
    // The actual gate must still be named, or "optional" reads as "ungated".
    expect(fence).toMatch(/the four checks above are/i);
  });

  it('NEITHER doc asserts TaskCreate resolves via the bare-name select: shortcut', () => {
    // #2127 fixed this in orchestrator-reference.md and missed the identical
    // claim in ace-orchestrator.md — the file the orchestrator executes. The
    // old test only looked at REFERENCE, so it passed while the claim was live
    // (ace#2210). Check both.
    for (const [name, doc] of [['ORCH', ORCH], ['REFERENCE', REFERENCE]] as const) {
      // Both docs hard-wrap, so the phrase spans a newline in one of them.
      const idx = doc.search(/shortcut\s+resolves only built-in/);
      expect(idx, `${name} lost the select: guidance entirely`).toBeGreaterThan(-1);
      const sentence = doc.slice(idx, idx + 200);
      expect(sentence, `${name} still names TaskCreate as select:-resolvable`).not.toMatch(
        /TaskCreate|TaskUpdate|TodoWrite/,
      );
      // The rule itself survives — the examples are what changed. WebFetch was
      // verified to resolve via select: on 2026-09-07; EnterPlanMode was not.
      expect(sentence).toMatch(/WebFetch/);
    }
  });
});
