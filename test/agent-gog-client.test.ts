import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
 */
const ROOT = join(__dirname, '..');
const FLEET_SHARED_GOG_CLIENT = 'canopy';

describe('config/agent.json — gog client', () => {
  const agent = JSON.parse(readFileSync(join(ROOT, 'config/agent.json'), 'utf8'));

  it('uses the shared fleet OAuth client, not a per-agent one', () => {
    expect(agent.gog_client).toBe(FLEET_SHARED_GOG_CLIENT);
  });

  it('still points at ACE’s own mailbox (identity is the account, not the client)', () => {
    expect(agent.email).toBe('ace@dimagi-ai.com');
  });
});
