/**
 * Session-identity gate (lib/agent-identity-gate.ts, canopy#850): ace-gdrive,
 * ace-decisions, ace-ocs and ace-connect act as ACE only when
 * `canopy cred check --agent ace` exits 0, and never fall back to the bundled key.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DRIVE_REFUSAL_HINT,
  createIdentityGate,
  defaultCredRunner,
  installIdentityGate,
  interpretCheck,
  type CredResult,
  type CredRunner,
} from '../../lib/agent-identity-gate';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const REFUSED =
  "This is agent 'ada's runner turn (turn t-1), so it may act only as 'ada' — not as 'ace'. " +
  "To get work done as 'ace', dispatch it or ask it.";

function fakeRunner(results: CredResult[]): CredRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    return results[Math.min(calls.length - 1, results.length - 1)];
  }) as CredRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const ok: CredResult = { status: 0, stdout: "ok: this session may act as 'ace'", stderr: '' };
const refused: CredResult = { status: 3, stdout: '', stderr: REFUSED + '\n' };

describe('interpretCheck', () => {
  it('allows only exit 0', () => {
    expect(interpretCheck('ace', ok)).toEqual({ allowed: true });
  });

  it('passes the broker refusal paragraph through verbatim on exit 3', () => {
    expect(interpretCheck('ace', refused)).toEqual({ allowed: false, message: REFUSED });
  });

  it.each([1, 2, 4, 7])('refuses exit %i', (status) => {
    const v = interpretCheck('ace', { status, stdout: '', stderr: 'boom' });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.message).toContain('boom');
  });

  it('labels exit 4 as undetermined → refused', () => {
    const v = interpretCheck('ace', { status: 4, stdout: '', stderr: '' });
    expect(!v.allowed && v.message).toMatch(/undetermined \(treated as refused\)/);
  });

  it('refuses when the canopy CLI is missing', () => {
    const error = Object.assign(new Error('spawn canopy ENOENT'), { code: 'ENOENT' });
    const v = interpretCheck('ace', { status: null, stdout: '', stderr: '', error });
    expect(!v.allowed && v.message).toMatch(/`canopy` CLI is not installed/);
  });

  it('refuses when the process was killed (timeout)', () => {
    const v = interpretCheck('ace', { status: null, stdout: '', stderr: '' });
    expect(v.allowed).toBe(false);
  });
});

describe('createIdentityGate', () => {
  it('checks `canopy cred check --agent ace` and caches an allow', async () => {
    const run = fakeRunner([ok]);
    const gate = createIdentityGate({ run, hint: DRIVE_REFUSAL_HINT });
    expect(await gate.ensure()).toBeNull();
    expect(await gate.ensure()).toBeNull();
    expect(run.calls).toEqual([['cred', 'check', '--agent', 'ace']]);
  });

  it('returns stderr plus the Drive hint on refusal, and re-checks next call', async () => {
    const run = fakeRunner([refused, ok]);
    const gate = createIdentityGate({ run, hint: DRIVE_REFUSAL_HINT });
    const msg = await gate.ensure();
    expect(msg).toBe(`${REFUSED}\n\n${DRIVE_REFUSAL_HINT}`);
    expect(msg).toContain('Use your own Drive path: gog as your own account / canopy gdoc');
    expect(await gate.ensure()).toBeNull();
    expect(run.calls).toHaveLength(2);
  });

  it('re-checks after invalidate()', async () => {
    const run = fakeRunner([ok, refused]);
    const gate = createIdentityGate({ run, hint: 'h' });
    expect(await gate.ensure()).toBeNull();
    gate.invalidate();
    expect(await gate.ensure()).toContain(REFUSED);
  });

  it('shares one check across parallel first calls', async () => {
    const run = fakeRunner([ok]);
    const gate = createIdentityGate({ run, hint: 'h' });
    await Promise.all([gate.ensure(), gate.ensure(), gate.ensure()]);
    expect(run.calls).toHaveLength(1);
  });
});

type Handler = (...a: unknown[]) => Promise<unknown>;
function fakeServer() {
  const registered: Record<string, Handler> = {};
  return {
    registered,
    tool(...args: unknown[]) {
      registered[args[0] as string] = args[args.length - 1] as Handler;
    },
  };
}

describe('installIdentityGate', () => {
  it('a refused session never reaches the handler', async () => {
    const server = fakeServer();
    installIdentityGate(server, createIdentityGate({ run: fakeRunner([refused]), hint: DRIVE_REFUSAL_HINT }));
    let reached = false;
    server.tool('drive_read_file', {}, async () => {
      reached = true;
      return { content: [] };
    });
    const out = (await server.registered.drive_read_file({ fileId: 'x' })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(reached).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain(REFUSED);
    expect(out.content[0].text).toContain(DRIVE_REFUSAL_HINT);
  });

  it('an allowed session runs the handler; a failed call re-checks', async () => {
    const run = fakeRunner([ok]);
    const server = fakeServer();
    installIdentityGate(server, createIdentityGate({ run, hint: 'h' }));
    server.tool('a', async () => ({ content: [{ type: 'text', text: 'fine' }] }));
    server.tool('b', async () => ({ isError: true, content: [] }));
    server.tool('c', async () => {
      throw new Error('401');
    });
    await server.registered.a();
    await server.registered.a();
    expect(run.calls).toHaveLength(1);
    await server.registered.b();
    await server.registered.a();
    expect(run.calls).toHaveLength(2);
    await expect(server.registered.c()).rejects.toThrow('401');
    await server.registered.a();
    expect(run.calls).toHaveLength(3);
  });
});

describe('defaultCredRunner (canopy mocked via PATH)', () => {
  function withFakeCanopy(script: string, fn: () => Promise<void>) {
    return async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-canopy-'));
      fs.writeFileSync(path.join(dir, 'canopy'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      const prev = process.env.PATH;
      process.env.PATH = `${dir}:${prev}`;
      try {
        await fn();
      } finally {
        process.env.PATH = prev;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it(
    'reports exit 3 and stderr',
    withFakeCanopy('echo "refused: $*" >&2; exit 3', async () => {
      const r = await defaultCredRunner(['cred', 'check', '--agent', 'ace']);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('refused: cred check --agent ace');
      expect(interpretCheck('ace', r).allowed).toBe(false);
    }),
  );

  it(
    'reports exit 0',
    withFakeCanopy('echo ok; exit 0', async () => {
      expect(interpretCheck('ace', await defaultCredRunner(['cred', 'check'])).allowed).toBe(true);
    }),
  );

  it('reports a missing CLI as ENOENT → refused', async () => {
    const prev = process.env.PATH;
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-path-'));
    try {
      const r = await defaultCredRunner(['cred', 'check']);
      expect(r.error?.code).toBe('ENOENT');
      expect(interpretCheck('ace', r).allowed).toBe(false);
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe('wiring', () => {
  const GATED: Array<[string, string]> = [
    ['mcp/google-drive-server.ts', 'DRIVE_REFUSAL_HINT'],
    ['mcp/decisions-server.ts', 'DRIVE_REFUSAL_HINT'],
    ['mcp/ocs-server.ts', "platformRefusalHint('OCS')"],
    ['mcp/connect-server.ts', "platformRefusalHint('CommCare HQ / Connect')"],
  ];

  it.each(GATED)('%s installs the gate right after the server is built, before any tool', (file, hint) => {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    const install = src.indexOf(`installIdentityGate(server as never, createIdentityGate({ hint: ${hint} }));`);
    expect(install).toBeGreaterThan(src.indexOf('new McpServer('));
    expect(install).toBeLessThan(src.indexOf('server.tool('));
    const tenancy = src.indexOf('installDriveTenancyGuard(server');
    if (tenancy !== -1) expect(install).toBeLessThan(tenancy);
  });

  it('ace-mobile stays ungated (local emulator + test persona, no ACE login)', () => {
    const src = fs.readFileSync(path.join(REPO, 'mcp/mobile-server.ts'), 'utf8');
    expect(src).not.toContain('installIdentityGate');
  });
});
