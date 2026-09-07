/**
 * Regression: the headless OAuth relogin must start from a CLEAN context
 * regardless of WHICH cookie went stale (ace#2160).
 *
 * Connect and CCHQ cookies expire on separate clocks. Whichever one survives
 * short-circuits the OAuth flow into a landing `hqOAuthLogin` cannot finish:
 *
 *   - Connect fresh + CCHQ stale -> `/accounts/login/` redirects away, so the
 *     OAuth button is absent. This direction was already handled.
 *   - Connect stale + CCHQ fresh -> HQ renders no login form, the flow lands
 *     on `/oauth/authorize/` and throws `oauth-consent`. This direction was
 *     NOT handled, and since Connect's cookie is the shorter-lived one it is
 *     the ordinary end-state of an idle machine.
 *
 * The assertion in every case is the same: whatever context reaches
 * `hqOAuthLogin` was built WITHOUT the saved storageState.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const newContextCalls: Array<Record<string, unknown>> = [];
/** The options used to build the context that `hqOAuthLogin` actually got. */
let loginContextOpts: Record<string, unknown> | undefined;

/** Per-test: status returned by a probe GET, keyed by the URL it was given. */
let probeStatus: (url: string) => number;

/** Enough HTML for the post-auth CSRF hydration to find a token. */
const CSRF_HTML = `<html><body hx-headers='{"X-CSRFToken": "tok-123"}'></body></html>`;

function makeContext(opts: Record<string, unknown>) {
  const ctx: any = {
    __opts: opts,
    request: {
      get: async (url: string) => ({
        status: () => probeStatus(url),
        text: async () => CSRF_HTML,
      }),
    },
    close: async () => {},
    cookies: async () => [],
    storageState: async () => ({}),
  };
  return ctx;
}

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      newContext: async (opts: Record<string, unknown>) => {
        newContextCalls.push(opts);
        return makeContext(opts);
      },
      close: async () => {},
    }),
  },
}));

/** Flipped by a successful mock login: afterwards Connect probes read authed. */
let loggedIn = false;

vi.mock('../../../../mcp/connect/auth/hq-oauth-login.js', () => ({
  hqOAuthLogin: vi.fn(async ({ context }: any) => {
    loginContextOpts = context.__opts;
    loggedIn = true;
  }),
}));

let stateDir: string;

beforeEach(() => {
  newContextCalls.length = 0;
  loginContextOpts = undefined;
  loggedIn = false;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-session-test-'));
  // A saved session on disk. Its CONTENT does not matter — what matters is
  // that resolveSavedStorageState picks it up, so a context built with it is
  // distinguishable from a clean one.
  fs.writeFileSync(
    path.join(stateDir, 'connect-session.json'),
    JSON.stringify({ cookies: [{ name: 'sessionid', value: 'stale', domain: 'connect.dimagi.com' }], origins: [] }),
  );
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function runGetContext() {
  const { PlaywrightSession } = await import('../../../../mcp/connect/auth/playwright-session.js');
  const session = new PlaywrightSession({
    baseUrl: 'https://connect.dimagi.com',
    cchqBaseUrl: 'https://www.commcarehq.org',
    stateDir,
    hqUsername: 'ace@dimagi-ai.com',
    hqPassword: 'pw',
  });
  await session.getContext();
}

describe('PlaywrightSession.getContext relogin (ace#2160)', () => {
  it('logs in from a clean context when the CONNECT cookie is stale but CCHQ is still valid', async () => {
    // Connect anon (200), CCHQ still authed (302) — the ace#2160 shape.
    probeStatus = (url) =>
      url.includes('commcarehq.org') ? 302 : loggedIn ? 302 : 200;
    await runGetContext();

    expect(loginContextOpts, 'hqOAuthLogin was never called').toBeDefined();
    expect(
      loginContextOpts?.storageState,
      'hqOAuthLogin got a context carrying the saved storageState; the surviving CCHQ ' +
        'cookie then lands the flow on /oauth/authorize/ and it throws oauth-consent',
    ).toBeUndefined();
  });

  it('logs in from a clean context in the mirror case (Connect fresh, CCHQ stale)', async () => {
    // Connect authed (302), CCHQ anon (200) — the direction already handled.
    probeStatus = (url) =>
      url.includes('commcarehq.org') ? (loggedIn ? 302 : 200) : 302;
    await runGetContext();

    expect(loginContextOpts, 'hqOAuthLogin was never called').toBeDefined();
    expect(loginContextOpts?.storageState).toBeUndefined();
  });

  it('does not relogin at all when both cookies are still valid', async () => {
    probeStatus = () => 302;
    await runGetContext();

    expect(loginContextOpts, 'relogged in despite a fully valid session').toBeUndefined();
  });
});
