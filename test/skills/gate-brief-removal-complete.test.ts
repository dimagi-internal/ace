import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CLASS-LEVEL PREVENTER — 0.13.116 removed the `<skill>_gate-brief[-<mode>].md`
// artifact across every phase. `lib/artifact-manifest.ts` registers none, and
// the orchestrator synthesizes pause-time summaries from the per-skill QA +
// eval verdict YAMLs instead (agents/orchestrator-reference.md § Pause Points).
//
// That removal has now been swept THREE times and regrown twice, because each
// sweep looked at one directory:
//
//   * 2026-05-25 — five stale producer-side "do this" instructions found in
//     `agents/`. Cleaned, and gated by `test/agents/coherence.test.ts`'s
//     "no agent file outside the reference doc carries `*gate-brief*.md`
//     instruction text". That test reads AGENTS_DIR and nothing else.
//   * 2026-08-29 (ace#1805) — `skills/ocs-chatbot-eval` was still declaring
//     gate-brief outputs in its frontmatter, `## Products` and BOTH `## Modes`
//     rows, and contradicting itself about which modes emit them. Its own body
//     asked for "a grep for the same stale contract in the other -eval skills".
//   * 2026-09-01 (ace#1880) — that grep had never been run. `commands/qa-deep.md`
//     still listed `ocs-chatbot-eval_gate-brief-deep.md` as a Stage A output;
//     `commands/eval.md`, `skills/opp-eval`, `skills/idea-to-pdd-eval`,
//     `skills/app-release` and `skills/llo-launch` all still pointed at paths
//     that have not existed since 0.13.116 — `app-release` routing its
//     build-rejection and slug-collision BLOCKERs into one of them.
//
// So the gate is extended here to the two directories nobody was watching.
// It matches the ARTIFACT FILENAME SHAPE, not prose: explaining the removal is
// fine, pointing an agent at a path that does not exist is not.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * `foo_gate-brief.md`, `gate-brief-deep.md`, `<skill>_gate-brief[-<mode>].md`.
 * The optional bracket group catches the templated form used in contract docs,
 * which is the same instruction with a placeholder in it.
 */
const GATE_BRIEF_FILENAME_RE = /gate-brief[\w-]*(?:\[[^\]\n]*\])?\.md/;

/**
 * Files whose remaining mentions are a KNOWN, deliberate residual rather than
 * an instruction. Mirrors `coherence.test.ts`'s `orchestrator-reference.md`
 * allowance.
 *
 * `skills/README.md` is the skill-AUTHOR contract, and it still documents
 * gate-brief as a live artifact class in its artifact-naming table, its
 * `## Gate Brief` section spec, and its author checklist — i.e. it is the
 * surface from which the class keeps regrowing. Rewriting that contract is a
 * judgment call about what replaces it, not a mechanical path fix, so it is
 * deliberately left to a follow-up rather than bundled into the ace#1880
 * sweep. Remove this entry when that lands; do NOT add new entries here to
 * make a failure go away.
 */
const ALLOWLIST = new Set<string>(['skills/README.md']);

/** Collect every `.md` under a directory, recursively, repo-relative. */
function markdownFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(rel));
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/**
 * A `## Change Log` table row — `| 2026-05-05 | … |`. History is a record of
 * what a file USED to do; it is not an instruction to do it again, and
 * rewriting it would be falsifying the log.
 */
function isChangeLogRow(line: string): boolean {
  return /^\s*\|\s*20\d\d-\d\d-\d\d\s*\|/.test(line);
}

/**
 * Lines inside an HTML comment. The 0.13.116 cleanup deliberately left
 * `<!-- 0.13.116: legacy `…_gate-brief.md` removed. -->` markers in place so a
 * reader who remembers the artifact learns where it went. Naming a path in
 * order to say it is GONE is the opposite of the defect.
 */
function htmlCommentLines(src: string): Set<number> {
  const inside = new Set<number>();
  let open = false;
  src.split('\n').forEach((line, i) => {
    const opens = line.includes('<!--');
    const closes = line.includes('-->');
    if (open || opens) inside.add(i + 1);
    if (opens && !closes) open = true;
    else if (closes) open = false;
  });
  return inside;
}

function violations(dirs: string[]): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    for (const rel of markdownFiles(dir)) {
      if (ALLOWLIST.has(rel)) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const commented = htmlCommentLines(src);
      src.split('\n').forEach((line, i) => {
        if (!GATE_BRIEF_FILENAME_RE.test(line)) return;
        if (commented.has(i + 1)) return;
        if (isChangeLogRow(line)) return;
        found.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return found;
}

describe('0.13.116 gate-brief removal is complete (ace#1880, completing ace#1805)', () => {
  it('lib/artifact-manifest.ts registers no gate-brief artifact', () => {
    // The premise every assertion below rests on. If a gate-brief artifact is
    // ever REINTRODUCED as a real registered product, this test is the thing
    // that should be deleted — not silently worked around.
    const manifest = fs.readFileSync(path.join(ROOT, 'lib/artifact-manifest.ts'), 'utf-8');
    const declaring = manifest
      .split('\n')
      .filter((l) => /gate-brief/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(
      declaring,
      'lib/artifact-manifest.ts declares a gate-brief artifact — if that is intentional, ' +
        'this whole test file is obsolete and should be removed with the change.',
    ).toEqual([]);
  });

  it('no file under commands/ points at a `*gate-brief*.md` path', () => {
    expect(
      violations(['commands']),
      'a slash-command doc names a gate-brief artifact that 0.13.116 removed and the ' +
        'manifest does not register. An agent following it writes an orphan file into the ' +
        'run folder that nothing reads (ace#1880).',
    ).toEqual([]);
  });

  it('no file under skills/ instructs writing or reading a `*gate-brief*.md` path', () => {
    expect(
      violations(['skills']),
      'a SKILL.md names a gate-brief artifact that 0.13.116 removed and the manifest does ' +
        'not register. Explaining the removal is fine — put it in an HTML comment or a ' +
        'Change Log row, both of which this check skips. Pointing at the path as something ' +
        'to write or read is the defect (ace#1805, ace#1880).',
    ).toEqual([]);
  });

  it('the check can actually see a violation (negative control)', () => {
    // Guards the trivially-green failure mode: a regex that matches nothing
    // would pass all three assertions above forever.
    expect(GATE_BRIEF_FILENAME_RE.test('- ocs-chatbot-eval_gate-brief-deep.md')).toBe(true);
    expect(GATE_BRIEF_FILENAME_RE.test('`<skill>_gate-brief[-<mode>].md`')).toBe(true);
    expect(isChangeLogRow('| 2026-05-05 | wrote `opp-eval_gate-brief-deep.md` | ACE team |')).toBe(
      true,
    );
    expect(
      htmlCommentLines('<!-- 0.13.116: legacy `x_gate-brief.md` removed. -->\nplain line\n').has(1),
    ).toBe(true);
    expect(
      htmlCommentLines('<!-- 0.13.116: legacy `x_gate-brief.md` removed. -->\nplain line\n').has(2),
    ).toBe(false);
  });
});
