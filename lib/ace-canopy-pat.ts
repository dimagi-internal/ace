/**
 * ACE's canopy-web token and API base URL — the ONE place ACE decides who it is on canopy-web.
 *
 * The token comes from canopy: `canopy agent token --slug ace`. canopy owns the decision
 * (a runner turn's per-turn login, a laptop's per-session login, a person's local turn, and
 * never the operator's workbench-token) — see canopy `agent-core/agent-runtime.md`
 * § Session identity. ACE does not restate that order and does not read a token anywhere
 * else, with one exception, kept until canopy-web retires the stored PAT:
 *
 *   - canopy answers (exit 0)                  → its stdout is the token.
 *   - canopy is too old to know the command    → PHASE-1 FALLBACK: the stored CANOPY_WEB_PAT
 *     ("No such command"), or no canopy CLI      in ACE's .env (never an inherited env var:
 *                                               that can belong to a human, ace#2805).
 *   - canopy refuses (any other non-zero)      → FINAL. No token; `canopyTokenProblem()` says
 *                                               why, and every caller fails with it.
 *
 * Every TS site (lib/, mcp/mobile/, scripts/) goes through here. `bin/ace-canopy-web` is the
 * Python twin and applies the same three outcomes.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** canopy-web's API origin. `CANOPY_WEB_API_URL` overrides it (tests, staging). */
export const DEFAULT_CANOPY_WEB_API_URL = 'https://canopy.dimagi.com';

/** The agent slug ACE asks canopy for. */
export const ACE_SLUG = 'ace';

/** What to tell a person when there is no token. Points at canopy; never restates its order. */
export const CANOPY_TOKEN_REMEDIATION =
  'Run `canopy agent token --slug ace | wc -c` to see canopy\'s answer; how a session gets its ' +
  'canopy-web identity is canopy agent-core/agent-runtime.md § Session identity.';

/** ACE's .env files, in the order bin/ace-canopy-web reads them. */
export function aceEnvFiles(): string[] {
  if (process.env.ACE_ENV_FILE) return [process.env.ACE_ENV_FILE];
  return [
    path.join(os.homedir(), '.claude', 'plugins', 'data', 'ace-ace', '.env'),
    path.join(os.homedir(), '.ace', '.env'),
  ];
}

/**
 * A key's value from ACE's .env files (first file that sets it), or null.
 */
export function aceEnvValue(key: string): string | null {
  const prefix = `${key}=`;
  for (const f of aceEnvFiles()) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith(prefix)) {
          const v = t.slice(prefix.length).trim().replace(/^["']|["']$/g, '');
          if (v) return v;
        }
      }
    } catch {
      /* next file */
    }
  }
  return null;
}

/**
 * The canopy CLI to ask, or null when there is none. `ACE_CANOPY_BIN` overrides the lookup
 * (tests point it at a fake, or at a path that does not exist).
 */
export function canopyExe(): string | null {
  const override = process.env.ACE_CANOPY_BIN;
  if (override !== undefined) return fs.existsSync(override) ? override : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'canopy');
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next dir */
    }
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'canopy');
  return fs.existsSync(local) ? local : null;
}

type CliAnswer = { kind: 'token'; token: string } | { kind: 'unavailable' } | { kind: 'refused'; reason: string };

/** canopy's answer, cached once per process (keyed by the CLI path, so tests can swap it). */
let cliCache: { exe: string | null; answer: CliAnswer } | null = null;

function askCanopy(): CliAnswer {
  const exe = canopyExe();
  if (cliCache && cliCache.exe === exe) return cliCache.answer;
  let answer: CliAnswer;
  if (!exe) {
    answer = { kind: 'unavailable' };
  } else {
    // stdout piped (canopy refuses a TTY: the output is a credential), stdin closed.
    const p = spawnSync(exe, ['agent', 'token', '--slug', ACE_SLUG], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    const stdout = (p.stdout ?? '').trim();
    const stderr = (p.stderr ?? '').trim();
    if (p.error) {
      // Could not run it at all (ENOENT, EACCES): canopy cannot answer here.
      // A timeout is a refusal, though: canopy ran and gave no identity.
      answer = (p.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? { kind: 'refused', reason: 'canopy agent token timed out after 30s' }
        : { kind: 'unavailable' };
    } else if (p.status === 0 && stdout) {
      answer = { kind: 'token', token: stdout };
    } else if (/No such command/.test(stderr)) {
      answer = { kind: 'unavailable' }; // an older canopy, before `agent token`
    } else {
      const last = stderr.split('\n').filter(Boolean).pop() ?? `exit ${p.status ?? p.signal}, no reason given`;
      answer = { kind: 'refused', reason: last };
    }
  }
  cliCache = { exe, answer };
  return answer;
}

/** Tests only: forget canopy's cached answer. */
export function resetCanopyTokenCache(): void {
  cliCache = null;
}

export type CanopyIdentity =
  | { token: string; source: 'canopy' | 'stored-pat' }
  | { token: null; reason: string };

/** ACE's canopy-web token and where it came from, or the reason there is none. */
export function canopyIdentity(): CanopyIdentity {
  const a = askCanopy();
  if (a.kind === 'token') return { token: a.token, source: 'canopy' };
  if (a.kind === 'refused') {
    // FINAL: canopy decided there is no identity for ace here. Never fall back.
    return { token: null, reason: `canopy has no canopy-web identity for ${ACE_SLUG} here: ${a.reason}` };
  }
  // PHASE-1 FALLBACK (remove with the stored PAT): an older canopy, or no canopy CLI.
  const pat = aceEnvValue('CANOPY_WEB_PAT');
  if (pat) return { token: pat, source: 'stored-pat' };
  return {
    token: null,
    reason:
      `canopy cannot issue a canopy-web token here (no canopy CLI, or one older than \`canopy agent token\`), ` +
      `and ACE's .env has no stored PAT to fall back to (${aceEnvFiles().join(', ')})`,
  };
}

/** ACE's canopy-web token, or null when there is none (`canopyTokenProblem()` says why). */
export function canopyToken(): string | null {
  return canopyIdentity().token;
}

/** Why there is no token — the text a caller fails with. Empty when there is one. */
export function canopyTokenProblem(): string {
  const id = canopyIdentity();
  return id.token !== null ? '' : id.reason;
}

/** canopy-web API base URL, without a trailing slash. */
export function canopyApiBase(): string {
  return (process.env.CANOPY_WEB_API_URL || DEFAULT_CANOPY_WEB_API_URL).replace(/\/+$/, '');
}
