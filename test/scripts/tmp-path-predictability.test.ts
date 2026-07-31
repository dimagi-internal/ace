import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPredictableSharedPath } from '../../lib/scratch-file.js';

// dimagi-internal/ace#1046 — mechanical drift detector, same shape as the
// existing doc-vs-code detectors.
//
// The near-miss was not a bug in any script's logic: `run-form-walk.ts`
// crashed rather than writing. The defect was the DOCUMENTED invocation
// (`--out /tmp/ace-hq-<app>.json`) naming a path shared across macOS users,
// plus a read that could not tell "my output" from "someone else's". Fixing
// the one skill that was bitten fixes today; this test is what catches the
// next script or SKILL to reintroduce the shape.
//
// Scope is deliberately narrow: WRITE DESTINATIONS only (`--out X`, `-o X`,
// `>X`). Prose mentions of /tmp (a git clone location, a historical incident
// path, a screenshot dir) are not this class and are not flagged.

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Dirs whose command lines an agent or script actually executes. */
const SCAN_DIRS = ['scripts', 'skills', 'commands', 'agents', 'bin', 'lib', 'mcp'];

/**
 * Write-destination flags, as they appear in shell command lines.
 * `-o`/`--out`/`--output`/`--out-file` followed by a path, plus `>` redirects.
 */
const WRITE_DEST = /(?:^|\s)(?:-o|--out|--output|--out-file|--outfile|>>?)[= ]+"?(\/(?:private\/)?tmp\/[^\s"'`;)]+)/g;

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|mts|md|sh|py)$/.test(entry.name) || !path.extname(entry.name)) acc.push(full);
  }
  return acc;
}

describe('no write destination is a predictable shared /tmp path (#1046)', () => {
  it('scans every executable command line in the plugin', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(REPO_ROOT, dir))) {
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf-8');
        } catch {
          continue; // binary / unreadable
        }
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          // A line that is explicitly calling the pattern out as WRONG is
          // documentation of the defect, not a reintroduction of it.
          if (/never|Never|NEVER|ace#1046|not\b.*predictable/.test(line)) return;
          for (const m of line.matchAll(WRITE_DEST)) {
            if (isPredictableSharedPath(m[1])) {
              offenders.push(
                `${path.relative(REPO_ROOT, file)}:${i + 1}: writes to ${m[1]}`,
              );
            }
          }
        });
      }
    }

    expect(
      offenders,
      'A write destination under /tmp with a predictable name is the ace#1046 ' +
        'defect: on a multi-user Mac the write can fail EACCES (another account ' +
        'owns the file) while the follow-up read SUCCEEDS and returns that ' +
        'account\'s stale payload — a well-formed, plausible, completely wrong ' +
        'result with no error to notice. Use `mktemp "${TMPDIR:-/tmp}/ace-XXXXXX.json"` ' +
        'in shell, or lib/scratch-file.ts::scratchPath in TypeScript:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('the detector actually fires on the exact near-miss line', () => {
    // Self-check: a detector that matches nothing would pass the test above
    // vacuously. This is the literal line that shipped in
    // skills/app-hq-settings/SKILL.md before the fix.
    const line =
      'npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/run-form-walk.ts" <d> <a> --out /tmp/ace-hq-<app>.json';
    const hits = [...line.matchAll(WRITE_DEST)].map((m) => m[1]);
    expect(hits).toEqual(['/tmp/ace-hq-<app>.json']);
    expect(isPredictableSharedPath(hits[0])).toBe(true);
  });

  it('the detector does not fire on the mktemp replacement', () => {
    const line = 'RESP="$(mktemp "${TMPDIR:-/tmp}/ace-upload-resp-XXXXXX.json")"; curl -o "$RESP" url';
    const hits = [...line.matchAll(WRITE_DEST)]
      .map((m) => m[1])
      .filter((p) => isPredictableSharedPath(p));
    expect(hits).toEqual([]);
  });
});

describe('run-form-walk emits through the identity-verified writer (#1046)', () => {
  it('never calls a bare writeFileSync for its --out payload', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/run-form-walk.ts'), 'utf-8');
    // The pre-fix signature: a raw write with no read-back proof.
    expect(src).not.toMatch(/writeFileSync\(args\.out/);
    expect(src).toMatch(/writeVerifiedJson\(/);
    // And the identity it asserts must be the pair that caught the near-miss.
    expect(src).toMatch(/identity\s*=\s*\{\s*domain:\s*args\.domain,\s*app_id:\s*args\.app_id\s*\}/);
  });

  it('offers a scratch output mode so callers need not invent a path', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/run-form-walk.ts'), 'utf-8');
    expect(src).toMatch(/--out-scratch/);
    expect(src).toMatch(/scratchPath\(/);
  });

  it('the app-hq-settings SKILL uses it instead of the predictable literal', () => {
    const skill = fs.readFileSync(
      path.join(REPO_ROOT, 'skills/app-hq-settings/SKILL.md'),
      'utf-8',
    );
    expect(skill).toMatch(/--out-scratch/);
    // The invocation must not still carry the pre-fix form.
    expect(skill).not.toMatch(/run-form-walk\.ts.*--out \/tmp\//);
  });
});
