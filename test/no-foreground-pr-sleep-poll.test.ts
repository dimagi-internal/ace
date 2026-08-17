import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Class-level preventer for the hand-rolled PR wait.
 *
 * ACE had no shipping skill, so every dispatcher re-invented "wait for the PR"
 * as a foreground poll loop — and `agents/orchestrator-reference.md` prescribed
 * one verbatim. That shape does not work: a foreground `sleep` used to wait is
 * blocked by the harness Bash contract, and the fallback burns the full 10-minute
 * Bash timeout (`Exit code 143`) on a PR that merges in ~70 seconds.
 *
 * Reproducer (2026-08-17):
 *   $ sleep 30; echo hi
 *   Blocked: sleep 30 followed by: echo hi. To wait for a condition, use Monitor
 *   with an until-loop ... To wait for a command you started, use
 *   run_in_background: true. Do not chain shorter sleeps to work around this block.
 *
 * The mechanics now live in one place — `skills/shipping` — and this test keeps
 * them there. See CLAUDE.md § Class-level preventers > instance-level fixes.
 */

const ROOTS = ['agents', 'skills', 'commands'];

/** The one file allowed to show the blocked shape: the skill that documents it. */
const ALLOWED = new Set(['skills/shipping/SKILL.md']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r)).filter((f) => !ALLOWED.has(f));

describe('no hand-rolled foreground PR-wait loops', () => {
  it('no agent/skill/command doc prescribes a `sleep`-poll loop around a PR state check', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // A poll loop: `until`/`while`/`for` + a gh PR read + a sleep, within a
        // small window. Match the sleep line, then look back a few lines for the
        // loop head and the gh call.
        const sleepMatch = /\bsleep\s+(\d+)/.exec(line);
        if (!sleepMatch) return;
        const seconds = Number(sleepMatch[1]);
        if (seconds < 10) return; // short sleeps aren't the waiting-loop class

        const window = lines.slice(Math.max(0, i - 6), i + 3).join('\n');
        const hasLoop = /\b(until|while|for)\b/.test(window);
        const hasPrRead = /gh\s+pr\s+(view|checks|status)/.test(window);
        if (hasLoop && hasPrRead) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Hand-rolled foreground PR-wait loop(s) found. A foreground \`sleep\` used to wait ` +
        `is blocked by the harness, and the fallback burns the 10-min Bash timeout. ` +
        `Delegate to skills/shipping § Step 2 (one backgrounded command that exits on ` +
        `the condition) instead of inlining a poll loop:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('skills/shipping exists and documents the backgrounded wait', () => {
    const skill = readFileSync('skills/shipping/SKILL.md', 'utf8');
    expect(skill).toMatch(/run_in_background/);
    expect(skill).toMatch(/gh pr checks .*--watch/);
    // The ship checkpoint — merge state stated explicitly, never implied.
    expect(skill).toMatch(/MERGED/);
    expect(skill).toMatch(/ship checkpoint/i);
  });

  it('the fix-and-ship dispatch template delegates rather than inlining a wait', () => {
    const ref = readFileSync('agents/orchestrator-reference.md', 'utf8');
    const section = ref.slice(ref.indexOf('## Fix-and-ship subagent template'));
    const body = section.slice(0, section.indexOf('\n## ', 3));
    expect(body).toMatch(/skills\/shipping/);
  });
});
