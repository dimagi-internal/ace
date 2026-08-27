import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveGogIdentity } from '../../lib/gog-identity.js';

function makeRepo(agentJson?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-gog-identity-'));
  if (agentJson !== undefined) {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'agent.json'), JSON.stringify(agentJson));
  }
  return root;
}

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

  it('resolves from config/agent.json, ignoring any env residual', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com', gog_client: 'canopy' }));
    const id = resolveGogIdentity({
      repoRoot: root,
      env: { ACE_GMAIL_ACCOUNT: 'stale@example.com', ACE_GMAIL_CLIENT: 'ace' },
    });
    expect(id).toEqual({ account: 'ace@dimagi-ai.com', client: 'canopy' });
  });

  // The regression this helper exists for: a machine whose 1Password vault still
  // hands out ACE_GMAIL_CLIENT=ace. No credentials-ace.json is ever provisioned,
  // so honouring the env var makes every gog call fail with an un-runnable remedy.
  // See jjackson/ace#1147.
  it('never returns the bogus `ace` client when agent.json declares the fleet client', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com', gog_client: 'canopy' }));
    const id = resolveGogIdentity({ repoRoot: root, env: { ACE_GMAIL_CLIENT: 'ace' } });
    expect(id.client).toBe('canopy');
    expect(id.client).not.toBe('ace');
  });

  it('THROWS when agent.json is absent — no env fallback (ace#1147)', () => {
    // The removed behaviour, pinned as removed. `$ACE_GMAIL_CLIENT` resolved to
    // `ace` from 1Password while agent.json said `canopy`; no
    // credentials-ace.json is ever provisioned, so falling back could only ever
    // select a client that cannot authenticate. Failing loudly beats resolving
    // to a broken identity.
    const root = track(makeRepo());
    expect(() =>
      resolveGogIdentity({
        repoRoot: root,
        env: { ACE_GMAIL_ACCOUNT: 'stale@example.com', ACE_GMAIL_CLIENT: 'ace' },
      }),
    ).toThrow(/single source of truth|missing/i);
  });

  it('THROWS when agent.json is unparseable — no env fallback (ace#1147)', () => {
    const root = track(makeRepo());
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'agent.json'), '{ not json');
    expect(() =>
      resolveGogIdentity({
        repoRoot: root,
        env: { ACE_GMAIL_ACCOUNT: 'stale@example.com', ACE_GMAIL_CLIENT: 'ace' },
      }),
    ).toThrow(/single source of truth|missing/i);
  });

  it('never returns the env value even when agent.json is complete', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com', gog_client: 'canopy' }));
    const id = resolveGogIdentity({
      repoRoot: root,
      env: { ACE_GMAIL_ACCOUNT: 'stale@example.com', ACE_GMAIL_CLIENT: 'ace' },
    });
    expect(id).toEqual({ account: 'ace@dimagi-ai.com', client: 'canopy' });
  });

  it('throws an actionable error when neither source yields a client', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com' }));
    expect(() => resolveGogIdentity({ repoRoot: root, env: {} })).toThrow(/gog_client/);
  });
});
