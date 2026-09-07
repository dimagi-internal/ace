/**
 * ace#2095 — a shared helper must not write to the stream its callers use for
 * DATA.
 *
 * `lib/load-plugin-env.ts` is called by 17 Bash-reachable scripts and, until
 * this test, let dotenv v17 print `◇ injected env (N) from .env // tip: …` on
 * **stdout** via `console.log`. Measured on 0.13.1296:
 *
 *     $ npx tsx scripts/plan-avd-pool.ts --size 2 --json 2>/dev/null | jq .base
 *     jq: parse error: Invalid numeric literal at line 1, column 4   (exit 5)
 *
 * Five of dotenv's eight rotating tips contain a `{`, so "slice at the first
 * brace" lands inside the banner rather than at the JSON — which is why the
 * first in-repo consumer had to hunt for a line that is exactly `{`.
 *
 * The same defect had already been paid for three times without the class
 * being named: `doctor-ocs-generation.ts`, `doctor-nova-scopes.ts` and
 * `doctor-nova-header.ts` each hand-roll a silent `.env` reader specifically
 * to dodge this banner. And the highest-stakes instance was never filed at
 * all — all five `mcp/*-server.ts` processes speak JSON-RPC over stdout and
 * were emitting the banner as the first line of that transport (ace#2114).
 *
 * So the ratchet is behavioural and DERIVED, not a list: every MCP server on
 * disk is launched and its stdout is required to be protocol-clean, so a sixth
 * server is covered the day it lands.
 *
 * Classification: unit-test truth. Stream routing, a `JSON.parse`, and short
 * child processes over temp directories. Nothing is sent to or matched against
 * a device.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { announce, type LoadedPluginEnv } from '../../lib/load-plugin-env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOADER = path.join(ROOT, 'lib', 'load-plugin-env.js');

/** Collect what a `WritableStream`-shaped sink was handed. */
function sink(): { written: string[]; stream: NodeJS.WritableStream } {
  const written: string[] = [];
  const stream = {
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { written, stream };
}

/** Run a fixture in its own cwd and hand back BOTH streams, separated. */
function runFixture(dir: string, body: string): { stdout: string; stderr: string; status: number | null } {
  const fixture = path.join(dir, 'fixture.ts');
  writeFileSync(fixture, body);
  const res = spawnSync('npx', ['tsx', fixture], {
    cwd: dir,
    encoding: 'utf8',
    input: '',
    timeout: 180_000,
  });
  if (res.error) throw res.error;
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

describe('announce — the diagnostic itself', () => {
  it("names the absolute path and the origin, which dotenv's banner could not", () => {
    const { written, stream } = sink();
    const info: LoadedPluginEnv = {
      path: '/Users/x/Library/.../ace-ace/.env',
      fromPluginData: true,
      loaded: true,
      keys: 43,
    };
    announce(info, stream);
    expect(written.join('')).toBe(
      '[ace-env] read 43 key(s) from /Users/x/Library/.../ace-ace/.env (plugin data)\n',
    );
  });

  it('says plainly when the file was not there — the ace#1957 operator question', () => {
    const { written, stream } = sink();
    announce({ path: '/tmp/nope/.env', fromPluginData: false, loaded: false, keys: 0 }, stream);
    expect(written.join('')).toContain('no .env at /tmp/nope/.env (cwd fallback)');
  });

  it('emits exactly one line, so a `head -1` on stderr is the whole diagnostic', () => {
    const { written, stream } = sink();
    announce({ path: '/tmp/.env', fromPluginData: false, loaded: true, keys: 1 }, stream);
    expect(written.join('').match(/\n/g)).toHaveLength(1);
  });
});

describe('loadPluginEnv — stdout belongs to the caller', () => {
  /**
   * The real path, in a child process, with a real `.env` that really has keys
   * — that is the branch dotenv prints its banner on. The fixture writes JSON
   * to stdout the way `plan-avd-pool --json` does, and the assertion is a bare
   * `JSON.parse` of raw stdout: no line hunting, no brace slicing.
   */
  it('leaves stdout clean enough to JSON.parse whole, and puts the diagnostic on stderr', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-env-streams-'));
    try {
      writeFileSync(path.join(dir, '.env'), 'ACE_STREAM_FIXTURE_A=1\nACE_STREAM_FIXTURE_B=2\n');
      const { stdout, stderr, status } = runFixture(
        dir,
        `import { loadPluginEnv } from ${JSON.stringify(LOADER)};\n` +
          `const info = loadPluginEnv(import.meta.url);\n` +
          `console.log(JSON.stringify({ keys: info.keys, loaded: info.loaded }));\n`,
      );
      expect(status, stderr).toBe(0);

      // The whole point: raw stdout, parsed directly.
      expect(JSON.parse(stdout)).toEqual({ keys: 2, loaded: true });
      expect(stdout).not.toContain('injected env');
      expect(stdout).not.toContain('[ace-env]');

      // And the diagnostic did not vanish — it moved.
      expect(stderr).toContain('[ace-env] read 2 key(s) from');
      expect(stderr).toContain(path.join(dir, '.env'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still reports on stderr when there is no .env to read', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ace-env-streams-'));
    try {
      const { stdout, stderr, status } = runFixture(
        dir,
        `import { loadPluginEnv } from ${JSON.stringify(LOADER)};\n` +
          `loadPluginEnv(import.meta.url);\n` +
          `console.log('[]');\n`,
      );
      expect(status, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
      expect(stderr).toContain('[ace-env] no .env at');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The unfiled half of the class (ace#2114). An MCP stdio server's stdout IS its
 * JSON-RPC transport; a banner there is protocol garbage that survives only
 * because clients skip lines they cannot parse. Derived by glob so the rule
 * covers a server that does not exist yet.
 */
const MCP_SERVERS = readdirSync(path.join(ROOT, 'mcp'))
  .filter((f) => f.endsWith('-server.ts'))
  .sort();

describe('mcp/*-server.ts — stdout is a transport, not a log', () => {
  it('finds the servers (a glob that matched nothing would pass vacuously)', () => {
    expect(MCP_SERVERS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(MCP_SERVERS)('%s writes no non-JSON line to stdout at boot', (name) => {
    const res = spawnSync('npx', ['tsx', path.join(ROOT, 'mcp', name)], {
      cwd: ROOT,
      encoding: 'utf8',
      input: '',
      timeout: 180_000,
    });
    if (res.error) throw res.error;
    for (const line of res.stdout.split('\n')) {
      if (line.trim() === '') continue;
      expect(
        () => JSON.parse(line) as unknown,
        `mcp/${name} wrote a non-JSON line to its JSON-RPC transport: ${line}`,
      ).not.toThrow();
    }
  });
});
