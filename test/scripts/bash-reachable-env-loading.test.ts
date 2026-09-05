/**
 * ace#1957 / ace#1964 — a script invoked from a Bash tool call inherits NO ACE
 * secrets.
 *
 * `.env` is loaded into MCP *subprocesses* by each server's own top-level
 * `dotenvConfig()` (CLAUDE.md § Gotchas: "values are loaded into MCP
 * subprocesses, not the parent shell, so `$ACE_*` in your shell will
 * normally be empty"). A plain `npx tsx scripts/<x>.ts` gets none of that,
 * so any script that reads a secret has to load the plugin-data `.env`
 * itself — the way `scripts/run-form-walk.ts` already does (ace#993).
 *
 * `scripts/run-content-generator.ts` did not, which made
 * `app-media-coverage` step 6 fail with "Set CONTENT_GENERATOR_URL and
 * CONTENT_GENERATOR_API_KEY in the env." on a correctly-provisioned
 * machine — and the documented remediation (`source ~/.ace/env.sh`)
 * exports only `NOVA_API_KEY`, so following it did not help. The step
 * degrades rather than halting, so every run without an `inputs/media/`
 * folder silently shipped zero generated images.
 *
 * ace#1957 fixed that one instance. ace#1964 is the class: eight more scripts
 * under `scripts/` read an ACE secret, are named from `skills/` / `agents/` /
 * `commands/`, and never loaded `.env` — and the reason eight could accumulate
 * is that nothing DERIVED the set. So the last section here is a RATCHET: it
 * discovers the Bash-reachable, secret-reading scripts from the repo itself
 * (`lib/bash-reachable-scripts.ts`) and asserts each one loads the plugin-data
 * `.env` before its first credential read. A new offending script fails CI on
 * the day it lands; there is no list to keep current.
 *
 * This is an env-loading / Bash-reachability defect, not device truth:
 * the ground truth is what `process.env` holds inside a spawned child,
 * which a unit test observes directly and completely. Each behavioural
 * case below spawns the real script with the vars ABSENT from the child
 * env and the credentials reachable only via the plugin-data `.env`, and
 * asserts the script gets PAST its missing-credential check.
 *
 * Scrubbing a var to `''` would make every one of those cases pass
 * vacuously — dotenv skips any key already present in `process.env` — so
 * `run()` DELETES them from the child env instead. Getting that wrong
 * empties the whole suite of meaning.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverBashReachableScripts,
  EXEMPT_SCRIPTS,
} from '../../lib/bash-reachable-scripts.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '../..');

/** A throwaway plugin-data dir holding a `.env`, plus a scratch workspace. */
let dataDir: string;
let work: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-1957-plugin-data-'));
  work = mkdtempSync(join(tmpdir(), 'ace-1957-work-'));
  // Point every credential at a closed local port: reachable-looking, but
  // no network call can succeed. Getting a connection error instead of a
  // missing-env error is exactly the signal this test wants.
  writeFileSync(
    join(dataDir, '.env'),
    [
      'CONTENT_GENERATOR_URL=http://127.0.0.1:1/generate',
      'CONTENT_GENERATOR_API_KEY=env-file-only-key',
      'NOVA_API_KEY=env-file-only-nova-key',
      'NOVA_MCP_URL=http://127.0.0.1:1/mcp',
      // A version no selector map exists for, so the script's own "map not
      // found" line quotes it back and proves the .env value reached a
      // MODULE-LEVEL read (ace#1964).
      'ACE_CONNECT_APK_VERSION=9.99.9',
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  for (const d of [dataDir, work]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Spawn a script with `scrub`bed vars genuinely ABSENT (not empty-string —
 * dotenv skips any key already present in `process.env`, so an empty value
 * would mask the very thing under test) and `CLAUDE_PLUGIN_DATA` pointed at
 * the throwaway data dir.
 */
function run(script: string, args: string[], scrub: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !scrub.includes(k)) env[k] = v;
  }
  env.CLAUDE_PLUGIN_DATA = dataDir;
  const res = spawnSync('npx', ['tsx', join(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const CG_VARS = ['CONTENT_GENERATOR_URL', 'CONTENT_GENERATOR_API_KEY'];

describe('ace#1957 — run-content-generator.ts reaches its credentials from Bash', () => {
  it('gets past the missing-env check with the keys only in the plugin-data .env', () => {
    const input = join(work, 'cg-input.json');
    writeFileSync(input, JSON.stringify({ applicationContext: 'ctx', formText: 'text' }));
    const { code, stderr } = run(
      'scripts/run-content-generator.ts',
      [input, join(work, 'out.png')],
      CG_VARS,
    );
    expect(stderr).not.toContain('Set CONTENT_GENERATOR_URL');
    // 3 = the request was attempted and failed (closed port), which is only
    // reachable once both credentials resolved. 2 would mean still-missing.
    expect(code).toBe(3);
  });

  it('still reports missing credentials when the .env has none either', () => {
    const emptyData = mkdtempSync(join(tmpdir(), 'ace-1957-empty-data-'));
    writeFileSync(join(emptyData, '.env'), 'ACE_UNRELATED=1\n');
    const input = join(work, 'cg-input2.json');
    writeFileSync(input, JSON.stringify({ applicationContext: 'ctx', formText: 'text' }));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !CG_VARS.includes(k)) env[k] = v;
    }
    env.CLAUDE_PLUGIN_DATA = emptyData;
    const res = spawnSync(
      'npx',
      ['tsx', join(REPO_ROOT, 'scripts/run-content-generator.ts'), input, join(work, 'o2.png')],
      { cwd: REPO_ROOT, encoding: 'utf-8', env },
    );
    rmSync(emptyData, { recursive: true, force: true });
    expect(res.status).toBe(2);
    // The error must name where it looked, or the operator is sent back to
    // `~/.ace/env.sh`, which cannot supply these keys.
    expect(res.stderr ?? '').toContain(emptyData);
  });
});

describe('ace#1957 — run-nova-media-upload.ts reaches NOVA_API_KEY from Bash', () => {
  it('gets past the missing-key check with the key only in the plugin-data .env', () => {
    const asset = join(work, 'tiny.png');
    writeFileSync(asset, Buffer.from('89504e470d0a1a0a', 'hex'));
    const { stderr } = run('scripts/run-nova-media-upload.ts', [asset], [
      'NOVA_API_KEY',
      'NOVA_MCP_URL',
    ]);
    expect(stderr).not.toContain('NOVA_API_KEY is not set');
    // Reaching the transport is the proof the key resolved.
    expect(stderr).toContain('could not reach Nova');
  });

  it('reads NOVA_MCP_URL from the .env too, not just the hardcoded default', () => {
    const asset = join(work, 'tiny2.png');
    writeFileSync(asset, Buffer.from('89504e470d0a1a0a', 'hex'));
    const { stderr } = run('scripts/run-nova-media-upload.ts', [asset], [
      'NOVA_API_KEY',
      'NOVA_MCP_URL',
    ]);
    expect(stderr).toContain('http://127.0.0.1:1/mcp');
  });
});

describe('ace#1964 — .env reaches a MODULE-LEVEL read, not just one inside main()', () => {
  it('probe-atlas-drift.ts takes ACE_CONNECT_APK_VERSION from the plugin-data .env', () => {
    // `DEFAULT_APK` is read at module top level, so the value it resolves to is
    // baked before `main()` ever runs — the exact placement trap PR #1965 hit
    // on run-nova-media-upload.ts. The script names the map it could not find,
    // so the version it actually used is observable rather than inferred.
    const emptyDumpDir = mkdtempSync(join(tmpdir(), 'ace-1964-dumps-'));
    const { stderr, stdout } = run('scripts/probe-atlas-drift.ts', [emptyDumpDir], [
      'ACE_CONNECT_APK_VERSION',
    ]);
    rmSync(emptyDumpDir, { recursive: true, force: true });
    expect(stderr + stdout).toContain('connect-9.99.9.yaml');
    expect(stderr + stdout).not.toContain('connect-2.63.2.yaml');
  });
});

describe('ace#1964 — a missing credential names the file that was read', () => {
  it('seed-connect-cookies.ts points at the .env it looked in, and at /ace:setup', () => {
    // "missing" is only actionable if the operator knows WHICH file to look in.
    // The hand-rolled reader this replaced hardcoded
    // $HOME/.claude/plugins/data/ace-ace/.env, so it could not name an
    // explicit CLAUDE_PLUGIN_DATA override even when that was the file in play.
    const emptyData = mkdtempSync(join(tmpdir(), 'ace-1964-empty-data-'));
    writeFileSync(join(emptyData, '.env'), 'ACE_UNRELATED=1\n');
    const env: Record<string, string> = {};
    const scrub = ['ACE_HQ_USERNAME', 'ACE_HQ_PASSWORD'];
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !scrub.includes(k)) env[k] = v;
    }
    env.CLAUDE_PLUGIN_DATA = emptyData;
    const res = spawnSync('npx', ['tsx', join(REPO_ROOT, 'scripts/seed-connect-cookies.ts')], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env,
    });
    rmSync(emptyData, { recursive: true, force: true });
    expect(res.status).toBe(2);
    expect(res.stderr ?? '').toContain(emptyData);
    expect(res.stderr ?? '').toContain('/ace:setup --force-env');
  });
});

describe('ace#1957 — the loader is shared, not re-derived per script', () => {
  const helper = join(REPO_ROOT, 'lib/load-plugin-env.ts');

  it('lib/load-plugin-env.ts exists', () => {
    expect(existsSync(helper)).toBe(true);
  });

  it('resolves through lib/plugin-data-dir.ts rather than hand-rolling a path', () => {
    // An MCP subprocess gets .env injected by its bootstrap; a plain
    // `npx tsx` invocation does not, and the installed script lives under the
    // versioned plugin cache. Asserted here, once, rather than in each of the
    // scripts that used to carry their own copy (ace#1964).
    const src = readFileSync(helper, 'utf8');
    expect(src).toContain('resolvePluginDataDir');
  });

  it('falls back to cwd when not running from the installed plugin', () => {
    expect(readFileSync(helper, 'utf8')).toMatch(/process\.cwd\(\)/);
  });
});

/**
 * ace#1964 — THE RATCHET.
 *
 * Everything above is one instance each. This is the class, and it is
 * DISCOVERED rather than listed: `discoverBashReachableScripts` walks
 * `scripts/*.ts`, keeps the ones named from `skills/` / `agents/` /
 * `commands/` that read a variable `.env.tpl` declares (plus a handful of
 * documented extras), and reports whether each calls
 * `loadPluginEnv(import.meta.url)` before its first such read.
 *
 * A hardcoded list is the thing that goes stale — that is how eight scripts
 * accumulated behind ace#1957's two. Adding a new script that reads a secret
 * and is reachable from a skill fails this test on the day it lands, and so
 * does adding a new key to `.env.tpl` that an existing unloaded script reads.
 *
 * The check is on textual POSITION, deliberately. A read inside a function
 * defined above the loader is fine at runtime, so the rule is stricter than
 * strictly necessary — and that is the point: it forces the call to module
 * top, which removes the "was it called before?" reasoning entirely. That
 * reasoning is what PR #1965 got wrong once already.
 */
describe('ace#1964 — every Bash-reachable script that reads a secret loads .env first', () => {
  const findings = discoverBashReachableScripts(REPO_ROOT);

  it('discovers a non-trivial set (a zero here means the walk broke, not that we are clean)', () => {
    expect(findings.length).toBeGreaterThanOrEqual(10);
  });

  it.each(findings.map((f) => [f.script, f] as const))(
    '%s calls loadPluginEnv before its first credential read',
    (_script, f) => {
      expect(
        f.loaderIndex,
        `${f.script} reads ${f.firstRead.variable} (line ${f.firstRead.line}) but never calls ` +
          `loadPluginEnv(import.meta.url). It is reachable from ${f.referencedBy[0]} — a Bash ` +
          `tool call inherits none of ACE's secrets. Add:\n` +
          `    import { loadPluginEnv } from '../lib/load-plugin-env.js';\n` +
          `    loadPluginEnv(import.meta.url);\n` +
          `at module top, above the first read.`,
      ).toBeGreaterThan(-1);
      expect(
        f.loaderIndex,
        `${f.script} calls loadPluginEnv, but AFTER it reads ${f.firstRead.variable} on line ` +
          `${f.firstRead.line}. ESM runs the module body top-down, so a call placed "before ` +
          `main()" is already too late for a module-level read (ace#1957 / PR #1965). Move it ` +
          `to module top.`,
      ).toBeLessThan(f.firstRead.index);
    },
  );

  it('carries no exemptions — every one is a hole in the ratchet', () => {
    // Not a ban: an entry here is allowed, but it must be deliberate and
    // reasoned, and this assertion is what makes adding one a decision rather
    // than a reflex.
    expect(Object.keys(EXEMPT_SCRIPTS)).toEqual([]);
  });
});

describe('ace#1957 — the skill no longer sends the operator to ~/.ace/env.sh', () => {
  const skill = readFileSync(
    join(REPO_ROOT, 'skills/app-media-coverage/SKILL.md'),
    'utf8',
  );

  it('never PRESCRIBES sourcing it — the only mentions left are warnings', () => {
    // The file exports NOVA_API_KEY and nothing else, so it cannot supply the
    // Content Generator keys. It may still be NAMED, to tell the operator not
    // to reach for it; what must not survive is an instruction to run it.
    const lines = skill.split('\n').filter((l) => l.includes('source ~/.ace/env.sh'));
    for (const l of lines) {
      expect(l, `prescriptive remediation left in: ${l.trim()}`).toMatch(/Do NOT/);
    }
  });

  it('points the operator at the file that actually holds these keys', () => {
    expect(skill).toContain('/ace:setup --force-env');
  });
});
