import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveGogIdentity,
  canopyEmailClient,
  type CanopyRunner,
} from '../../lib/gog-identity.js';

function makeRepo(agentJson?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-gog-identity-'));
  if (agentJson !== undefined) {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'agent.json'), JSON.stringify(agentJson));
  }
  return root;
}

/** A runner where `canopy email client` answers with `client`. */
function canopyAnswers(client: string, calls: string[][] = []): CanopyRunner {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'canopy') {
      return {
        status: 0,
        stdout: JSON.stringify({ slug: 'ace', account: 'ace@dimagi-ai.com', client, declared: 'canopy' }),
      };
    }
    return { status: 1, stdout: '' };
  };
}

/** A runner where no canopy can be run at all (ENOENT everywhere). */
const noCanopy: CanopyRunner = () => ({ status: null, stdout: '', error: new Error('spawn canopy ENOENT') });

/** canopy present but older than the `client` command. */
const oldCanopy: CanopyRunner = (cmd) =>
  cmd === 'canopy' ? { status: 2, stdout: "Error: No such command 'client'." } : { status: 1, stdout: '' };

describe('resolveGogIdentity', () => {
  const roots: string[] = [];
  const track = (r: string) => {
    roots.push(r);
    return r;
  };

  afterEach(() => {
    while (roots.length) {
      const r = roots.pop()!;
      try {
        fs.rmSync(r, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('takes the client from `canopy email client --repo <root> --json`', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com', gog_client: 'canopy' }));
    const calls: string[][] = [];
    const id = resolveGogIdentity({ repoRoot: root, run: canopyAnswers('canopy-web', calls), warn: () => {} });
    expect(id).toEqual({ account: 'ace@dimagi-ai.com', client: 'canopy-web' });
    expect(calls[0]).toEqual(['canopy', 'email', 'client', '--repo', root, '--json']);
  });

  it('accepts either fleet client — canopy-web is not an error', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com', gog_client: 'canopy' }));
    for (const client of ['canopy', 'canopy-web']) {
      const id = resolveGogIdentity({ repoRoot: root, run: canopyAnswers(client), warn: () => {} });
      expect(id.client).toBe(client);
    }
  });

  it('falls back to the DECLARED gog_client, and says so, when canopy cannot be run', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com', gog_client: 'canopy' }));
    const warnings: string[] = [];
    const id = resolveGogIdentity({ repoRoot: root, run: noCanopy, warn: (m) => warnings.push(m) });
    expect(id).toEqual({ account: 'ace@dimagi-ai.com', client: 'canopy' });
    expect(warnings.join('\n')).toMatch(/canopy email client.*could not be run.*declared gog_client "canopy"/);
  });

  it('falls back when canopy is older than the `client` command', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com', gog_client: 'canopy' }));
    const warnings: string[] = [];
    const id = resolveGogIdentity({ repoRoot: root, run: oldCanopy, warn: (m) => warnings.push(m) });
    expect(id.client).toBe('canopy');
    expect(warnings).toHaveLength(1);
  });

  it('falls back to `canopy` when neither canopy nor agent.json names a client', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com' }));
    const id = resolveGogIdentity({ repoRoot: root, run: noCanopy, warn: () => {} });
    expect(id.client).toBe('canopy');
  });

  // ace#1147: a machine whose 1Password vault still hands out ACE_GMAIL_CLIENT=ace.
  // No credentials-ace.json is ever provisioned, so honouring the env var makes
  // every gog call fail with an un-runnable remedy.
  it('never consults the env — not for the account, not for the client', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com', gog_client: 'canopy' }));
    const id = resolveGogIdentity({
      repoRoot: root,
      env: { ACE_GMAIL_ACCOUNT: 'stale@example.com', ACE_GMAIL_CLIENT: 'ace' },
      run: noCanopy,
      warn: () => {},
    });
    expect(id).toEqual({ account: 'ace@dimagi-ai.com', client: 'canopy' });
    expect(id.client).not.toBe('ace');
  });

  it('THROWS when agent.json is absent — no env fallback (ace#1147)', () => {
    const root = track(makeRepo());
    expect(() =>
      resolveGogIdentity({
        repoRoot: root,
        env: { ACE_GMAIL_ACCOUNT: 'stale@example.com', ACE_GMAIL_CLIENT: 'ace' },
        run: canopyAnswers('canopy'),
      }),
    ).toThrow(/single source of truth|missing/i);
  });

  it('THROWS when agent.json is unparseable — no env fallback (ace#1147)', () => {
    const root = track(makeRepo());
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'agent.json'), '{ not json');
    expect(() => resolveGogIdentity({ repoRoot: root, run: canopyAnswers('canopy') })).toThrow(/missing email/i);
  });
});

describe('canopyEmailClient', () => {
  it('returns null on a non-JSON answer rather than guessing', () => {
    const run: CanopyRunner = (cmd) => (cmd === 'canopy' ? { status: 0, stdout: 'canopy\n' } : { status: 1, stdout: '' });
    expect(canopyEmailClient('/nowhere', run)).toBeNull();
  });

  it('returns null when the JSON carries no client', () => {
    const run: CanopyRunner = (cmd) =>
      cmd === 'canopy' ? { status: 0, stdout: JSON.stringify({ client: '' }) } : { status: 1, stdout: '' };
    expect(canopyEmailClient('/nowhere', run)).toBeNull();
  });
});
