/**
 * The `Agent` tool is NOT unavailable to subagents. A subagent may dispatch
 * subagents, bounded by `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`.
 *
 * That was not always true, and the retired rule keeps coming back in prose.
 * It has now been swept twice — 0.13.1005 (eleven docs, nine fixed) and
 * 0.13.1032 — and both times a live doc survived asserting the ban outright:
 * `agents/demo.md` ("the `Agent` tool, available only at level 0") and
 * `playbook/opp-run-with-canopy.md` ("Lens runners are Agents at level 0. They
 * can't dispatch further Agents"). CHANGELOG 0.13.1032 announced this very
 * detector as a "retired invariant" check; it was never written. This is it.
 *
 * Why it matters more than tidiness: an agent that believes it cannot dispatch
 * reshapes its plan around the belief. A live session was observed splitting a
 * skill in two "to keep canopy:ddd at the same depth" — real work spent
 * conserving a budget that was never tight.
 *
 * SCOPED TO THE `Agent` TOOL ON PURPOSE. `AskUserQuestion` genuinely IS withheld
 * from every subagent, and that sentence is live and correct in several docs —
 * so any line mentioning it is exempt. Likewise the TRUE current statement that
 * Claude Code withholds `Agent` *at the depth limit* is not a ban and is not
 * matched here; only unconditional claims are.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Live instruction surfaces. CHANGELOG and dated specs/plans keep the history. */
const ROOTS = ['agents', 'skills', 'commands', 'playbook'];

/** Unconditional assertions that the Agent tool cannot be used below level 0. */
const RETIRED_BAN = [
  /\bavailable only at level 0\b/i,
  /\bonly (?:available|legal|possible|allowed) at level 0\b/i,
  /\bcan(?:no|')?t dispatch (?:any )?(?:further|more|other|additional) [Aa]gents?\b/i,
  /\bcannot dispatch (?:any )?(?:further|more|other|additional) [Aa]gents?\b/i,
  /\b(?:sub)?agents? (?:have|has) no `?Agent`? tool\b/i,
  /\b`?Agent`? tool is (?:unavailable|not available) to (?:every )?(?:sub)?agents?\b/i,
  /\bsubagents? (?:can(?:no|')?t|cannot) (?:call|use|reach) the `?Agent`? tool\b/i,
  /\bnever two levels of (?:`?Agent`?|dispatch)\b/i,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

function liveDocs(): string[] {
  const files = ROOTS.flatMap((r) => {
    try {
      return walk(join(REPO, r));
    } catch {
      return [];
    }
  });
  return [...files, join(REPO, 'CLAUDE.md')];
}

describe('the retired "Agent is level-0 only" ban', () => {
  const docs = liveDocs();

  it('finds live docs to check', () => {
    expect(docs.length).toBeGreaterThan(50);
  });

  it('is asserted by no live doc', () => {
    const violations: string[] = [];

    for (const file of docs) {
      const rel = file.slice(REPO.length + 1);
      const raw = readFileSync(file, 'utf8');

      // Scan SENTENCES over normalized whitespace, not lines. The canonical
      // violation wrapped mid-claim ("the `Agent` tool, available only\nat level
      // 0"), so a line-based scan misses exactly the case this test exists for.
      // Paragraph offsets give an honest line number for the report.
      let offset = 0;
      for (const para of raw.split(/\n\s*\n/)) {
        const line = raw.slice(0, offset).split('\n').length;
        const flat = para.replace(/\s+/g, ' ');
        for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
          // AskUserQuestion IS withheld from subagents — live and correct.
          if (/AskUserQuestion/i.test(sentence)) continue;
          if (RETIRED_BAN.some((re) => re.test(sentence))) {
            violations.push(`${rel}:~${line}  ${sentence.trim().slice(0, 120)}`);
          }
        }
        offset += para.length + 2;
      }
    }

    expect(
      violations,
      'A live doc asserts the RETIRED rule that the `Agent` tool is unavailable ' +
        'below level 0. Subagents may dispatch subagents; the constraint is a ' +
        'depth BUDGET (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH), not a ban.\n\n' +
        'State the current behaviour instead: past the budget the Agent tool is ' +
        'withheld SILENTLY, so a fan-out collapses rather than erroring. If the ' +
        'doc means the human gate, say AskUserQuestion — that one really is ' +
        'withheld from every subagent.\n\n' +
        'See CLAUDE.md § Agent topology.\n\n' +
      violations.join('\n'),
    ).toEqual([]);
  });
});
