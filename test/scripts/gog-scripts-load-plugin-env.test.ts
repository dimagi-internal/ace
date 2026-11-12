import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Any script under `scripts/` that shells out to `gog` must load the
 * plugin-data `.env` itself (dimagi-internal/ace#2844).
 *
 * ## The failure this pins
 *
 * gog keeps its OAuth client secret in a FILE keyring whose password is
 * `GOG_KEYRING_PASSWORD`. That value lives in `<plugin-data>/.env` and in no
 * shell profile, so a session a canopy RUNNER spawns does not have it. A script
 * that calls `gog` without loading the file first dies with:
 *
 *   Secret not found in keyring (refresh token missing). Run: gog auth add <email>
 *
 * `skills/turn` tells *humans* to prefix `bin/ace-env`, but that cannot be the
 * contract for a script the skills invoke themselves by bare
 * `node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/<x>.ts"` —
 * and both callers below do exactly that (`skills/turn/SKILL.md` § counterpart-asks
 * probe, `skills/llo-directory-add/SKILL.md` steps for plan/apply/verify).
 *
 * ## Why this is worse than an ordinary crash
 *
 * The failure is reported as an AUTH problem. `probe-counterpart-asks.ts` catches it
 * and prints "is the mailbox authenticated? `gog login …`" — sending the reader to
 * re-run an interactive browser OAuth for a mailbox that is perfectly authenticated.
 * Observed 2026-11-12 during an `/ace:turn`: the probe failed, and the same mailbox
 * answered a live search one command later once the env was loaded.
 *
 * ## The check
 *
 * Static source assertion, not an execution test: running these scripts means live
 * Gmail and Sheets calls against a real mailbox, which a unit test must not require.
 */

const SCRIPTS_DIR = join(__dirname, '..', '..', 'scripts');

/** Matches a child-process invocation whose command argument is literally `gog`. */
const INVOKES_GOG = /(?:execFileSync|execFile|spawnSync|spawn|execa)\(\s*['"`]gog['"`]/;

/**
 * `read('gog', [...])` / `deps.exec('gog', [...])` — the dependency-injected shape
 * `llo-directory.ts` uses, where the real implementation is still `execFileSync`.
 */
const INVOKES_GOG_VIA_HELPER = /\b(?:read|exec|run)\(\s*['"`]gog['"`]\s*,/;

function sourceFiles(): { name: string; source: string }[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(join(SCRIPTS_DIR, name), 'utf8') }));
}

function callsGog(source: string): boolean {
  return INVOKES_GOG.test(source) || INVOKES_GOG_VIA_HELPER.test(source);
}

describe('scripts that shell out to gog load the plugin env themselves', () => {
  it('finds the gog-invoking scripts at all (guards the detector itself)', () => {
    const callers = sourceFiles().filter((f) => callsGog(f.source)).map((f) => f.name);

    // If this ever empties, the regexes stopped matching and every assertion
    // below would pass vacuously.
    expect(callers.length).toBeGreaterThan(0);
    expect(callers).toContain('probe-counterpart-asks.ts');
    expect(callers).toContain('llo-directory.ts');
  });

  it('every gog-invoking script calls loadPluginEnv', () => {
    const offenders = sourceFiles()
      .filter((f) => callsGog(f.source))
      .filter((f) => !/loadPluginEnv\(/.test(f.source))
      .map((f) => f.name);

    expect(
      offenders,
      `These scripts call gog but never call loadPluginEnv(), so GOG_KEYRING_PASSWORD ` +
        `is unset in a runner-spawned session and every gog call fails with ` +
        `"Secret not found in keyring" — reported to the operator as an auth problem ` +
        `(ace#2844). Add \`loadPluginEnv(import.meta.url)\` before the first gog call.`,
    ).toEqual([]);
  });

  it('imports loadPluginEnv from the shared lib rather than re-deriving the path', () => {
    const offenders = sourceFiles()
      .filter((f) => callsGog(f.source))
      .filter((f) => !/from\s+['"]\.\.\/lib\/load-plugin-env\.js['"]/.test(f.source))
      .map((f) => f.name);

    expect(offenders).toEqual([]);
  });
});
