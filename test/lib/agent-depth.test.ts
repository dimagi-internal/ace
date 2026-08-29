/**
 * Agent dispatch-depth guard.
 *
 * ACE was designed under a Claude Code rule that no longer holds — subagents
 * could not spawn subagents, so every node that dispatched `Agent` had to run
 * inline at level 0. Nesting is now allowed to a configurable depth (default 3
 * since v2.1.219). `lib/agent-depth.ts` carries the reasoning; this file is the
 * mechanical half.
 *
 * The check matters because the failure mode INVERTED. Under the old rule a
 * too-deep dispatch errored — loud, immediate, and how the Nova migration
 * regression was caught. Under the new one, Claude Code withholds the `Agent`
 * tool at the limit and the subagent "does its delegated work itself and returns
 * one summary." Nothing errors. A Phase 7 run whose per-scene `canopy:visual-judge`
 * dispatches got silently folded into a single context still produces a full set
 * of verdicts — they are just correlated, self-graded, and wrong in the optimistic
 * direction. That is the same shape as the collapsed QA/eval pair in
 * dimagi-internal/ace#1203, and it is not visible in any artifact ACE writes.
 *
 * So the invariant is now numeric, and something has to hold the number.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPATCH_GRAPH,
  ENTRY_POINTS,
  MAX_SUBAGENT_SPAWN_DEPTH,
  allChains,
  formatChains,
  maxDepth,
} from '../../lib/agent-depth.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `Agent(x)` occurrences that are prose, not dispatches — a doc telling you NOT
 * to write the call. Each entry needs a reason; an unexplained entry here is how
 * a real dispatch gets hidden from the depth arithmetic.
 */
const NON_DISPATCH_MENTIONS: Record<string, string> = {
  'partnership-video':
    'agents/partnership-video.md and commands/partnership-video.md tell the reader never to write Agent(partnership-video) — it is a procedure doc.',
  // NOTE: this map is consulted only for targets NOT in DISPATCH_GRAPH — the
  // `declared.has(target)` check runs first. `ace-orchestrator` and `demo` are
  // declared nodes, so their "never write Agent(this)" lines in commands/ need
  // no entry here; adding one would be inert. Only genuinely undeclared names
  // belong below.
  X: 'agents/orchestrator-reference.md uses Agent(X) as a placeholder for "a top-level Agent call", not a real target.',
};

/**
 * Every `Agent(<target>)` literal written in agents/, skills/ and commands/.
 *
 * `commands/` was added in 0.13.1038. It is where a top-level dispatch is
 * actually INSTRUCTED — `commands/run.md` is what tells a session which agents
 * to launch — so leaving it out meant the scan skipped the entry points and
 * read only the things they call.
 *
 * The target class is case-insensitive for the same reason: Claude Code's own
 * agent types include `Explore` and `Plan`, and a lowercase-only pattern makes
 * `Agent(Explore)` invisible to the budget rather than flagged.
 */
function dispatchTargetsInRepo(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const files: string[] = [];

  for (const dir of ['agents', 'commands']) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.md')) files.push(path.join(abs, f));
    }
  }
  const skillsDir = path.join(REPO_ROOT, 'skills');
  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    const p = path.join(skillsDir, e.name, 'SKILL.md');
    if (e.isDirectory() && fs.existsSync(p)) files.push(p);
    if (!e.isDirectory() && e.name.endsWith('.md')) files.push(path.join(skillsDir, e.name));
  }

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bAgent\(([A-Za-z0-9:_-]+)\)/g)) {
      const target = m[1];
      const rel = path.relative(REPO_ROOT, file);
      found.set(target, [...(found.get(target) ?? []), rel]);
    }
  }
  return found;
}

describe('agent dispatch graph', () => {
  const declared = new Map(DISPATCH_GRAPH.map((n) => [n.name, n]));

  it('declares every node it dispatches to', () => {
    const dangling: string[] = [];
    for (const node of DISPATCH_GRAPH) {
      for (const target of node.dispatches) {
        if (!declared.has(target)) dangling.push(`${node.name} → ${target}`);
      }
    }
    expect(
      dangling,
      `DISPATCH_GRAPH dispatches to undeclared nodes:\n  ${dangling.join('\n  ')}`,
    ).toEqual([]);
  });

  it('backs every ACE-owned node with a real agent or skill file', () => {
    const missing = DISPATCH_GRAPH.filter((n) => n.owner === 'ace')
      .filter(
        (n) =>
          !fs.existsSync(path.join(REPO_ROOT, 'agents', `${n.name}.md`)) &&
          !fs.existsSync(path.join(REPO_ROOT, 'skills', n.name, 'SKILL.md')),
      )
      .map((n) => n.name);
    expect(
      missing,
      `declared as owner:'ace' but no agents/<name>.md or skills/<name>/SKILL.md:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('names every entry point', () => {
    const unknown = ENTRY_POINTS.filter((e) => !declared.has(e));
    expect(unknown, `ENTRY_POINTS not in DISPATCH_GRAPH: ${unknown.join(', ')}`).toEqual([]);
  });

  it('accounts for every Agent(...) target written in the repo', () => {
    const inRepo = dispatchTargetsInRepo();

    // An empty scan would pass every assertion below while checking nothing —
    // the exact shape of a guard that reports success without having looked.
    expect(
      inRepo.size,
      'scanned agents/, skills/ and commands/ and found no Agent(...) dispatches ' +
        'at all — the scanner is broken, not the repo',
    ).toBeGreaterThan(0);

    // commands/ joined the scan in 0.13.1038. If the walk silently stops
    // covering it, this assertion is the only thing that says so — the
    // unaccounted-targets check below would just go quiet.
    const scannedCommands = [...inRepo.values()].flat().some((f) => f.startsWith('commands/'));
    expect(
      scannedCommands,
      'no Agent(...) literal found under commands/ — commands/run.md and ' +
        'commands/demo.md both carry one, so the directory walk is broken',
    ).toBe(true);

    const unaccounted: string[] = [];
    for (const [target, files] of inRepo) {
      if (declared.has(target)) continue;
      if (target in NON_DISPATCH_MENTIONS) continue;
      unaccounted.push(`${target}  (in ${files.join(', ')})`);
    }
    expect(
      unaccounted,
      'These Agent() dispatches are written in the repo but absent from ' +
        'lib/agent-depth.ts, so they are not counted against the depth budget. ' +
        'Add each as a node (or to NON_DISPATCH_MENTIONS with a reason):\n  ' +
        unaccounted.join('\n  '),
    ).toEqual([]);
  });

  it('keeps NON_DISPATCH_MENTIONS from hiding a node that is really dispatched', () => {
    // Prose-only + declared `inline` is the coherent case: the doc exists to say
    // "never write Agent(this)". Prose-only + declared `subagent` is not — that
    // is a node which really is dispatched, excused out of the depth arithmetic.
    const shadowed = Object.keys(NON_DISPATCH_MENTIONS).filter(
      (n) => declared.get(n)?.form === 'subagent',
    );
    expect(
      shadowed,
      'listed as a prose-only mention but declared as a dispatched subagent, so ' +
        `its chain is not being counted: ${shadowed.join(', ')}`,
    ).toEqual([]);
  });
});

describe('depth budget', () => {
  it('fits every chain inside MAX_SUBAGENT_SPAWN_DEPTH', () => {
    const deepest = maxDepth();
    expect(
      deepest,
      `A dispatch chain descends ${deepest} levels, past the budget of ` +
        `${MAX_SUBAGENT_SPAWN_DEPTH}. At the limit Claude Code withholds the Agent ` +
        `tool and the leaf does the work itself — so this does NOT error at runtime, ` +
        `it silently collapses whatever fan-out sits at the bottom.\n\n` +
        `Either restore an inline node on the offending chain, or raise ` +
        `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH in settings.json AND ` +
        `MAX_SUBAGENT_SPAWN_DEPTH here, deliberately.\n\nChains:\n${formatChains()}`,
    ).toBeLessThanOrEqual(MAX_SUBAGENT_SPAWN_DEPTH);
  });

  it('justifies every inline node by an Agent dispatch of its own', () => {
    // An inline procedure doc is a cost — it runs in the caller's context and
    // inflates it. The only thing that buys is depth headroom for its own
    // dispatches. One that dispatches nothing should just be a subagent.
    const pointless = DISPATCH_GRAPH.filter((n) => n.form === 'inline')
      .filter((n) => n.dispatches.length === 0)
      .map((n) => n.name);
    expect(
      pointless,
      'Declared inline but dispatches no Agent, so it spends the top-level ' +
        'context for nothing. Now that nesting is allowed, make it a subagent:\n  ' +
        pointless.join('\n  '),
    ).toEqual([]);
  });

  it('records the current headroom so a change to it shows up in review', () => {
    // Not an assertion about correctness — a tripwire. When this number moves,
    // the diff says so, and someone decides whether the move was intended.
    const chains = allChains();
    const deepest = chains[0];
    expect({
      maxDepth: deepest.depth,
      budget: MAX_SUBAGENT_SPAWN_DEPTH,
      deepestChain: deepest.path.join(' → '),
    }).toEqual({
      maxDepth: 3,
      budget: 5,
      deepestChain:
        'ace-orchestrator → synthetic-data-and-workflows → canopy:ddd → ' +
        'gstack:design-fixer → gstack:review-followup',
    });
  });
});
