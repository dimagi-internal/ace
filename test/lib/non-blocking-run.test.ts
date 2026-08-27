/**
 * `default` and `auto` runs never block on a question.
 *
 * ACE's operating stance, stated by its owner (2026-08-26): *"nothing should
 * ever ask a question as a blocking operation as part of ACE. Given the nature
 * of how ACE is supposed to work, it should be making its best effort."*
 *
 * `lib/decisions-schema.ts` v5 already encodes it — *"ACE still emits its best
 * estimate and keeps going either way; nothing blocks and there is no escalation
 * path."* The three `[BLOCKER]` pause points and the opp-selection prompt were
 * the last places that contradicted it, and they were converted in 0.13.1020.
 *
 * `review` mode is the deliberate exception: an operator opting into a human
 * checkpoint per phase is a request, not ACE volunteering a question.
 *
 * This guards the shape rather than the wording — an `AskUserQuestion` that
 * reappears in the orchestrator without `review` next to it is the regression.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORCH = ['agents/ace-orchestrator.md', 'agents/orchestrator-reference.md'];

describe('non-blocking run', () => {
  it('finds the orchestrator docs', () => {
    for (const f of ORCH) expect(fs.existsSync(path.join(REPO_ROOT, f)), f).toBe(true);
  });

  it('gates every orchestrator AskUserQuestion on review mode', () => {
    const offenders: string[] = [];
    for (const rel of ORCH) {
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('AskUserQuestion')) return;
        // The surrounding few lines must scope it to review mode.
        const ctx = lines.slice(Math.max(0, i - 4), i + 5).join(' ');
        if (/`review`|review mode|withheld from|subagent/i.test(ctx)) return;
        offenders.push(`  ${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
    }
    expect(
      offenders,
      'An AskUserQuestion in the orchestrator that is not scoped to `review` mode\n' +
        'blocks a default/auto run. ACE makes its best effort and records what it\n' +
        'found; it does not ask. See § Pause Points.\n\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('keeps default and auto off the pause path in the checkpoint table', () => {
    const ref = fs.readFileSync(path.join(REPO_ROOT, 'agents/orchestrator-reference.md'), 'utf8');
    const rows = ref
      .split('\n')
      .filter((l) => /^\| (?:After|Before|\*\*Phase 8)/.test(l) && l.split('|').length >= 6);
    expect(rows.length, 'checkpoint table rows not found — did the table move?').toBeGreaterThan(4);

    // Column 3 is `default`, column 5 is `auto`. Neither may say "pause"
    // unless it says it is unreachable or a terminus.
    const blocking = rows.filter((r) => {
      const c = r.split('|').map((x) => x.trim());
      const [dflt, auto] = [c[3], c[5]];
      const bad = (v: string) =>
        /\bpause\b/i.test(v) && !/never pause|unreachable|terminus|—/i.test(v);
      return bad(dflt) || bad(auto);
    });
    expect(
      blocking.map((r) => '  ' + r.trim().slice(0, 110)),
      'These checkpoints still pause a default or auto run.',
    ).toEqual([]);
  });
});
