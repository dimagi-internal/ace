/**
 * `npx tsx` is unusable from inside the installed plugin cache.
 *
 * node_modules/.bin/tsx ships there as a dereferenced COPY rather than a symlink
 * to ../tsx/dist/cli.mjs — every ACE version since 0.13.1169 (ace#2252). tsx's
 * bundle splits into hashed sibling chunks that cli.mjs imports relative to its
 * own location, so when its bytes sit in .bin/ the import resolves against .bin/
 * (where the chunks were never copied) and Node throws ERR_MODULE_NOT_FOUND.
 *
 * The failure is ENVIRONMENT-ONLY: all of these work in a dev checkout, where
 * npm made a real symlink, and fail on every installed box. That is why it
 * survived 13 releases before a cloud turn tripped over it — and why the fix has
 * to be a test over every call site, not a repair of the two that were noticed.
 *
 * Scanning is done in Node, deliberately. The first version of this test shelled
 * out to grep with a pattern containing both `"` and `$`; the quoting broke, the
 * command errored to stderr, the match list came back empty and the test passed
 * green while checking nothing.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = ['bin', 'skills', 'agents', 'commands', 'playbook'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

function* files(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* files(p);
    else if (st.isFile()) yield p;
  }
}

function scan(test: (line: string) => boolean): string[] {
  const hits: string[] = [];
  for (const dir of DIRS) {
    for (const f of files(dir)) {
      let text: string;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      text.split('\n').forEach((line, i) => {
        if (test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  }
  return hits;
}

const REMEDY =
  'Resolve tsx directly instead:\n' +
  '  node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" <script.ts>\n';

describe('tsx is never resolved through the plugin cache .bin shim', () => {
  it('the scanner actually sees this repo (guards against a vacuous pass)', () => {
    // If the walker silently returns nothing, every assertion below is green
    // for the wrong reason — which is how the first version of this test shipped.
    const anyTsx = scan((l) => l.includes('tsx/dist/cli.mjs'));
    expect(anyTsx.length).toBeGreaterThan(0);
  });

  it('has no `npx --prefix <plugin root> tsx` invocations', () => {
    const hits = scan((l) => /npx\s+--prefix\s+"\$(ACE_ROOT|SELF_DIR|ROOT|repo_root)"\s+tsx\b/.test(l));
    expect(hits, `Broken in every installed plugin cache (ace#2252).\n${REMEDY}\n${hits.join('\n')}`).toEqual([]);
  });

  it('runs no bare `npx tsx` from an executable in bin/', () => {
    // Prose telling a human what to run in a dev checkout is fine; a line this
    // script actually executes is not.
    const hits = scan((l) => {
      if (!/(^|[^'"`\w])npx\s+tsx\s/.test(l)) return false;
      const t = l.trim();
      if (t.startsWith('#')) return false;                 // comment
      if (/\b(warn|printf|echo|run ')/.test(l)) return false; // advice text
      return true;
    }).filter((h) => h.startsWith('bin/'));
    expect(hits, `bin/ shells out via the broken shim.\n${REMEDY}\n${hits.join('\n')}`).toEqual([]);
  });
});
