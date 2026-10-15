// connect-opp-setup Step 7: an absent invite row is recovered before it is
// reported (ace#2946).
//
// On smallholder-seasonal/20261014-0859 (opp 30605010-…) the FLW invite sent
// right after `/activate/` returned `queued` but created no row; one identical
// re-send fixed it (the row's invited_date equalled the re-send time). The step
// used to go straight from `match === null` to WARN, so a run following it
// recorded `invite_row_present: false` and a Phase 6 blocker that a single
// re-send would have cleared. This pins the recovery order in the skill text.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SKILL = readFileSync('skills/connect-opp-setup/SKILL.md', 'utf8');

/** The `match === null` bullet of Step 7, up to Step 7's "Do NOT gate on" line. */
function nullBranch(): string {
  const start = SKILL.indexOf('- **`match === null`**');
  if (start < 0) throw new Error('Step 7 has no `match === null` branch');
  const end = SKILL.indexOf('Do NOT gate on `match.claimed`', start);
  if (end < 0) throw new Error('Step 7 `match === null` branch has no terminator');
  return SKILL.slice(start, end);
}

describe('connect-opp-setup Step 7 — re-send before WARN (ace#2946)', () => {
  const branch = nullBranch();

  it('waits and re-reads, then re-sends the same invite ONCE, then WARNs', () => {
    const wait = branch.search(/Wait ~60 s and re-read/);
    const resend = branch.search(/re-send the SAME `connect_send_flw_invite` call ONCE/);
    const warn = branch.search(/STILL absent[\s\S]*invite_row_present: false[\s\S]*WARN loudly/);
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(resend).toBeGreaterThan(wait);
    expect(warn).toBeGreaterThan(resend);
  });

  it('caps the re-send at one and logs both sends', () => {
    expect(branch).toMatch(/Do not re-send more than once/);
    expect(branch).toMatch(/comms-log\/observations\.md/);
  });

  it('cites the live reproducer', () => {
    expect(branch).toContain('30605010-4be8-49e3-954c-deeb0b4ad8d6');
    expect(branch).toContain('smallholder-seasonal/20261014-0859');
  });
});
