/**
 * ace#1957 — a script invoked from a Bash tool call inherits NO ACE secrets.
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
 * This is an env-loading / Bash-reachability defect, not device truth:
 * the ground truth is what `process.env` holds inside a spawned child,
 * which a unit test observes directly and completely. Each behavioural
 * case below spawns the real script with the vars ABSENT from the child
 * env and the credentials reachable only via the plugin-data `.env`, and
 * asserts the script gets PAST its missing-credential check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('ace#1957 — the loader is shared, not re-derived per script', () => {
  const helper = join(REPO_ROOT, 'lib/load-plugin-env.ts');

  it('lib/load-plugin-env.ts exists', () => {
    expect(existsSync(helper)).toBe(true);
  });

  it('resolves through lib/plugin-data-dir.ts rather than hand-rolling a path', () => {
    const src = readFileSync(helper, 'utf8');
    expect(src).toContain('resolvePluginDataDir');
  });

  it('every Bash-reachable script fixed here calls it', () => {
    for (const s of ['scripts/run-content-generator.ts', 'scripts/run-nova-media-upload.ts']) {
      const src = readFileSync(join(REPO_ROOT, s), 'utf8');
      const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(code, `${s} must call loadPluginEnv`).toMatch(/loadPluginEnv\(import\.meta\.url\)/);
    }
  });

  it('loads before the first credential read, or the fix does nothing', () => {
    const cases: Array<[string, string]> = [
      ['scripts/run-content-generator.ts', 'process.env.CONTENT_GENERATOR_URL'],
      ['scripts/run-nova-media-upload.ts', 'process.env.NOVA_MCP_URL'],
    ];
    for (const [s, firstRead] of cases) {
      const src = readFileSync(join(REPO_ROOT, s), 'utf8');
      const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      const load = code.indexOf('loadPluginEnv(import.meta.url)');
      const read = code.indexOf(firstRead);
      expect(load, `${s}: no loadPluginEnv call`).toBeGreaterThan(-1);
      expect(read, `${s}: ${firstRead} must be read after the load`).toBeGreaterThan(load);
    }
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
