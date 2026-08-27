/**
 * Prose must not contradict the declared form of a node.
 *
 * `lib/agent-depth.ts` says whether each node is `inline` or `subagent`. The
 * docs say it too, in English, in a dozen places — and the English is what an
 * agent actually reads mid-run. When a node changes form, the declaration and
 * the tests move with it and the prose quietly doesn't.
 *
 * That is not hypothetical. Phase 3 became a subagent in 0.13.1018 and TWO
 * hand-written grep sweeps still left eight live sentences calling it an inline
 * procedure doc — including `CLAUDE.md`'s own layout section, which every
 * session loads. The sweeps missed them because each sentence phrased it
 * differently ("inline procedure docs", "'s inline procedure", "executes inline
 * at level 0", "the Phase 3 procedure doc"), and a pattern written from three
 * examples does not match the fourth.
 *
 * So the check is the other way round: don't try to enumerate the phrasings,
 * enumerate the NODES — that list is already declared — and flag any live doc
 * that puts a contradicting word near one of their names.
 *
 * Measured against the real thing: replaying all eight 0.13.1018 sentences,
 * this catches the six that assert a form in prose. The two it does not are
 * "the only inline constraint is Phase 3" and "dispatches Nova at level-0",
 * which name no form word at all — a reminder that this is a net, not a proof.
 *
 * Deliberately narrow. It only fires on the two words that denote form
 * ("inline", "procedure doc") within a short window of a node name, and only
 * for nodes whose declared form makes that word wrong. Historical records
 * (CHANGELOG, superseded plans) are exempt: they are supposed to describe how
 * things used to be.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPATCH_GRAPH } from '../../lib/agent-depth.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Docs that describe history and may legitimately use stale wording. */
const HISTORICAL = [
  'CHANGELOG.md',
  'docs/superpowers/plans/',
  'docs/superpowers/specs/',
  'docs/agent-history.md',
  'docs/learnings/',
];

/**
 * Phrases that actually denote a node's FORM.
 *
 * Deliberately not the bare word "inline", which is overloaded here — "Inputs
 * (inline at handoff)" means passed in the message, "inline QA" is a QA mode,
 * neither is about dispatch. A first cut on the bare word produced 11 hits, 10
 * of them false. These are the collocations that mean "this node is not
 * dispatched."
 */
const FORM_PHRASES: RegExp[] = [
  /\bprocedure[- ]docs?\b/i,
  /\binline procedure\b/i,
  /\b(?:executes?|executed|runs?|run|reads? it)\s+inline\b/i,
  /\binline (?:execution|constraint)\b/i,
];

/**
 * Lines exempt by inspection, matched on a distinctive fragment.
 *
 * These are name-collision artifacts: `sweep-live-set` and `sweep-connect` are
 * subagents whose names contain `sweep`, which is inline — so a sentence about
 * `sweep`'s form always sits next to a subagent's name.
 *
 * An earlier version handled this with a rule ("skip any line that also names
 * an inline node") and that rule was WRONG in the expensive direction: it also
 * suppressed `two procedure docs (ace-orchestrator, commcare-setup)` — a list
 * containing one inline node and one that had moved out, which is precisely the
 * shape this test exists to catch. Replayed against the real 0.13.1018
 * staleness it caught 1 of 3. An explicit, reviewable exemption beats a clever
 * rule that silently drops the main case.
 */
const ALLOWED: string[] = [
  '| `sweep` | inline |', // CLAUDE.md topology row: describes `sweep`, names `sweep-live-set`
  'The procedure doc is the only thing that calls', // agents/sweep.md § Notes: same collision
];

/** Live markdown, excluding historical records and vendored trees. */
function liveDocs(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const rel = path.relative(REPO_ROOT, p);
        if (!HISTORICAL.some((h) => rel.startsWith(h))) out.push(rel);
      }
    }
  })(REPO_ROOT);
  return out;
}

/**
 * Phrases that assert the RETIRED pre-v2.1.219 rule: that the `Agent` tool is
 * unavailable to subagents, so nesting is impossible.
 *
 * 0.13.1005 replaced that ban with a budget, and 0.13.1018 moved Phase 3 across
 * it. Two live docs still asserted the ban nine PRs later — `commands/demo.md`
 * and `agents/synthetic-data-and-workflows.md`, the second being Phase 7's own
 * doc, the node the whole depth argument hinges on. The 0.13.1005 sweep listed
 * "eleven live docs"; it fixed nine.
 *
 * Deliberately NOT the bare string "level 0", which is still correct in plenty
 * of places ("dispatched via `Agent(...)` from level 0" describes the
 * DISPATCHER and is true). Only the claims that nesting cannot happen.
 */
const RETIRED_RULE: RegExp[] = [
  /available only at level 0/i,
  /only available at level 0/i,
  // Scoped to the AGENT tool on purpose. `AskUserQuestion` really IS withheld
  // from every subagent, and that sentence is live and correct in
  // orchestrator-reference.md — an unscoped pattern flags it.
  /\bAgent\b[^.\n]{0,60}\bunavailable to subagents\b/i,
  /\bAgent\b[^.\n]{0,60}\bwithheld from every subagent\b/i,
  /never two levels of/i,
  /(?:push|put)(?:ing)? (?:those |these |that |them )?(?:dispatch\w*|call\w*) (?:to|at) level 2/i,
  /(?:to|at) level 2 and (?:fail|break)/i,
];

/**
 * Claims that a node itself runs at level 0 — the depth-coded spelling.
 *
 * In the Phase 3 chain "level 0" never meant a dispatch depth at all: it meant
 * "ACE's own Nova MCP surface, as opposed to the architect subagent's". When
 * Phase 3 became a subagent in 0.13.1018 the distinction survived and the
 * spelling did not, leaving 22 sentences — including a halt message ACE is
 * instructed to emit verbatim — naming a level the phase no longer runs at.
 * Re-spelled `ACE-direct` in 0.13.1032.
 */
const SELF_LEVEL_ZERO: RegExp[] = [
  /\bat LEVEL[- ]0\b/,
  /\bruns? at level 0\b/i,
  /\bexecutes? (?:inline )?at level 0\b/i,
  /\blevel-0(?:-direct)? (?:session|connection|steps?|recipe|heal|safety net|Claude)\b/i,
  /\bavailable to the level-0\b/i,
  /\bwhy level 0 and not\b/i,
  /\bbind(?:ing)?(?: check)? at level 0\b/i,
  /\bdid not bind at level 0\b/i,
];

/** Sanctioned past-tense / superseded framing for a live doc describing history. */
const PAST_TENSE =
  /\b(?:was|were|had been|until|no longer|retired|superseded|originally|joined the subagents|do not reintroduce)\b/i;

/**
 * Files a declared subagent owns: its own `agents/<name>.md` plus every
 * `skills/<s>/SKILL.md` named in that agent's `skills:` frontmatter. This is
 * the net that matters — the Phase 3 staleness lived in the SKILLS, not in the
 * agent doc, and a check scoped to `agents/` alone would have found 7 of 22.
 */
function filesOwnedBy(agentName: string): string[] {
  const agentRel = path.join('agents', `${agentName}.md`);
  const agentAbs = path.join(REPO_ROOT, agentRel);
  if (!fs.existsSync(agentAbs)) return [];
  const out = [agentRel];
  const fm = fs.readFileSync(agentAbs, 'utf8').split('---')[1] ?? '';
  for (const m of fm.matchAll(/\{\s*name:\s*([a-z0-9-]+)/g)) {
    const rel = path.join('skills', m[1], 'SKILL.md');
    if (fs.existsSync(path.join(REPO_ROOT, rel))) out.push(rel);
  }
  return out;
}

describe('retired invariant', () => {
  it('no live doc still says subagents cannot dispatch', () => {
    const violations: string[] = [];
    for (const rel of liveDocs()) {
      fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) return;
          if (!RETIRED_RULE.some((re) => re.test(line))) return;
          if (PAST_TENSE.test(line)) return;
          violations.push(`  ${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
        });
    }
    expect(
      violations,
      'These live docs assert the pre-v2.1.219 rule that the `Agent` tool is\n' +
        'unavailable to subagents. It was retired in 0.13.1005 and replaced by the\n' +
        'depth budget in lib/agent-depth.ts. Nesting is legal; the constraint is a\n' +
        'number. If the sentence is about history, phrase it in the past tense.\n\n' +
        violations.join('\n'),
    ).toEqual([]);
  });
});

describe('depth-coded prose in a subagent’s own files', () => {
  const subagentDocs = DISPATCH_GRAPH.filter((n) => n.form === 'subagent' && n.owner === 'ace')
    .flatMap((n) => filesOwnedBy(n.name).map((f) => [n.name, f] as const));

  it('has files to check', () => {
    // Empty either side passes the real assertion while checking nothing. The
    // frontmatter parse is the fragile half — if `skills:` moves, this drops to
    // agents/ only and silently stops covering the case it exists for.
    expect(subagentDocs.length, 'no subagent-owned files resolved').toBeGreaterThan(10);
    expect(
      subagentDocs.filter(([, f]) => f.startsWith('skills/')).length,
      'no skill files resolved from agent frontmatter — did `skills:` change shape?',
    ).toBeGreaterThan(5);
  });

  it('never claims a declared subagent runs at level 0', () => {
    const violations: string[] = [];
    for (const [node, rel] of subagentDocs) {
      fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) return;
          if (!SELF_LEVEL_ZERO.some((re) => re.test(line))) return;
          if (PAST_TENSE.test(line)) return;
          violations.push(`  ${rel}:${i + 1}  (owned by ${node})  ${line.trim().slice(0, 110)}`);
        });
    }
    expect(
      violations,
      'These files belong to a node declared `subagent` in lib/agent-depth.ts, and\n' +
        'say it runs at level 0. It does not. In the Phase 3 chain this spelling never\n' +
        'meant a dispatch depth — it meant "ACE\'s own MCP surface, not the architect\n' +
        'subagent\'s". Say that instead (`ACE-direct`), so the sentence survives the\n' +
        'next form change.\n\n' + violations.join('\n'),
    ).toEqual([]);
  });
});

describe('declared form vs. prose', () => {
  const subagents = DISPATCH_GRAPH.filter(
    (n) => n.form === 'subagent' && n.owner === 'ace',
  ).map((n) => n.name);

  it('has nodes and docs to check', () => {
    // An empty either side would pass the real assertion while checking nothing.
    expect(subagents.length, 'no ACE subagents declared').toBeGreaterThan(0);
    expect(liveDocs().length, 'no live docs found').toBeGreaterThan(20);
  });

  it('never calls a declared subagent an inline procedure doc', () => {
    const violations: string[] = [];

    for (const rel of liveDocs()) {
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        // A dated table row is a changelog entry, even inside a live file.
        if (/^\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) return;
        if (ALLOWED.some((frag) => line.includes(frag))) return;

        for (const name of subagents) {
          if (!line.includes(name)) continue;
          // The phrase has to sit next to the name, not merely on the same
          // line. Calibrated: 90 pulled in "agents/ (procedure docs +
          // subagents)" from half a sentence away; 40 was too tight to reach
          // across a two-item list. 60 catches all six of the real 0.13.1018
          // stale sentences with no false positive on the current tree.
          const idx = line.indexOf(name);
          const window = line.slice(Math.max(0, idx - 60), idx + name.length + 60);
          const wrong = FORM_PHRASES.some((re) => re.test(window));
          if (!wrong) continue;
          // An explicit past-tense marker is the sanctioned way to say
          // "it used to be inline" in a live doc.
          if (/\bwas\b|\bhad been\b|\buntil\b|\bno longer\b|\bjoined the subagents\b/i.test(window))
            continue;
          violations.push(`  ${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
        }
      });
    }

    expect(
      violations,
      'These live docs describe a declared SUBAGENT as inline / a procedure doc.\n' +
        'lib/agent-depth.ts is the source of truth for form; fix the prose (or, if\n' +
        'the sentence is about history, phrase it in the past tense).\n\n' +
        violations.join('\n'),
    ).toEqual([]);
  });
});
