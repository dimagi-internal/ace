// Phase 4 runs the real program-manager -> network-manager flow when an NM org
// is configured (operator decision, Jon 2026-09-26).
//
// Observed: spark-facilitator/20260925-1536 — Phase 4 created a SELF-MANAGED
// opportunity (held by the PM org), so Connect's PM-only verification-rules
// page redirected and none of the PDD's Layer A payability rules were applied
// (ace#2419: `is_opportunity_pm` requires request org != holding org). Proved
// live 2026-09-26 that an NM-held opportunity takes its rules at the PM org's
// URL (probe opportunity 7bfcb845-015c-416a-a200-9795c68dfc55).
//
// This rail keeps the three procedure halves that make the fix real from
// drifting back: connect-opp-setup creates the opportunity under the HOLDING
// org and sets rules at the PM org; the run records both orgs; and reviewer
// access goes to the holding org. The pure org rule itself is unit-tested in
// test/lib/connect-orgs.test.ts (phase4Orgs / runConnectOrgs).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('Phase 4 PM->NM holding org (ace#2419)', () => {
  const opp = read('skills/connect-opp-setup/SKILL.md');

  it('connect-opp-setup resolves pm_org / holding_org via phase4Orgs and creates under the holding org', () => {
    expect(opp).toContain('phase4Orgs()');
    expect(opp).toMatch(/`target_organization_slug`: \*\*`holding_org` from Step 3\.0\*\*/);
    // The pre-2026-09-26 rule that Phase 4 ALWAYS self-manages must not come back.
    expect(opp).not.toMatch(/this skill always creates\s+>?\s*a \*\*self-managed\*\* opportunity/);
  });

  it('connect-opp-setup invites + accepts the HOLDING org and captures program_application_id from the invite POST', () => {
    expect(opp).toContain('organization: <holding_org>');
    expect(opp).toContain('Capture `program_application_id` from the invite POST');
  });

  it('verification rules are set at the PM org, never the holding org', () => {
    expect(opp).toContain("Call it with `organization_slug: <pm_org>` — the PROGRAM's org, never\n   the holding org.");
  });

  it('the run records both orgs', () => {
    expect(opp).toContain('pm_org_slug:');
    expect(opp).toContain('holding_org_slug:');
    const schema = read('lib/phase-products-schema.ts');
    expect(schema).toContain('pm_org_slug: z.string().optional()');
    expect(schema).toContain('holding_org_slug: z.string().optional()');
  });

  it('reviewer access is granted in the holding org', () => {
    expect(read('skills/share-run-access/SKILL.md')).toContain('holding_org_slug');
  });
});
