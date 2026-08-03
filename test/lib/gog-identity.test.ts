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

  it('prefers config/agent.json over the env fallbacks', () => {
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

  it('falls back to env when agent.json is absent', () => {
    const root = track(makeRepo());
    const id = resolveGogIdentity({
      repoRoot: root,
      env: { ACE_GMAIL_ACCOUNT: 'ace@dimagi-ai.com', ACE_GMAIL_CLIENT: 'canopy' },
    });
    expect(id).toEqual({ account: 'ace@dimagi-ai.com', client: 'canopy' });
  });

  it('falls back to env when agent.json is unparseable', () => {
    const root = track(makeRepo());
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'agent.json'), '{ not json');
    const id = resolveGogIdentity({
      repoRoot: root,
      env: { ACE_GMAIL_ACCOUNT: 'ace@dimagi-ai.com', ACE_GMAIL_CLIENT: 'canopy' },
    });
    expect(id.client).toBe('canopy');
  });

  it('throws an actionable error when neither source yields a client', () => {
    const root = track(makeRepo({ email: 'ace@dimagi-ai.com' }));
    expect(() => resolveGogIdentity({ repoRoot: root, env: {} })).toThrow(/gog_client/);
  });
});
