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
 * EMPTY as of ace#1884, and it should stay that way. It previously held
 * `skills/README.md` — the skill-AUTHOR contract, and the surface the removed
 * class kept regrowing from, since a new skill's author copies its
 * `## Products` example, its artifact-naming table, and its author checklist
 * verbatim. That is now rewritten, so the exemption is gone.
 *
 * Do NOT add entries here to make a failure go away. An allowlisted contract
 * file is how three prior sweeps each left the next one work to do.
 */
const ALLOWLIST = new Set<string>([]);

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

/**
 * The PROSE half of the class (ace#1884). The filename regex above only sees
 * `*gate-brief*.md`; it is blind to `surface a [WARN] in the gate brief`,
 * `write to the gate brief:`, `halt with a [BLOCKER] in the gate brief` —
 * which is what 15 files still said after the ace#1880 filename sweep called
 * the removal complete. Those are live directives pointing an agent at a
 * destination that does not exist, and they are how the class regrows without
 * ever spelling a path.
 *
 * Deliberately narrow: it matches a PREPOSITION immediately before the term,
 * i.e. the gate brief as a DESTINATION. Talking ABOUT the removal ("the
 * producer no longer authors a separate gate-brief artifact", "0.13.116
 * removed the gate-brief write step", a `## Gate Brief — reference only`
 * heading) has no preposition and passes, as it should.
 *
 * Known scope limit: a bare noun mention with no preposition — `Eval surfaces
 * (gate briefs, WARN/INFO)`, fixed by hand in this same PR — is NOT caught.
 * Widening the regex to bare mentions would flag every retirement note in the
 * tree, which is the opposite of useful. The destination form is the one that
 * misdirects an agent mid-run, so that is what is gated.
 */
const GATE_BRIEF_DESTINATION_RE = /\b(?:in|into|to|from|for)\s+(?:the\s+|a\s+|an\s+)?gate[\s-]?brief(?:'s)?\b/i;

function scan(dirs: string[], re: RegExp): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    for (const rel of markdownFiles(dir)) {
      if (ALLOWLIST.has(rel)) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const commented = htmlCommentLines(src);
      src.split('\n').forEach((line, i) => {
        if (!re.test(line)) return;
        if (commented.has(i + 1)) return;
        if (isChangeLogRow(line)) return;
        found.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return found;
}

function violations(dirs: string[]): string[] {
  return scan(dirs, GATE_BRIEF_FILENAME_RE);
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

  it('no file under skills/ or commands/ names the gate brief as a DESTINATION', () => {
    expect(
      scan(['skills', 'commands'], GATE_BRIEF_DESTINATION_RE),
      'a SKILL.md or command doc tells an agent to put something IN / INTO / TO a ' +
        'gate brief. 0.13.116 removed that destination — the orchestrator synthesizes the ' +
        'pause summary from the QA + eval verdict YAMLs, so a concern routed "to the gate ' +
        'brief" is routed nowhere. Put it in the verdict YAML\'s `auto_surfaced` block ' +
        'instead. Explaining the removal is fine and does not match this check (ace#1884).',
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

    // Destination check: POSITIVE controls — the real strings this PR removed.
    for (const line of [
      'program and surface a `[WARN]` line in the gate brief if any',
      'For each opp where `active=true`, write to the gate brief:',
      '**If any check fails, halt with a `[BLOCKER]` in the gate brief.**',
      'Every eval emits auto-surfaced concerns into the gate brief using',
      "captures this URL for the gate brief's `Decisions Log:` line.",
    ]) {
      expect(GATE_BRIEF_DESTINATION_RE.test(line), `should flag: ${line}`).toBe(true);
    }

    // Destination check: NEGATIVE controls — talking ABOUT the removal, which
    // every retirement note in the tree does and which must keep passing.
    for (const line of [
      'The producer no longer authors a separate gate-brief artifact.',
      '## Gate Brief — reference only, NOT an artifact this skill writes',
      '0.13.116: gate-brief write step removed. The orchestrator composes',
      '`lib/artifact-manifest.ts` registers no gate-brief artifact.',
      '**This skill writes no gate-brief file.** The write step was removed in',
      '### `## Gate Brief` — OPTIONAL, and never an artifact',
    ]) {
      expect(GATE_BRIEF_DESTINATION_RE.test(line), `should NOT flag: ${line}`).toBe(false);
    }
  });
});
