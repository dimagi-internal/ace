/**
 * Enforce plugin-root resolution in skill/command/agent markdown.
 *
 * ACE's code is fully bundled in the installed plugin cache, but historically
 * ~20 call sites invoked it with BARE RELATIVE paths (`npx tsx scripts/qa-run.ts`)
 * that only resolve when cwd happens to be a repo checkout — in a real session
 * cwd is the user's project, so every such gate ENOENT'd. Others built cache
 * paths from `$(cat ~/.claude/plugins/marketplaces/ace/VERSION)` (silently
 * malformed without the clone, drifts when the clone is ahead of the installed
 * cache) or hardcoded the author's home directory.
 *
 * The rule (fixed 2026-07-24, see canopy PR #395 for the sibling change): every
 * executable invocation of bundled code resolves the plugin root first —
 *
 *   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "...installPath from
 *     ~/.claude/plugins/installed_plugins.json...")}"
 *   npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/<f>.ts" ...
 *
 * New exceptions go in ALLOWED with a reason, not around this test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCAN_DIRS = ['skills', 'commands', 'agents'];

const BANNED: Array<{ name: string; pattern: RegExp }> = [
  // Bare-relative executable invocations of bundled code.
  { name: 'bare npx tsx scripts/', pattern: /npx tsx scripts\// },
  { name: 'bare python3 scripts/', pattern: /python3 scripts\// },
  { name: 'bare npx tsx bin/', pattern: /npx( --prefix \.)? tsx bin\// },
  // Hand-built version-keyed cache paths.
  { name: 'marketplace VERSION path', pattern: /marketplaces\/ace\/VERSION/ },
  // Author-machine absolute paths.
  { name: 'hardcoded /Users/<name>', pattern: /\/Users\/[a-z]+\// },
  // The one-off undefined variable this class shipped with.
  { name: 'undefined ACE_PLUGIN_ROOT', pattern: /\$ACE_PLUGIN_ROOT|\$\{ACE_PLUGIN_ROOT\}/ },
];

// rel path -> reason it may contain a banned shape.
const ALLOWED = new Map<string, string>([
  ['commands/update.md', 'the update channel: pulls/rsyncs FROM the marketplace clone by design'],
  ['commands/setup.md', 'bootstrap + diagnostics may inspect clone/cache state directly'],
  ['commands/doctor.md', 'diagnostics enumerate cache/clone/checkout tiers to report on them'],
]);

function* mdFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* mdFiles(full);
    else if (entry.endsWith('.md')) yield full;
  }
}

describe('runtime resolution idiom', () => {
  it('skill/command/agent markdown resolves the plugin root — no bare-relative or hand-built paths', () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of mdFiles(join(REPO_ROOT, dir))) {
        const rel = relative(REPO_ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          for (const { name, pattern } of BANNED) {
            if (pattern.test(line)) {
              violations.push(`${rel}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`);
            }
          }
        });
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('allowlist entries still exist (a stale entry widens the blind spot)', () => {
    for (const rel of ALLOWED.keys()) {
      expect(() => statSync(join(REPO_ROOT, rel))).not.toThrow();
    }
  });
});
