/**
 * ACE's one architectural rule, enforced instead of remembered.
 *
 * `CLAUDE.md § Agent topology`: **anything that calls `Agent` must run at level 0**
 * (the top-level Claude Code session). The `Agent` tool is unavailable to
 * subagents, so a node that needs to dispatch further work cannot itself be a
 * subagent — it must be a PROCEDURE DOC that the orchestrator reads and executes
 * inline. Both forms live under `agents/`; only the wiring differs.
 *
 * The rule was prose, and prose does not fail. `agents/synthetic-data-and-workflows.md`
 * (Phase 7) was wired as a subagent and its Step 3 said "…or `Agent(canopy:ddd)`
 * for the full converge → video → upload loop." That branch was structurally
 * unreachable, so the only executable path was a single render+judge pass with no
 * loop, no convergence rule and no stopping rule. Run
 * `spark-facilitator/20260813-2126` then hand-drove four iterations across ~2M
 * subagent tokens and stopped only because a human said to.
 *
 * Nothing caught it. This does.
 *
 * The discriminator is deliberately a plain string match, not a heuristic: a
 * procedure doc declares itself in its H1 ("(Procedure Document)" / "(procedure
 * doc)"), and a subagent doc may not contain the literal token `Agent(` anywhere —
 * not even in prose describing what it does NOT do. A rule with no exceptions is
 * one nobody has to interpret.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS_DIR = join(__dirname, '..', '..', 'agents');

/** An agent doc whose H1 declares it a level-0 procedure document. */
const PROCEDURE_DOC_MARKER = /^#\s+.*\((?:Phase \d+ )?[Pp]rocedure [Dd]oc(?:ument)?\)/m;

/** A dispatch of the Agent tool. */
const AGENT_DISPATCH = /Agent\(/;

/**
 * Docs under `agents/` that are never dispatched at all — pure reference
 * companions. They describe the topology (including `Agent(...)` call sites), so
 * the no-dispatch rule does not apply to them. Kept explicit and tiny: a new
 * entry here is a deliberate, reviewable exemption, not a silent one.
 */
const REFERENCE_ONLY = new Set(['orchestrator-reference.md']);

interface AgentDoc {
  file: string;
  text: string;
  isProcedureDoc: boolean;
}

function loadAgentDocs(): AgentDoc[] {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !REFERENCE_ONLY.has(f))
    .map((file) => {
      const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
      return { file, text, isProcedureDoc: PROCEDURE_DOC_MARKER.test(text) };
    });
}

describe('agent topology — Agent dispatch requires level 0', () => {
  const docs = loadAgentDocs();

  it('finds agent docs to check', () => {
    expect(docs.length).toBeGreaterThan(5);
  });

  it('every REFERENCE_ONLY exemption names a file that exists', () => {
    const all = new Set(readdirSync(AGENTS_DIR));
    const stale = [...REFERENCE_ONLY].filter((f) => !all.has(f));
    expect(stale, 'stale exemption — remove it').toEqual([]);
  });

  it('no SUBAGENT doc contains an Agent( dispatch', () => {
    const violations = docs
      .filter((d) => !d.isProcedureDoc && AGENT_DISPATCH.test(d.text))
      .map((d) => {
        const lines = d.text
          .split('\n')
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => AGENT_DISPATCH.test(line))
          .map(({ line, n }) => `      ${d.file}:${n}  ${line.trim()}`)
          .join('\n');
        return `  ${d.file} is a subagent but dispatches Agent(:\n${lines}`;
      });

    expect(
      violations,
      `The Agent tool is unavailable to subagents (CLAUDE.md § Agent topology), so these\n` +
        `dispatches are unreachable — the branch silently never runs.\n` +
        `Either promote the doc to a level-0 procedure doc (add "(Procedure Document)" to\n` +
        `its H1 + a level-0 note, and change the orchestrator's Dispatch: line to read it\n` +
        `inline), or remove the dispatch. Do not leave it as prose.\n\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('every procedure doc says so in its body, not just its title', () => {
    const missing = docs
      .filter((d) => d.isProcedureDoc)
      .filter((d) => !/NOT dispatched as a subagent|executed inline|not a subagent/i.test(d.text))
      .map((d) => d.file);

    expect(
      missing,
      'A procedure doc must state in its body that it runs inline at level 0 — the H1 ' +
        'alone is not read by an orchestrator scanning for how to invoke it.',
    ).toEqual([]);
  });

  it('phase 7 is a procedure doc (it dispatches the canopy DDD loop)', () => {
    const phase7 = docs.find((d) => d.file === 'synthetic-data-and-workflows.md');
    expect(phase7, 'agents/synthetic-data-and-workflows.md is missing').toBeDefined();
    expect(
      phase7!.isProcedureDoc,
      'Phase 7 dispatches Agent(canopy:ddd) for render+converge, so it cannot be a subagent.',
    ).toBe(true);
  });

  it('the orchestrator dispatches every procedure-doc phase INLINE, never by Agent()', () => {
    const orchestrator = readFileSync(join(AGENTS_DIR, 'ace-orchestrator.md'), 'utf8');
    const procedureDocPhases = docs
      .filter((d) => d.isProcedureDoc)
      .map((d) => d.file.replace(/\.md$/, ''))
      // only phase agents appear in the orchestrator's Dispatch: lines
      .filter((name) => /phase_ordinal:/.test(docs.find((d) => d.file === `${name}.md`)!.text));

    const wrong = procedureDocPhases.filter((name) =>
      new RegExp(`\\*\\*Dispatch:\\*\\*\\s*\`Agent\\(${name}\\)\``).test(orchestrator),
    );

    expect(
      wrong,
      'These phases are procedure docs but ace-orchestrator.md still tells the orchestrator ' +
        'to dispatch them as subagents. The Agent dispatches inside them would be unreachable.',
    ).toEqual([]);
  });
});
