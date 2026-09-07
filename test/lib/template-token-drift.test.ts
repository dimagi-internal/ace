/**
 * Mirror-vs-live template token drift (dimagi-internal/ace#2126).
 *
 * The drift itself needs live Drive credentials to observe, so the fetch lives
 * in `scripts/probe-work-order-template-drift.ts` and CI cannot run it. What CI
 * CAN pin is the comparison: the classification that decides whether an
 * observed difference is the ace#2126 direction (the producer's value silently
 * evaporates) or the ace#819 direction (a literal {{token}} ships into a
 * contract), and the family/meta normalization that keeps an 8-row timeline
 * table from reading as eight tokens of drift.
 *
 * The fixtures are the real § 1 Background text from both artifacts, verbatim
 * as of the run that reopened the issue.
 */
import { describe, it, expect } from 'vitest';

import {
  diffTemplateTokens,
  formatTokenDrift,
  normalizeToken,
  tokensIn,
} from '../../lib/template-token-drift.js';

/** § 1 as `templates/work-order-template.md` carries it. */
const MIRROR_BACKGROUND = `## 1. Background

{{partner_first_reference}} is the implementing partner for the work described in this Work Order.

{{background_body}}

## 2. Scope of Work
`;

/**
 * § 1 as the LIVE gdoc carried it — the exact shape quoted in the reopen
 * comment: `{{background_body}}` sits directly under the heading with nothing
 * between, so the token the producer emits has nowhere to land.
 */
const LIVE_BACKGROUND = `1. Background
{{background_body}}
2. Scope of Work
`;

describe('template token drift (#2126)', () => {
  it('classifies a mirror-only token as MIRROR_ONLY, not as sync', () => {
    const drift = diffTemplateTokens(MIRROR_BACKGROUND, LIVE_BACKGROUND);
    expect(drift.inSync).toBe(false);
    expect(drift.mirrorOnly).toEqual(['partner_first_reference']);
    expect(drift.liveOnly).toEqual([]);
  });

  it('reports in sync once the live template carries the slot', () => {
    // The remedy, executed rather than assumed: this is the live § 1 after the
    // batchUpdate that fixed the gdoc.
    const repaired = `1. Background
{{partner_first_reference}} is the implementing partner for the work described in this Work Order.

{{background_body}}
2. Scope of Work
`;
    const drift = diffTemplateTokens(MIRROR_BACKGROUND, repaired);
    expect(drift).toEqual({ mirrorOnly: [], liveOnly: [], inSync: true });
  });

  it('classifies the opposite direction as LIVE_ONLY (the ace#819 failure)', () => {
    const drift = diffTemplateTokens('{{a}}\n', '{{a}}\n{{orphan_token}}\n');
    expect(drift.mirrorOnly).toEqual([]);
    expect(drift.liveOnly).toEqual(['orphan_token']);
    expect(drift.inSync).toBe(false);
  });

  it('collapses enumerated table-row families so row COUNT is not drift', () => {
    // The mirror enumerates eight timeline rows and eleven RACI rows; a doc
    // that writes the family once must not read as nineteen missing tokens.
    expect(normalizeToken('week_3_dates')).toBe('week_N_dates');
    expect(normalizeToken('raci_11_partner')).toBe('raci_N_partner');
    const mirror = '{{week_1_dates}} {{week_2_dates}} {{raci_1_partner}}';
    const live = '{{week_1_dates}} {{week_2_dates}} {{week_3_dates}} {{raci_4_partner}}';
    expect(diffTemplateTokens(mirror, live).inSync).toBe(true);
  });

  it('ignores the meta-placeholders that name the token SHAPE', () => {
    // "Tokens use {{snake_case}}" is prose about tokens, not a token.
    expect([...tokensIn('Tokens use {{snake_case}}; a {{token}} is replaced.')]).toEqual([]);
  });

  it('names the silent-no-op mechanism in the MIRROR_ONLY report', () => {
    // The report is the whole user interface of the probe. An operator who
    // reads "drift" without "silent no-op" has no reason to treat a green
    // pdd-to-work-order-qa as untrustworthy, which is what happened twice.
    const out = formatTokenDrift(diffTemplateTokens(MIRROR_BACKGROUND, LIVE_BACKGROUND), 'TPL123');
    expect(out).toContain('TPL123');
    expect(out).toContain('MIRROR_ONLY');
    expect(out).toContain('{{partner_first_reference}}');
    expect(out).toMatch(/silent no-op/i);
    // Re-bootstrapping mints a NEW file id and drops the style retrofit
    // (skills/pdd-to-work-order/references/style-guide.md § retrofit), so the
    // remediation must not read as "re-run the bootstrap".
    expect(out).toMatch(/do\s*\n?\s*NOT re-bootstrap/);
  });

  it('says OK, and names the template, when the two agree', () => {
    const out = formatTokenDrift(diffTemplateTokens('{{a}}', '{{a}}'), 'TPL123');
    expect(out).toMatch(/^OK\b/);
    expect(out).toContain('TPL123');
  });
});
