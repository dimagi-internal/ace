/**
 * Google auth for the ACE MCP servers that call Drive/Docs/Sheets/Slides/Forms
 * (ace-gdrive, ace-decisions): ACE signs in AS ace@dimagi-ai.com, with the
 * short-lived access token canopy keeps for the agent's own Google login.
 *
 *     canopy cred google-token --agent ace
 *       → ~/.canopy/google-token/ace.json  { access_token, expires_at (epoch s), account }
 *
 * This replaces the old service-account key (`gws-sa-key.json`):
 * ACE's Canopy vault never held it, so Drive failed on any box without the old
 * file (cloud-ec2-2, turn 599fad3b: "Method doesn't allow unregistered
 * callers"; ace#3310). There is NO service-account fallback.
 *
 * The token file is reused while it has more than REFRESH_WINDOW_S left;
 * otherwise `canopy cred google-token` is run to renew it (canopy itself reuses
 * a file with 5+ minutes left, so asking early is cheap).
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OAuth2Client } from 'google-auth-library';

export const GOOGLE_TOKEN_AGENT = 'ace';
/** Renew when the file has less than this long left (seconds). */
export const REFRESH_WINDOW_S = 300;

export interface GoogleTokenFile {
  access_token: string;
  /** Epoch seconds. */
  expires_at: number;
  account?: string;
}

/** Runs `canopy cred google-token --agent ace`; resolves the token file path it prints. */
export type TokenMinter = () => Promise<string>;

export function defaultTokenPath(agent = GOOGLE_TOKEN_AGENT): string {
  return join(homedir(), '.canopy', 'google-token', `${agent}.json`);
}

export const mintViaCanopy: TokenMinter = () =>
  new Promise((resolve, reject) => {
    execFile(
      'canopy',
      ['cred', 'google-token', '--agent', GOOGLE_TOKEN_AGENT],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          const why = (stderr || '').trim() || err.message;
          reject(
            new Error(
              `could not get ace@dimagi-ai.com's Google token (canopy cred google-token --agent ace): ${why}. ` +
                `Is the canopy CLI on PATH and signed in? Run /canopy:setup.`,
            ),
          );
          return;
        }
        resolve(stdout.trim().split('\n').pop() || defaultTokenPath());
      },
    );
  });

function readTokenFile(path: string): GoogleTokenFile | undefined {
  try {
    const t = JSON.parse(readFileSync(path, 'utf8')) as Partial<GoogleTokenFile>;
    if (typeof t.access_token === 'string' && t.access_token && typeof t.expires_at === 'number') {
      return t as GoogleTokenFile;
    }
  } catch {
    // missing / unreadable / not JSON → treated as "no token", caller mints.
  }
  return undefined;
}

export interface AceGoogleAuthOptions {
  tokenPath?: string;
  mint?: TokenMinter;
  /** Epoch ms; injectable for tests. */
  now?: () => number;
}

/**
 * An OAuth2 client whose access token is ace@'s canopy-minted one. Drop-in for
 * the `auth` argument of `google.drive({ version, auth })` and friends.
 */
export class AceGoogleAuth extends OAuth2Client {
  private readonly tokenPath: string;
  private readonly mint: TokenMinter;
  private readonly now: () => number;
  private inflight?: Promise<GoogleTokenFile>;

  constructor(opts: AceGoogleAuthOptions = {}) {
    super();
    this.tokenPath = opts.tokenPath ?? defaultTokenPath();
    this.mint = opts.mint ?? mintViaCanopy;
    this.now = opts.now ?? Date.now;
  }

  private fresh(t: GoogleTokenFile | undefined): t is GoogleTokenFile {
    return !!t && t.expires_at - this.now() / 1000 > REFRESH_WINDOW_S;
  }

  /** The current token, minting a new one when the file is missing or nearly expired. */
  async currentToken(): Promise<GoogleTokenFile> {
    const cached = readTokenFile(this.tokenPath);
    if (this.fresh(cached)) return cached;
    this.inflight ??= (async () => {
      try {
        const printed = await this.mint();
        const t = readTokenFile(printed) ?? readTokenFile(this.tokenPath);
        if (!this.fresh(t)) {
          throw new Error(
            `canopy cred google-token ran but ${printed} holds no token with more than ${REFRESH_WINDOW_S}s left`,
          );
        }
        return t;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private async load(): Promise<void> {
    const t = await this.currentToken();
    this.credentials = { access_token: t.access_token, expiry_date: Math.floor(t.expires_at * 1000) };
  }

  // request() and getRequestHeaders() — everything the Google API clients use —
  // go through here, so every call re-reads the token file first.
  override async getRequestMetadataAsync(url?: string | URL) {
    await this.load();
    return super.getRequestMetadataAsync(url);
  }
}
