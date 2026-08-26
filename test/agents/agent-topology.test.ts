/**
 * ACE's dispatch topology, enforced instead of remembered.
 *
 * ## The incident this exists for
 *
 * `agents/synthetic-data-and-workflows.md` (Phase 7) was wired as a subagent and
 * its Step 3 said "…or `Agent(canopy:ddd)` for the full converge → video → upload
 * loop." Under the Claude Code of the time that branch was structurally
 * unreachable — subagents had no `Agent` tool — so the only executable path was a
 * single render+judge pass with no loop, no convergence rule and no stopping rule.
 * Run `spark-facilitator/20260813-2126` then hand-drove four iterations across
 * ~2M subagent tokens and stopped only because a human said to. Nothing caught it.
 *
 * ## Why this file changed shape (2026-08-26)
 *
 * The original guard encoded the rule as an absolute: *a subagent doc may not
 * contain the literal token `Agent(` anywhere.* That rule is no longer true.
 * Claude Code allows subagent nesting to a configurable depth (default 3 since
 * v2.1.219), so a subagent CAN dispatch — provided its chain fits the budget.
 * Kept as-is, this file would have failed CI on a refactor that is now legal, and
 * a green test asserting a retracted rule is worse than no test.
 *
 * The protection is preserved, not dropped, by moving the load-bearing question
 * from "does this doc contain `Agent(`?" to "is every dispatch this doc makes
 * ACCOUNTED FOR in the depth arithmetic?" — which is `lib/agent-depth.ts`, guarded
 * by `test/lib/agent-depth.test.ts`. An unreachable branch is still caught; it is
 * now caught by the number rather than by the taboo.
 *
 * What stays here: the structural checks that are about INVOCATION rather than
 * depth — a procedure doc must declare itself so an orchestrator scanning it knows
 * how to invoke it, and the orchestrator's `Dispatch:` lines must match each doc's
 * actual form. Those were never about the nesting rule and are still correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DISPATCH_GRAPH } from '../../lib/agent-depth.js';

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

  it('accounts for every Agent( dispatch a subagent doc makes', () => {
    // Superseded the old absolute ban (see the header). A subagent may dispatch
    // now; what it may not do is dispatch something the depth arithmetic has
    // never heard of, because that is how a chain silently outgrows the budget
    // and a fan-out collapses without erroring.
    const declared = new Map(DISPATCH_GRAPH.map((n) => [n.name, n]));

    const violations = docs
      .filter((d) => !d.isProcedureDoc && AGENT_DISPATCH.test(d.text))
      .flatMap((d) => {
        const node = declared.get(d.file.replace(/\.md$/, ''));
        const targets = [...d.text.matchAll(/\bAgent\(([a-z0-9:_-]+)\)/g)].map((m) => m[1]);
        const undeclared = [...new Set(targets)].filter(
          (t) => !(node?.dispatches as readonly string[] | undefined)?.includes(t),
        );
        return undeclared.length === 0
          ? []
          : [`  ${d.file} dispatches ${undeclared.join(', ')} — not in its DISPATCH_GRAPH entry`];
      });

    expect(
      violations,
      'A dispatch that lib/agent-depth.ts does not know about is not counted against\n' +
        'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH. Add it to the node\'s `dispatches` (and\n' +
        'check the resulting depth), or remove it.\n\n' +
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

  it('phase 7 form matches lib/agent-depth.ts', () => {
    // Phase 7 dispatches the canopy DDD loop, which fans out per-scene judges of
    // its own — the deepest chain ACE has. It is inline today because that keeps
    // the chain at depth 2. Whether it MUST stay inline is now an arithmetic
    // question, so assert agreement with the graph rather than a fixed answer.
    const phase7 = docs.find((d) => d.file === 'synthetic-data-and-workflows.md');
    expect(phase7, 'agents/synthetic-data-and-workflows.md is missing').toBeDefined();
    const declared = DISPATCH_GRAPH.find((n) => n.name === 'synthetic-data-and-workflows');
    expect(declared, 'phase 7 is missing from DISPATCH_GRAPH').toBeDefined();
    expect(
      phase7!.isProcedureDoc,
      `lib/agent-depth.ts declares phase 7 as '${declared!.form}' but the doc says otherwise. ` +
        'The graph and the doc must agree — the depth budget is computed from the graph.',
    ).toBe(declared!.form === 'inline');
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
