/**
 * ACE's `Agent` dispatch graph, and the depth budget it has to fit inside.
 *
 * ## Why this file exists
 *
 * For most of 2026 Claude Code forbade subagent nesting outright: the `Agent`
 * tool was withheld from every subagent, so any node that needed to dispatch
 * further work had to run inline in the top-level session. ACE was built around
 * that rule — `ace-orchestrator`, `commcare-setup`, `synthetic-data-and-workflows`,
 * `sweep`, `demo`, `partnership-video` and `iterate-loop` are all "procedure docs
 * executed inline" for exactly one reason: each of them dispatches `Agent`.
 *
 * That rule is gone. Nesting landed in Claude Code v2.1.172 (depth 5, un-tunable),
 * was defaulted back to 1 in v2.1.217, and settled at **3** in v2.1.219. So the
 * binary invariant ACE encoded ("never two levels of `Agent` dispatch") has been
 * replaced by a **budget**: a chain may descend `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
 * levels below the main conversation, and the value is configurable.
 *
 * ## Why a budget needs a guard and a binary didn't
 *
 * The old rule failed LOUDLY — a level-2 `Agent` call errored, which is how the
 * Nova migration incident got noticed. The new one fails QUIETLY: at the depth
 * limit Claude Code *withholds* the `Agent` tool, and the subagent at the floor
 * "does its delegated work itself and returns one summary."
 *
 * For ACE that degradation is invisible and expensive. `ddd-concept-eval`
 * deliberately dispatches `canopy:visual-judge` as a *fresh* subagent per scene —
 * its own SKILL.md applies a −1 penalty to every dimension if that independence
 * isn't real. Push that dispatch past the cap and the judging silently collapses
 * into one context grading every scene in sequence: slower, correlated, and still
 * reporting healthy verdicts. Same failure class as the self-graded evals in
 * dimagi-internal/ace#1203 — a two-phase check quietly folded into one.
 *
 * So: the topology is declared here, and `test/lib/agent-depth.test.ts` asserts
 * (a) the declaration matches the `Agent(...)` dispatches actually written in the
 * repo, and (b) no chain exceeds the budget.
 *
 * ## Depth accounting
 *
 * Level 0 is the top-level session. A node's cost is its FORM, not its file:
 *
 *   - `inline`   — a procedure doc the caller reads and executes in its own
 *                  context. Costs 0. Its dispatches leave from the caller's level.
 *   - `subagent` — dispatched via `Agent(...)`. Costs 1.
 *
 * Skills (`Skill(...)`) always run inline in their invoker and are not nodes here.
 */

/**
 * Levels of subagent nesting available below the main conversation.
 *
 * 3 is Claude Code's default (v2.1.219+) and what ACE runs on today. Raising it
 * is a real option — `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` in `settings.json` —
 * but it must be a deliberate, pinned decision rather than an inherited default,
 * because the default has changed three times in 2026 and a machine that supplies
 * less than ACE needs degrades silently rather than erroring.
 */
export const MAX_SUBAGENT_SPAWN_DEPTH = 3;

export type NodeForm = 'inline' | 'subagent';

export interface DispatchNode {
  /** Bare name for ACE nodes (`ocs-setup`); plugin-qualified for external (`canopy:ddd`). */
  readonly name: string;
  /** `inline` = procedure doc run in the caller's context; `subagent` = costs a level. */
  readonly form: NodeForm;
  /** `ace` nodes must have a backing `agents/<name>.md`; `external` live in other plugins. */
  readonly owner: 'ace' | 'external';
  /** Names this node dispatches via the `Agent` tool. */
  readonly dispatches: readonly string[];
  /** Why this node has the form it does — read before changing one. */
  readonly why?: string;
}

/**
 * The declared graph. Edges are cross-checked against the repo by the test; forms
 * are a design decision and live only here.
 */
export const DISPATCH_GRAPH: readonly DispatchNode[] = [
  // ── /ace:run — the 10-phase pipeline ────────────────────────────────────
  {
    name: 'ace-orchestrator',
    form: 'inline',
    owner: 'ace',
    dispatches: [
      'idea-to-design',
      'scenarios-and-acceptance',
      'commcare-setup',
      'connect-setup',
      'ocs-setup',
      'qa-and-training',
      'synthetic-data-and-workflows',
      'solicitation-management',
      'execution-manager',
      'closeout',
    ],
    why:
      'Inline keeps the whole pipeline at level 0, which is what leaves room for ' +
      'the Phase 7 chain (synthetic → canopy:ddd → canopy:visual-judge) to reach ' +
      'depth 2 inside a budget of 3. Making the orchestrator a subagent pushes that ' +
      'chain to depth 4 and silently disables the per-scene judges.',
  },
  { name: 'idea-to-design', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'scenarios-and-acceptance', form: 'subagent', owner: 'ace', dispatches: [] },
  {
    name: 'commcare-setup',
    form: 'subagent',
    owner: 'ace',
    dispatches: ['nova:nova-architect-autonomous'],
    why:
      'Was inline until 0.13.1018, solely because Claude Code withheld Agent from ' +
      'subagents and Step 1 dispatches nova:nova-architect-autonomous via ' +
      '/nova:autobuild. Nesting is allowed now and the chain lands at depth 2, so ' +
      'the phase gets its own context window back — it was the heaviest thing in ' +
      "the orchestrator's.",
  },
  { name: 'connect-setup', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'ocs-setup', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'qa-and-training', form: 'subagent', owner: 'ace', dispatches: [] },
  {
    name: 'synthetic-data-and-workflows',
    form: 'inline',
    owner: 'ace',
    dispatches: ['canopy:ddd'],
    why:
      'Step 3 dispatches the DDD render+converge loop, which fans out per-scene ' +
      'judges of its own. This is the deepest chain in ACE and sets the budget.',
  },
  { name: 'solicitation-management', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'execution-manager', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'closeout', form: 'subagent', owner: 'ace', dispatches: [] },

  // ── Other entry points ──────────────────────────────────────────────────
  {
    name: 'demo',
    form: 'inline',
    owner: 'ace',
    dispatches: ['canopy:ddd'],
    why: 'Hands the demo narrative to the DDD loop; same chain as Phase 7.',
  },
  {
    name: 'partnership-video',
    form: 'inline',
    owner: 'ace',
    dispatches: ['nova:autobuild'],
    why:
      'The ONLY Agent dispatch this procedure makes: partnership-microdemo calls ' +
      'Agent(nova:autobuild) for a tailored mock. Its three siblings — ' +
      'Skill(deep-research), Skill(canopy:walkthrough), ' +
      'Skill(canopy:walkthrough-share) — are SKILLS and run inline in their ' +
      'invoker, costing nothing (agents/partnership-video.md § How Agent / Skill ' +
      'dispatches work). Any Agent fan-out deep-research does of its own leaves ' +
      'from this level and is not enumerated here. nova:autobuild is the ' +
      'expensive one: it goes through the autobuild SKILL as a subagent, which ' +
      'then dispatches the architect — two levels, not one.',
  },
  {
    name: 'sweep',
    form: 'inline',
    owner: 'ace',
    // All eight, not the two written as `Agent(x)` literals. agents/sweep.md
    // names the per-system skills in a TABLE (`| ocs | sweep-ocs |`), so the
    // repo scan cannot see them: six edges were undeclared from 0.13.1005 to
    // 0.13.1038. They are all leaves, so the depth number never moved — but
    // "the declared graph is silent about six real edges" is the exact defect
    // 0.13.1026 fixed on the artifact manifest, and a future non-leaf here
    // would have been invisible to the budget.
    dispatches: [
      'sweep-live-set',
      'sweep-drive',
      'sweep-connect',
      'sweep-ocs',
      'sweep-hq',
      'sweep-labs',
      'sweep-opp-runs',
      'sweep-ace-web',
    ],
    why:
      'agents/sweep.md § Notes: "the procedure doc is the only thing that calls ' +
      'Agent"; commands/sweep.md executes it inline. CLAUDE.md listed it as a ' +
      'subagent until 2026-08-26 — a drift this graph now fences.',
  },
  {
    name: 'iterate-loop',
    form: 'inline',
    owner: 'ace',
    dispatches: ['ace-fix-and-ship'],
    why: 'Dispatches one fix+ship subagent per dirty run (agents/iterate-loop.md Step 6).',
  },
  { name: 'ocs-tester', form: 'subagent', owner: 'ace', dispatches: [] },

  // ── Leaf subagents dispatched from ACE skills ───────────────────────────
  {
    name: 'sweep-live-set',
    form: 'subagent',
    owner: 'ace',
    dispatches: [],
    why: 'A skill dispatched as a subagent by agents/sweep.md; leaf by design.',
  },
  { name: 'sweep-drive', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'sweep-connect', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'sweep-ocs', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'sweep-hq', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'sweep-labs', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'sweep-opp-runs', form: 'subagent', owner: 'ace', dispatches: [] },
  { name: 'sweep-ace-web', form: 'subagent', owner: 'ace', dispatches: [] },
  {
    name: 'ace-fix-and-ship',
    form: 'subagent',
    owner: 'external',
    dispatches: [],
    why: 'Generic coding subagent, not a named ACE agent file.',
  },

  // ── External plugin nodes ───────────────────────────────────────────────
  {
    name: 'nova:nova-architect-autonomous',
    form: 'subagent',
    owner: 'external',
    dispatches: [],
  },
  {
    name: 'nova:autobuild',
    form: 'subagent',
    owner: 'external',
    dispatches: ['nova:nova-architect-autonomous'],
    why:
      'Dispatched as a subagent by partnership-microdemo. It is a SKILL, so it runs ' +
      'inline once dispatched — but it then dispatches the architect, so the pair ' +
      'costs two levels, not one. Phase 3 reaches the architect more cheaply by ' +
      'invoking /nova:autobuild as a skill rather than as a subagent.',
  },
  {
    name: 'canopy:ddd',
    form: 'subagent',
    owner: 'external',
    dispatches: ['canopy:visual-judge'],
    why:
      'ddd-concept-eval runs inline inside the DDD loop and dispatches ' +
      'canopy:visual-judge once per scene. The DDD agent also spawns investigation ' +
      'and specialist-fixer subagents, all at the same level as visual-judge.',
  },
  { name: 'canopy:visual-judge', form: 'subagent', owner: 'external', dispatches: [] },
];

/**
 * Nodes a human or command can start from. Every chain is measured from one of
 * these at level 0.
 */
export const ENTRY_POINTS: readonly string[] = [
  'ace-orchestrator',
  'demo',
  'partnership-video',
  'sweep',
  'iterate-loop',
  'ocs-tester',
];

export interface Chain {
  /** Node names from the entry point down, inclusive. */
  readonly path: readonly string[];
  /** Levels below the main conversation the last node sits at. */
  readonly depth: number;
}

function byName(graph: readonly DispatchNode[]): Map<string, DispatchNode> {
  return new Map(graph.map((n) => [n.name, n]));
}

/** Cost of entering a node: a subagent costs a level, an inline procedure doc doesn't. */
function cost(node: DispatchNode): number {
  return node.form === 'subagent' ? 1 : 0;
}

/**
 * Every root-to-leaf chain reachable from `entry`, with the depth its last node
 * sits at. Cycles are cut (a node already on the current path is not re-entered)
 * so a malformed graph yields a finite answer rather than hanging the suite.
 */
export function chainsFrom(
  entry: string,
  graph: readonly DispatchNode[] = DISPATCH_GRAPH,
): Chain[] {
  const nodes = byName(graph);
  const out: Chain[] = [];

  function walk(name: string, path: string[], depth: number): void {
    const node = nodes.get(name);
    if (!node) {
      // Undeclared target — the test reports it; record the partial chain so the
      // depth number stays honest rather than silently short.
      out.push({ path: [...path, name], depth });
      return;
    }
    const nextDepth = depth + cost(node);
    const nextPath = [...path, name];
    const onward = node.dispatches.filter((d) => !nextPath.includes(d));
    if (onward.length === 0) {
      out.push({ path: nextPath, depth: nextDepth });
      return;
    }
    for (const d of onward) walk(d, nextPath, nextDepth);
  }

  walk(entry, [], 0);
  return out;
}

/** Every chain from every entry point, deepest first. */
export function allChains(graph: readonly DispatchNode[] = DISPATCH_GRAPH): Chain[] {
  return ENTRY_POINTS.flatMap((e) => chainsFrom(e, graph)).sort((a, b) => b.depth - a.depth);
}

/** The deepest chain's depth — the number that has to fit the budget. */
export function maxDepth(graph: readonly DispatchNode[] = DISPATCH_GRAPH): number {
  return allChains(graph).reduce((m, c) => Math.max(m, c.depth), 0);
}

/** Human-readable listing, for `/ace:doctor` and for test failure messages. */
export function formatChains(graph: readonly DispatchNode[] = DISPATCH_GRAPH): string {
  return allChains(graph)
    .map((c) => `  L${c.depth}  ${c.path.join(' → ')}`)
    .join('\n');
}
