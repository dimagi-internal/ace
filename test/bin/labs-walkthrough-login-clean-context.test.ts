/**
 * Regression: `bin/labs-walkthrough-login.ts` must run the OAuth flow in a
 * CLEAN context, not the saved one.
 *
 * The script probes labs with the saved storageState. When the probe fails,
 * the saved jar is by definition stale, and whichever cookie survives in it
 * short-circuits `hqOAuthLogin` into a landing it cannot finish. A live
 * www.commcarehq.org cookie skips HQ's login form and strands the flow on
 * `/oauth/authorize/`, which throws `oauth-consent` for credentials that are
 * fine. The MCP relogin learned this in ace#2160 (and its own regression test,
 * `test/mcp/connect/unit/session-relogin-clean-context.test.ts`); this script
 * kept handing the saved jar over.
 *
 * Observed 2026-09-11: with a day-old `~/.ace/labs-session.json`, the script
 * failed at `oauth-consent` on 0.13.1427 and 0.13.1435 alike, while the same
 * credentials with `ACE_STATE_DIR` pointed at an empty directory logged in
 * first try.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const newContextCalls: Array<Record<string, unknown> | undefined> = [];
let loginContextOpts: Record<string, unknown> | undefined | 'unset' = 'unset';
let probeStatus = 302;

function makeContext(opts: Record<string, unknown> | undefined) {
  return {
    __opts: opts,
    request: {
      get: async () => ({ status: () => probeStatus, text: async () => '' }),
    },
    close: async () => {},
    cookies: async () => [],
    storageState: async () => ({}),
  };
}

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      newContext: async (opts?: Record<string, unknown>) => {
        newContextCalls.push(opts);
        return makeContext(opts);
      },
      close: async () => {},
    }),
  },
}));

vi.mock('../../mcp/connect/auth/hq-oauth-login.js', () => ({
  hqOAuthLogin: async (o: { context: { __opts?: Record<string, unknown> } }) => {
    loginContextOpts = o.context.__opts;
  },
}));

vi.mock('../../mcp/connect-labs/auth/labs-oauth-login.js', () => ({
  labsOAuthLogin: async () => {},
}));

vi.mock('../../mcp/lib/playwright-session.js', async (orig) => ({
  ...(await orig<typeof import('../../mcp/lib/playwright-session.js')>()),
  persistStorageState: async () => {},
}));

async function runScript(): Promise<void> {
  vi.resetModules();
  await import('../../bin/labs-walkthrough-login.js');
  for (let i = 0; i < 100 && loginContextOpts === 'unset'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('labs-walkthrough-login OAuth context', () => {
  let stateDir: string;
  const saved = { ...process.env };
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    newContextCalls.length = 0;
    loginContextOpts = 'unset';
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labs-login-'));
    // A saved jar exists — the idle-machine case the fix is about.
    fs.writeFileSync(path.join(stateDir, 'labs-session.json'), JSON.stringify({ cookies: [], origins: [] }));
    process.env.ACE_STATE_DIR = stateDir;
    process.env.ACE_HQ_USERNAME = 'user@example.com';
    process.env.ACE_HQ_PASSWORD = 'not-a-real-password';
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.env = { ...saved };
    process.stdout.write = write;
    process.stderr.write = writeErr;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('probes with the saved jar but logs in from a context built without it', async () => {
    probeStatus = 302; // labs session expired
    await runScript();

    expect(newContextCalls[0]?.storageState).toBe(path.join(stateDir, 'labs-session.json'));
    expect(loginContextOpts).not.toBe('unset');
    expect((loginContextOpts as Record<string, unknown> | undefined)?.storageState).toBeUndefined();
  });
});
