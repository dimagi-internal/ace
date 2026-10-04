import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for jjackson/ace#1147.
 *
 * `config/agent.json`'s `gog_client` is what the shared canopy email engine
 * (`canopy email read|send`, and therefore `bin/ace-email` / `bin/ace-mark-read`)
 * resolves to pick a stored OAuth token bucket. It is the SHARED fleet client —
 * eva, hal, and ada all declare `canopy`, and the per-agent identity is the
 * MAILBOX, selected by `--account`, not the client.
 *
 * ACE briefly declared a per-agent `ace` client. No `credentials-ace.json` is
 * provisioned anywhere in the fleet, so every read and send failed with
 * "OAuth client credentials missing" — taking out ACE's entire counterpart-facing
 * surface. Worse, the remediation both `ace-doctor` and `canopy email preflight`
 * print for that state is `gog login --client ace`, an INTERACTIVE browser OAuth
 * that a headless or cron-driven turn cannot complete. So the failure is not just
 * a broken path, it's a broken path with no unattended way out.
 *
 * This is cheap to assert and expensive to rediscover, hence the test.
 *
 * The fleet has TWO interchangeable clients — `canopy` (Desktop, a laptop's
 * `gog login`) and `canopy-web` (Web, canopy-web's "Connect Google mailbox"
 * button) — one GCP project, one consent screen. The declared value is a
 * preference; which client a gog CALL uses is chosen by ONE function,
 * `canopy email client` (canopy#748), reached from TS through
 * `lib/gog-identity.ts` and from shell through `bin/ace-gog-client`.
 */
const ROOT = join(__dirname, '..');
const FLEET_GOG_CLIENTS = ['canopy', 'canopy-web'];

describe('config/agent.json — gog client', () => {
  const agent = JSON.parse(readFileSync(join(ROOT, 'config/agent.json'), 'utf8'));

  it('declares a shared fleet OAuth client, not a per-agent one', () => {
    expect(FLEET_GOG_CLIENTS).toContain(agent.gog_client);
  });

  it('still points at ACE’s own mailbox (identity is the account, not the client)', () => {
    expect(agent.email).toBe('ace@dimagi-ai.com');
  });
});

describe('one function chooses the gog client', () => {
  // Every TS caller that builds a gog command goes through resolveGogIdentity,
  // which asks `canopy email client`. Reading `gog_client` verbatim (or
  // defaulting to 'canopy') re-opens the canopy-web mailbox failure.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, ent.name);
      if (ent.isDirectory()) walk(rel, out);
      else if (rel.endsWith('.ts')) out.push(rel);
    }
    return out;
  };

  it('no TS module outside lib/gog-identity.ts reads gog_client', () => {
    const offenders = ['lib', 'mcp', 'scripts']
      .flatMap((d) => walk(d))
      .filter((f) => f !== join('lib', 'gog-identity.ts'))
      .filter((f) => /\.gog_client\b/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('shell callers choose the client through bin/ace-gog-client', () => {
    for (const f of ['bin/ace-doctor', 'bin/ace-setup']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/bin\/ace-gog-client/);
    }
  });
});
