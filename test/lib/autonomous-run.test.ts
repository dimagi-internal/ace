/**
 * A `default`/`auto` run never ASKS, and always HALTS on a blocker.
 *
 * ## Two things that are easy to collapse, and must not be
 *
 * - **Asking a human a question and waiting.** ACE never does this outside
 *   `review` mode. Where it would prompt, it decides, records the decision, and
 *   proceeds. This is the operating stance: *"nothing should ever ask a question
 *   as a blocking operation as part of ACE… it should be making its best
 *   effort."*
 * - **Halting because something is broken.** ACE absolutely still does this. A
 *   `[BLOCKER]` stops the run.
 *
 * 0.13.1021 collapsed the two and converted the three `[BLOCKER]` checkpoints to
 * record-and-continue. That was wrong in the most expensive direction: a run
 * could reach the end with a known-broken artifact behind it, so **"the run
 * finished" stopped being evidence that anything worked** — which is the single
 * property an end-to-end run exists to establish. Corrected in 0.13.1023.
 *
 * The distinction is the reason this file has two opposing assertions rather
 * than one: no prompting, AND mandatory halting. Satisfying either alone is a
 * regression.
 *
 * (Renamed from `non-blocking-run.test.ts`, whose name asserted the error — runs
 * DO block on failure. They just never block on a person.)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORCH = ['agents/ace-orchestrator.md', 'agents/orchestrator-reference.md'];
const REF = 'agents/orchestrator-reference.md';

/** Rows of the checkpoint table: `| <point> | <phase> | default | review | auto |`. */
function checkpointRows(): string[][] {
  const ref = fs.readFileSync(path.join(REPO_ROOT, REF), 'utf8');
  return ref
    .split('\n')
    .filter((l) => /^\| (?:After|Before|\*\*Phase 8)/.test(l) && l.split('|').length >= 6)
    .map((l) => l.split('|').map((c) => c.trim()));
}

describe('autonomous run — never asks', () => {
  it('gates every orchestrator AskUserQuestion on review mode', () => {
    const offenders: string[] = [];
    for (const rel of ORCH) {
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('AskUserQuestion')) return;
        const ctx = lines.slice(Math.max(0, i - 4), i + 5).join(' ');
        if (/`review`|review mode|withheld from|subagent/i.test(ctx)) return;
        offenders.push(`  ${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
    }
    expect(
      offenders,
      'An AskUserQuestion not scoped to `review` makes a default/auto run wait on a\n' +
        'person. ACE decides and records instead.\n\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('never routes default or auto through a pause', () => {
    const rows = checkpointRows();
    expect(rows.length, 'checkpoint table not found — did it move?').toBeGreaterThan(4);
    const prompting = rows.filter(([, , , dflt, , auto]) => {
      // The em-dash exemption used to be `|—|` anywhere in the cell, which was
      // added for the `| — |` unreachable-phase rows and let any cell through
      // that happened to contain one: `pause — operator confirms` would have
      // passed. Now only a cell that IS an em dash (the not-applicable marker)
      // is exempt.
      const notApplicable = (v: string) => v.trim() === '—' || v.trim() === '';
      const bad = (v: string) =>
        !notApplicable(v) &&
        /\bpause\b/i.test(v) &&
        !/never pause|unreachable|terminus|no prompt/i.test(v);
      return bad(dflt) || bad(auto);
    });
    expect(
      prompting.map((r) => '  ' + r.join(' | ').slice(0, 110)),
      'These checkpoints route a default or auto run through a human pause.',
    ).toEqual([]);
  });
});

describe('autonomous run — always halts on a blocker', () => {
  it('halts default AND auto at every [BLOCKER] checkpoint', () => {
    // The counterpart to the assertion above, and the reason both are needed:
    // "no pause" is satisfiable by continuing past a blocker, which is the
    // 0.13.1021 regression. A blocker must stop the run in BOTH autonomous modes.
    const rows = checkpointRows().filter(([, point]) =>
      /idea-to-pdd|app-deploy|ocs-chatbot-eval/.test(point),
    );
    expect(rows.length, 'the three [BLOCKER] checkpoints were not found').toBe(3);

    const notHalting = rows.filter(([, , , dflt, , auto]) => {
      // `/\bhalts?\b/` alone is satisfied by "never halts" — the exact
      // sentence this test exists to reject. Require an affirmative halt and
      // reject a negated one.
      const halts = (v: string) => /\bhalts?\b/i.test(v) && !/\b(?:never|not|no)\s+halts?\b/i.test(v);
      return !halts(dflt) || !halts(auto);
    });
    expect(
      notHalting.map((r) => `  ${r[1]}: default="${r[3]}" auto="${r[5]}"`),
      'A [BLOCKER] must HALT the run in default and auto — not be recorded and\n' +
        'skipped past. If a run can finish with a blocker behind it, finishing stops\n' +
        'meaning anything. See this file’s header (0.13.1021 regression).',
    ).toEqual([]);
  });

  it('spells out the halt mechanics — blocked status, no prompt', () => {
    const ref = fs.readFileSync(path.join(REPO_ROOT, REF), 'utf8');
    expect(
      /status:\s*blocked/.test(ref),
      'the halt must name the write-back status (`blocked`), or the orchestrator has ' +
        'no defined way to record why it stopped',
    ).toBe(true);
  });
});
