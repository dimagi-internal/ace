/**
 * The anonymous `/solicitations/<id>/` route probe in solicitation-create
 * § Step 6 must match what labs actually serves (ace#3254).
 *
 * Observed 2026-10-19, anonymous curl against labs.connect.dimagi.com:
 *   /solicitations/1000001/  → 200  (is_public: true, active — listed)
 *   /solicitations/1000004/  → 404  (is_public: false, active — unlisted;
 *                                    get_solicitation round-trips it fine)
 *   /solicitations/9999999/  → 404  (no such record)
 *   /solicitations/1000002/  → 302 → /solicitations/past/<slug>/ (closed)
 *
 * Filed from connect-fi/20261018-1440 Phase 8 (solicitation 1000004).
 *
 * So an unlisted call is indistinguishable from a missing one to an anonymous
 * client — a 404 BLOCKER on a private call fires on every correct publish —
 * and a listed call is anonymously readable, so "requires a labs login by
 * design" is no longer true for new records.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const STALE_LOGIN_CLAIM = /requires a labs login by design/;

describe('solicitation-create § Step 6 route probe (ace#3254)', () => {
  const src = read('skills/solicitation-create/SKILL.md');

  it('does not tell the agent to expect a 302 to the labs login', () => {
    expect(src).not.toMatch(/answers \*\*302 → `\/labs\/login\/`\*\*/);
    expect(src).not.toMatch(/expect a 302,\s*NOT a 200/);
  });

  it('skips the anonymous probe for a private (unlisted) call', () => {
    expect(src).toMatch(/private[^\n]*call[^\n]*\n?[^\n]*skip the anonymous probe/i);
  });

  it('expects 200 for a listed call', () => {
    expect(src).toMatch(/listed call[^\n]*\n?[^\n]*\*\*200\*\*/i);
  });
});

describe('no stale "labs login by design" claim survives (ace#3254)', () => {
  for (const f of [
    'CLAUDE.md',
    'skills/solicitation-create/SKILL.md',
    'agents/solicitation-management.md',
    'playbook/integrations/connect-labs.md',
  ]) {
    it(f, () => {
      // Changelog rows record history verbatim; only live guidance is checked.
      const live = read(f)
        .split('\n')
        .filter((l) => !/^\| \d{4}-\d{2}-\d{2} \|/.test(l))
        .join('\n');
      expect(live).not.toMatch(STALE_LOGIN_CLAIM);
    });
  }
});
