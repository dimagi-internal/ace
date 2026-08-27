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
