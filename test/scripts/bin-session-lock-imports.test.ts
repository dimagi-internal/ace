/**
 * Contract test: every symbol `bin/ace-mobile-reap` imports from
 * `mcp/mobile/session-lock.ts` must actually be exported by it.
 *
 * ## Why this exists (ace#1704)
 *
 * `bin/ace-mobile-reap` is a bash script wrapping an INLINE TypeScript
 * shim executed via `tsx -e`. Nothing type-checks that shim: it is a
 * bash string, so `tsc --noEmit` never sees it and no test imported it.
 *
 * When ace#1704 renamed the module-level `SESSION_LOCK_DIR` const to a
 * call-time `sessionLockDir()` function, the shim's `import { …,
 * SESSION_LOCK_DIR, … }` was left behind. Under `tsx -e` that did NOT
 * throw — the binding resolved to `undefined` — so the operator CLI
 * kept exiting 0 while printing:
 *
 *     (no session locks under undefined)
 *
 * ...with live locks sitting on disk. The one tool an operator uses to
 * see which sessions hold which adb ports went blind, silently, and the
 * full vitest suite stayed green because nothing executes the shim.
 *
 * This is the class-level preventer: a future rename in session-lock.ts
 * that forgets the CLI fails here instead of in an operator's terminal
 * six weeks later. Static + runtime — it resolves the real module and
 * checks the real export namespace, so it cannot drift from the source.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'ace-mobile-reap');
const MODULE_REL = 'mcp/mobile/session-lock.ts';

/**
 * Pull the named bindings out of the shim's
 * `import { a, b, c } from '$LOCK_MOD_URL';` line.
 */
function importedNames(source: string): string[] {
  const m = source.match(/import\s*\{([^}]*)\}\s*from\s*'\$LOCK_MOD_URL'\s*;/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    // `a as b` — the imported name is the left side.
    .map((s) => s.split(/\s+as\s+/)[0].trim());
}

describe('bin/ace-mobile-reap ↔ session-lock.ts export contract', () => {
  const source = fs.readFileSync(BIN, 'utf8');

  it('the shim still imports from the session-lock module', () => {
    // Guards the parser itself: if the import line is reshaped, the
    // subset check below would pass vacuously on an empty list.
    expect(source).toContain(`mcp/mobile/session-lock.ts`);
    expect(importedNames(source).length).toBeGreaterThan(0);
  });

  it('every imported symbol is exported by session-lock.ts', async () => {
    const mod = await import(path.join(REPO_ROOT, MODULE_REL));
    const exported = new Set(Object.keys(mod));
    const missing = importedNames(source).filter((n) => !exported.has(n));
    expect(missing, `bin/ace-mobile-reap imports symbols ${MODULE_REL} does not export. ` +
      `Under \`tsx -e\` these bind to undefined WITHOUT throwing, so the CLI fails silently.`).toEqual([]);
  });

  it('does not reference the removed import-time SESSION_LOCK_DIR export', () => {
    // The specific ace#1704 regression, pinned by name. The shim may
    // keep a LOCAL const of that name (it does), but it must not import
    // one — the whole point is that the path resolves at call time.
    expect(importedNames(source)).not.toContain('SESSION_LOCK_DIR');
  });
});
