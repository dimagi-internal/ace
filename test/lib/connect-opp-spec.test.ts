/**
 * Tests for `lib/connect-opp-spec.ts` and `scripts/validate-connect-opp-spec.ts`
 * — the spec gate in front of `/ace:connect-opp-create`'s irreversible create.
 *
 * Three jobs:
 *
 *  1. **Each rule fires on the shape that motivated it**, and does NOT fire on
 *     a healthy spec. A validator that rejects everything is as useless as one
 *     that rejects nothing, and only the second half of that is usually tested.
 *
 *  2. **Nothing fails OPEN.** The expensive bug in the first revision was not a
 *     wrong verdict, it was a missing one: `total_budget: "900"` produced zero
 *     issues because the type check returned early and the capacity check was
 *     gated on `typeof === 'number'`. So the malformed-input cases below assert
 *     a *blocking* issue, not merely "some issue".
 *
 *  3. **The template stays in sync with the validator.** `templates/…` and the
 *     validator are two statements of one contract; the template test pins them
 *     against the most likely future edit (someone adds a spec field).
 *
 * The invariants shared with the MCP boundary are IMPORTED from
 * `lib/connect-opp-invariants.ts` by both sides now, so there is no copy left
 * to pin — the anti-drift block this file used to carry was deleted along with
 * the duplication it policed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import {
  validateConnectOppSpec,
  hasBlockingIssue,
  formatSpecIssues,
  KNOWN_HQ_BASE_URLS,
  FORM_FIELD_RULE_NAME_MAX,
  SHORT_DESCRIPTION_MAX,
  type ConnectOppSpec,
  type OppSpecPaymentUnit,
} from '../../lib/connect-opp-spec.js';
import {
  numberOfUsers,
  fundsAtLeastOneUser,
  minBudgetForOneUser,
} from '../../lib/connect-opp-invariants.js';
import { assertFundsAtLeastOneUser } from '../../mcp/connect/opportunity-capacity.js';
import { assertRunIdNamePrefix } from '../../mcp/connect/opportunity-name.js';
import { runValidation } from '../../scripts/validate-connect-opp-spec.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A spec with every rule satisfied — the baseline every case mutates. */
function healthySpec(): ConnectOppSpec {
  return {
    organization_slug: 'ai-demo-space',
    program_id: '11111111-2222-3333-4444-555555555555',
    name: 'Bednet Spot-Check - Kano',
    short_description: 'Bednet spot-check visits in Kano',
    description: 'Field workers verify bednet presence and condition at household level.',
    start_date: '2026-09-15',
    end_date: '2026-12-15',
    total_budget: 900,
    passing_score: 80,
    is_test: false,
    learn_app: {
      cc_domain: 'connect-ace-prod',
      cc_app_id: 'a'.repeat(32),
      description: 'Bednet spot-check training',
      hq_server_url: 'https://www.commcarehq.org',
    },
    deliver_app: {
      cc_domain: 'connect-ace-prod',
      cc_app_id: 'b'.repeat(32),
      hq_server_url: 'https://www.commcarehq.org',
    },
    payment_units: [
      { name: 'Per verified visit', amount: 2, max_total: 100, required_deliver_units: [6617] },
    ],
    fund_users: 3,
  };
}

const codes = (s: unknown) => validateConnectOppSpec(s).map((i) => i.code);
/** Asserts the spec is REJECTED, not merely commented on. */
const blocks = (s: unknown) => hasBlockingIssue(validateConnectOppSpec(s));

describe('healthy baseline', () => {
  it('accepts a complete spec with no issues at all', () => {
    expect(validateConnectOppSpec(healthySpec())).toEqual([]);
  });

  it('reports every missing required field at once, not just the first', () => {
    const fields = new Set(validateConnectOppSpec({}).map((i) => i.field));
    for (const f of [
      'organization_slug', 'program_id', 'name', 'short_description', 'description',
      'start_date', 'end_date', 'total_budget', 'passing_score',
      'learn_app', 'deliver_app', 'payment_units',
    ]) {
      expect(fields, `expected an issue for ${f}`).toContain(f);
    }
  });

  it('suppresses child complaints when the parent block is absent', () => {
    // learn_app.description used to fire even with no learn_app at all.
    const fields = validateConnectOppSpec({}).map((i) => i.field);
    expect(fields).toContain('learn_app');
    expect(fields).not.toContain('learn_app.description');
    expect(fields).not.toContain('learn_app.cc_app_id');
  });

  it('rejects a spec that is not a mapping', () => {
    for (const bad of [null, undefined, 'a string', 42, ['a', 'list']]) {
      expect(codes(bad), String(bad)).toContain('spec_not_a_mapping');
    }
  });
});

describe('nothing fails open on malformed input', () => {
  // Each of these returned ZERO issues before the parse boundary existed.
  it('blocks a quoted (string) total_budget', () => {
    const s = { ...healthySpec(), total_budget: '900' };
    expect(codes(s)).toContain('not_a_number');
    expect(blocks(s)).toBe(true);
  });

  it('blocks NaN and Infinity budgets', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(blocks({ ...healthySpec(), total_budget: v }), String(v)).toBe(true);
    }
  });

  it('blocks a string amount instead of doing string arithmetic on it', () => {
    // "2" + 0 === "20" would silently make the opp look 10x underfunded.
    const s = healthySpec();
    s.payment_units = [
      { name: 'x', amount: '2' as unknown as number, max_total: 100, required_deliver_units: [1] },
    ];
    expect(codes(s)).toContain('not_a_number');
    expect(blocks(s)).toBe(true);
  });

  it('does not let one bad unit silently disable the capacity guard', () => {
    const s = healthySpec();
    s.total_budget = 1;
    s.payment_units = [
      { name: 'x', amount: NaN, max_total: 100, required_deliver_units: [1] },
    ];
    expect(blocks(s)).toBe(true);
  });

  it('returns issues rather than throwing on a non-list payment_units', () => {
    for (const bad of [{ a: 1 }, 'nope', 7]) {
      const s = { ...healthySpec(), payment_units: bad };
      expect(() => validateConnectOppSpec(s)).not.toThrow();
      expect(codes(s), JSON.stringify(bad)).toContain('payment_units_not_a_list');
    }
  });

  it('returns issues rather than throwing on wrong-typed blocks', () => {
    for (const key of ['learn_app', 'deliver_app', 'clone_from', 'verification_flags']) {
      const s = { ...healthySpec(), [key]: 'a string' };
      expect(() => validateConnectOppSpec(s)).not.toThrow();
      expect(codes(s), key).toContain('wrong_type');
    }
  });

  it('warns on an unknown top-level key so a typo is not silently defaulted', () => {
    const s = { ...healthySpec(), fund_uesrs: 5 };
    const issues = validateConnectOppSpec(s);
    expect(issues.map((i) => i.code)).toContain('unknown_key');
    expect(hasBlockingIssue(issues)).toBe(false);
  });
});

describe('server-enforced limits', () => {
  it('rejects a short_description over the cap but accepts one at it', () => {
    const over = { ...healthySpec(), short_description: 'x'.repeat(SHORT_DESCRIPTION_MAX + 1) };
    const at = { ...healthySpec(), short_description: 'x'.repeat(SHORT_DESCRIPTION_MAX) };
    expect(codes(over)).toContain('short_description_too_long');
    expect(codes(at)).not.toContain('short_description_too_long');
  });

  it('does not warn on a long description', () => {
    // The ~250-char threshold was never reproduced and the MCP boundary marks
    // it suspect-misattribution; re-warning would revive a retracted claim.
    const s = { ...healthySpec(), description: 'x'.repeat(4000) };
    expect(validateConnectOppSpec(s)).toEqual([]);
  });

  it('rejects the same HQ app on both sides, case-insensitively', () => {
    const s = healthySpec();
    s.deliver_app!.cc_app_id = s.learn_app!.cc_app_id!.toUpperCase();
    expect(codes(s)).toContain('same_app_both_sides');
  });

  it('rejects an inverted window but accepts a same-day one', () => {
    // Nothing cites a Connect rejection of end_date == start_date, so a
    // one-day opportunity must not be blocked on a prediction.
    const inverted = { ...healthySpec(), end_date: '2026-09-01' };
    const sameDay = { ...healthySpec(), start_date: '2026-09-15', end_date: '2026-09-15' };
    expect(codes(inverted)).toContain('window_inverted');
    expect(validateConnectOppSpec(sameDay)).toEqual([]);
  });

  it('separates a malformed date from an impossible one', () => {
    expect(codes({ ...healthySpec(), start_date: '15/09/2026' })).toContain('bad_date_format');
    const impossible = codes({ ...healthySpec(), start_date: '2026-13-45' });
    expect(impossible).toContain('impossible_date');
    // The old code reported this as a backwards window, which sent the
    // operator looking at the wrong field.
    expect(impossible).not.toContain('window_inverted');
  });

  it('checks passing_score boundaries, not just an obvious overflow', () => {
    for (const ok of [0, 80, 100]) {
      expect(codes({ ...healthySpec(), passing_score: ok }), String(ok))
        .not.toContain('bad_passing_score');
    }
    for (const bad of [-1, 101, 79.5]) {
      expect(codes({ ...healthySpec(), passing_score: bad }), String(bad))
        .toContain('bad_passing_score');
    }
  });

  it('warns when an app id is not bare 32-char hex', () => {
    const s = healthySpec();
    s.learn_app!.cc_app_id = 'https://www.commcarehq.org/a/x/apps/view/abc/';
    expect(codes(s)).toContain('app_id_shape');
  });

  it('warns when program_id is not UUID-shaped', () => {
    expect(codes({ ...healthySpec(), program_id: '12345' })).toContain('program_id_shape');
  });
});

describe('required_deliver_units is a hard pre-create gate', () => {
  it('blocks a payment unit with an empty list', () => {
    const s = healthySpec();
    s.payment_units = [{ name: 'x', amount: 2, max_total: 100, required_deliver_units: [] }];
    expect(codes(s)).toContain('no_required_deliver_units');
    expect(blocks(s)).toBe(true);
  });

  it('blocks a payment unit that omits the key entirely', () => {
    const s = healthySpec();
    s.payment_units = [
      { name: 'x', amount: 2, max_total: 100 } as unknown as OppSpecPaymentUnit,
    ];
    expect(codes(s)).toContain('no_required_deliver_units');
  });

  it('blocks a DU that is in both required and optional on one unit', () => {
    const s = healthySpec();
    s.payment_units = [{
      name: 'x', amount: 2, max_total: 100,
      required_deliver_units: [7], optional_deliver_units: [7],
    }];
    expect(codes(s)).toContain('deliver_unit_in_both_lists');
  });

  it('blocks the same DU required by two units in one request', () => {
    const s = healthySpec();
    s.payment_units = [
      { name: 'a', amount: 1, max_total: 10, required_deliver_units: [7] },
      { name: 'b', amount: 1, max_total: 10, required_deliver_units: [7] },
    ];
    expect(codes(s)).toContain('deliver_unit_reused_across_units');
  });

  it('allows two units requiring different DUs', () => {
    const s = healthySpec();
    s.payment_units = [
      { name: 'a', amount: 1, max_total: 10, required_deliver_units: [7] },
      { name: 'b', amount: 1, max_total: 10, required_deliver_units: [8] },
    ];
    expect(codes(s)).not.toContain('deliver_unit_reused_across_units');
  });
});

describe('currency is whole units, never cents', () => {
  it('rejects a fractional amount, naming the field', () => {
    const s = healthySpec();
    s.payment_units = [
      { name: 'Per visit', amount: 1.5, max_total: 100, required_deliver_units: [1] },
    ];
    expect(validateConnectOppSpec(s)).toContainEqual(
      expect.objectContaining({ code: 'non_integer_currency', field: 'payment_units[0].amount' }),
    );
  });

  it('rejects a negative amount', () => {
    const s = healthySpec();
    s.payment_units = [
      { name: 'x', amount: -2, max_total: 100, required_deliver_units: [1] },
    ];
    expect(codes(s)).toContain('negative_currency');
  });

  it('catches cents-as-amount via the capacity floor', () => {
    // $1.50 posted as 150 reads to Connect as $150/visit, so Sigma becomes
    // 15,000 against a 900 budget and no OpportunityClaim is ever created.
    const s = healthySpec();
    s.payment_units = [
      { name: 'Per visit', amount: 150, max_total: 100, required_deliver_units: [1] },
    ];
    expect(codes(s)).toContain('opportunity_underfunded');
  });

  it('warns but does not block when headroom is thin', () => {
    const s = { ...healthySpec(), total_budget: 250 };
    const issues = validateConnectOppSpec(s);
    expect(issues.map((i) => i.code)).toContain('thin_headroom');
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('blocks an opportunity with no payment unit at all', () => {
    for (const empty of [[], undefined]) {
      expect(codes({ ...healthySpec(), payment_units: empty })).toContain('no_payment_units');
    }
  });

  it('rejects a fund_users that would render nonsense advice', () => {
    for (const bad of [0, -3, 2.5]) {
      expect(codes({ ...healthySpec(), fund_users: bad }), String(bad))
        .toContain('bad_fund_users');
    }
  });

  it('warns on a payment unit that permits zero visits', () => {
    const s = healthySpec();
    s.payment_units = [
      { name: 'x', amount: 2, max_total: 0, required_deliver_units: [1] },
    ];
    expect(codes(s)).toContain('zero_max_total');
  });
});

describe('the is_test name prefix', () => {
  it('rejects an is_test opp whose name lacks the run-id prefix', () => {
    expect(codes({ ...healthySpec(), is_test: true })).toContain('invalid_opp_name_prefix');
  });

  it('accepts the prefixed form', () => {
    const s = { ...healthySpec(), is_test: true, name: '20260901-1430 · Bednet Spot-Check' };
    expect(codes(s)).not.toContain('invalid_opp_name_prefix');
  });

  it('leaves non-test opportunities alone - real opps keep human names', () => {
    expect(codes({ ...healthySpec(), is_test: false })).not.toContain('invalid_opp_name_prefix');
  });

  it('agrees with the MCP boundary guard on every case', () => {
    // Both now import one regex, so this is a behavioural spot-check rather
    // than a drift pin: the validator must not disagree with the thing that
    // will actually reject the create.
    for (const name of [
      '20260901-1430 · Bednet Spot-Check',
      'Bednet Spot-Check',
      '20260901-1430 - Bednet Spot-Check',
      '2026091-1430 · Bednet',
      ' 20260901-1430 · Bednet',
    ]) {
      const libRejects = validateConnectOppSpec({ ...healthySpec(), is_test: true, name })
        .some((i) => i.code === 'invalid_opp_name_prefix');
      let mcpRejects = false;
      try {
        assertRunIdNamePrefix(name, true);
      } catch {
        mcpRejects = true;
      }
      expect(libRejects, name).toBe(mcpRejects);
    }
  });
});

describe('secrets never live in a spec file', () => {
  it('blocks a literal HQ API key inlined into an app block', () => {
    const s = healthySpec() as ConnectOppSpec & { learn_app: Record<string, unknown> };
    s.learn_app.api_key = 'f'.repeat(40);
    expect(codes(s)).toContain('inlined_secret');
    expect(blocks(s)).toBe(true);
  });

  it('never echoes the secret back in the message', () => {
    const secret = 'f'.repeat(40);
    const s = healthySpec() as ConnectOppSpec & { learn_app: Record<string, unknown> };
    s.learn_app.api_key = secret;
    const rendered = formatSpecIssues(validateConnectOppSpec(s));
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('${ACE_HQ_API_KEY}');
  });

  it('allows the ${VAR} placeholder form', () => {
    const s = healthySpec() as ConnectOppSpec & { learn_app: Record<string, unknown> };
    s.learn_app.api_key = '${ACE_HQ_API_KEY}';
    expect(codes(s)).not.toContain('inlined_secret');
  });

  it('catches password / token / secret too, not just api_key', () => {
    for (const key of ['password', 'token', 'secret', 'apiKey']) {
      const s = { ...healthySpec(), [key]: 'hunter2' };
      expect(codes(s), key).toContain('inlined_secret');
    }
  });

  it('does not double-report a secret key as an unknown key', () => {
    const s = { ...healthySpec(), password: 'hunter2' };
    expect(codes(s)).not.toContain('unknown_key');
  });

  it('ignores an empty secret field rather than nagging about a blank template', () => {
    const s = healthySpec() as ConnectOppSpec & { deliver_app: Record<string, unknown> };
    s.deliver_app.api_key = '';
    expect(codes(s)).not.toContain('inlined_secret');
  });
});

describe('hq_server_url is required and allowlisted', () => {
  it('accepts every known cluster', () => {
    for (const url of KNOWN_HQ_BASE_URLS) {
      const s = healthySpec();
      s.learn_app!.hq_server_url = url;
      s.deliver_app!.hq_server_url = url;
      expect(codes(s), url).not.toContain('unknown_hq_host');
    }
  });

  it('blocks an unrecognised host - the exfiltration path', () => {
    const s = healthySpec();
    s.learn_app!.hq_server_url = 'https://commcarehq.evil.example';
    expect(codes(s)).toContain('unknown_hq_host');
    expect(blocks(s)).toBe(true);
  });

  it('blocks look-alikes a substring check would pass', () => {
    for (const url of [
      'https://www.commcarehq.org.evil.example',
      'http://www.commcarehq.org',
      'https://www.commcarehq.org/',
    ]) {
      const s = healthySpec();
      s.deliver_app!.hq_server_url = url;
      expect(codes(s), url).toContain('unknown_hq_host');
    }
  });

  it('requires the field - the atom does, so omitting it fails at create', () => {
    const s = healthySpec();
    delete s.learn_app!.hq_server_url;
    expect(codes(s)).toContain('missing_required_field');
  });
});

describe('invite phone numbers', () => {
  it('accepts E.164 and the ${VAR} placeholder', () => {
    const s = { ...healthySpec(), invite_phone_numbers: ['+74260000001', '${ACE_E2E_PHONE}'] };
    expect(codes(s)).not.toContain('bad_invite_phone');
  });

  it('blocks numbers that would queue and then reach nobody', () => {
    const s = { ...healthySpec(), invite_phone_numbers: ['0742 600 0001', '+0123', ''] };
    const bad = validateConnectOppSpec(s).filter((i) => i.code === 'bad_invite_phone');
    expect(bad).toHaveLength(3);
  });

  it('says nothing when there are no invites', () => {
    expect(codes(healthySpec())).not.toContain('bad_invite_phone');
  });
});

describe('verification flags', () => {
  it('blocks a form_field_rules name over the cap', () => {
    const s = healthySpec();
    s.verification_flags = {
      form_field_rules: [{
        name: 'x'.repeat(FORM_FIELD_RULE_NAME_MAX + 1),
        question_path: 'form.a.b', question_value: 'yes', deliver_unit_id: 1,
      }],
    };
    expect(codes(s)).toContain('rule_name_too_long');
  });

  it('blocks an XForm XPath where a JSONPath is required', () => {
    const s = healthySpec();
    s.verification_flags = {
      form_field_rules: [{
        name: 'Visit done', question_path: '/data/visit/completed',
        question_value: 'yes', deliver_unit_id: 1,
      }],
    };
    expect(codes(s)).toContain('xpath_not_jsonpath');
    expect(blocks(s)).toBe(true);
  });

  it('accepts a well-formed rule and time window', () => {
    const s = healthySpec();
    s.verification_flags = {
      form_field_rules: [{
        name: 'Visit done', question_path: 'form.visit.completed',
        question_value: 'yes', deliver_unit_id: 1,
      }],
      form_submission_start: '06:00:00',
      form_submission_end: '20:00:00',
    };
    expect(validateConnectOppSpec(s)).toEqual([]);
  });

  it('blocks a malformed submission time', () => {
    const s = healthySpec();
    s.verification_flags = { form_submission_start: '6am' };
    expect(codes(s)).toContain('bad_submission_time');
  });
});

describe('clone provenance', () => {
  it('refuses a clone that reuses the source Deliver app (ace#573)', () => {
    const s = healthySpec();
    s.clone_from = {
      opportunity_id: 'aaaa-bbbb',
      source_learn_app_id: 'c'.repeat(32),
      source_deliver_app_id: s.deliver_app!.cc_app_id,
    };
    expect(codes(s)).toContain('clone_reuses_deliver_app');
    expect(blocks(s)).toBe(true);
  });

  it('refuses a clone that reuses the source Learn app (ace#1350)', () => {
    const s = healthySpec();
    s.clone_from = {
      opportunity_id: 'aaaa-bbbb',
      source_learn_app_id: s.learn_app!.cc_app_id,
      source_deliver_app_id: 'd'.repeat(32),
    };
    expect(codes(s)).toContain('clone_reuses_learn_app');
  });

  it('catches reuse that differs only by case or whitespace', () => {
    // The two sides come from different places, so they are not guaranteed to
    // agree on case; an exact compare let the trap through.
    const s = healthySpec();
    s.clone_from = {
      opportunity_id: 'aaaa-bbbb',
      source_learn_app_id: 'c'.repeat(32),
      source_deliver_app_id: ` ${s.deliver_app!.cc_app_id!.toUpperCase()} `,
    };
    expect(codes(s)).toContain('clone_reuses_deliver_app');
  });

  it('accepts a clone once fresh app ids have been minted', () => {
    const s = healthySpec();
    s.clone_from = {
      opportunity_id: 'aaaa-bbbb',
      source_learn_app_id: 'c'.repeat(32),
      source_deliver_app_id: 'd'.repeat(32),
    };
    expect(validateConnectOppSpec(s)).toEqual([]);
  });

  it('warns when provenance is missing, since the guard then cannot run', () => {
    const s = healthySpec();
    s.clone_from = { opportunity_id: 'aaaa-bbbb' };
    const issues = validateConnectOppSpec(s);
    expect(issues.map((i) => i.code)).toContain('clone_without_provenance');
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('says nothing about app reuse when the spec is not a clone', () => {
    // Provenance is what makes reuse detectable; without it we must not invent
    // a complaint. Step 2's live check is what covers a hand-written spec.
    expect(codes(healthySpec())).not.toContain('clone_reuses_deliver_app');
  });
});

describe('formatSpecIssues', () => {
  it('reports no issues as such', () => {
    expect(formatSpecIssues([])).toBe('spec OK - no issues.');
  });

  it('sorts errors before warnings', () => {
    const s = { ...healthySpec(), program_id: '12345', total_budget: '900' };
    const lines = formatSpecIssues(validateConnectOppSpec(s)).split('\n');
    const firstWarn = lines.findIndex((l) => l.startsWith('[WARN]'));
    const lastError = lines.map((l) => l.startsWith('[ERROR]')).lastIndexOf(true);
    expect(firstWarn).toBeGreaterThan(lastError);
  });
});

describe('capacity invariants (shared with the MCP boundary)', () => {
  it('computes the documented formula', () => {
    const units = [
      { name: 'a', amount: 2, max_total: 100 },
      { name: 'b', amount: 3, org_amount: 1, max_total: 50 },
      { name: 'c', amount: 0, max_total: 10 },
    ];
    expect(minBudgetForOneUser(units)).toBe(100 * 2 + 50 * 4 + 0);
    expect(numberOfUsers(1200, units)).toBe(3);
  });

  it('treats non-finite input as unknown, never as fundable', () => {
    // `users < 1` is false for NaN, so the naive guard passed a malformed
    // budget on BOTH sides of the old duplication.
    const units = [{ name: 'a', amount: NaN, max_total: 100 }];
    expect(Number.isNaN(numberOfUsers(900, units))).toBe(true);
    expect(fundsAtLeastOneUser(900, units)).toBe(false);
    expect(fundsAtLeastOneUser(NaN, [{ name: 'a', amount: 2, max_total: 1 }])).toBe(false);
  });

  it('the MCP guard now throws on non-finite input too', () => {
    expect(() => assertFundsAtLeastOneUser(900, [{ name: 'a', amount: NaN, max_total: 100 }]))
      .toThrow();
    expect(() => assertFundsAtLeastOneUser(900, [{ name: 'a', amount: 2, max_total: 100 }]))
      .not.toThrow();
  });

  it('still treats a genuinely free opportunity as fundable', () => {
    expect(numberOfUsers(0, [{ name: 'a', amount: 0, max_total: 0 }])).toBe(Infinity);
    expect(() => assertFundsAtLeastOneUser(0, [{ name: 'a', amount: 0, max_total: 0 }]))
      .not.toThrow();
  });
});

describe('the shipped template matches the validator', () => {
  const templatePath = resolve(REPO_ROOT, 'templates/connect-opp-spec.yaml');
  const template = parse(readFileSync(templatePath, 'utf8'));

  it('parses as YAML and declares only known keys', () => {
    expect(template).toBeTypeOf('object');
    const unknown = validateConnectOppSpec(template).filter((i) => i.code === 'unknown_key');
    expect(unknown.map((i) => i.field)).toEqual([]);
  });

  it('fails only on the placeholders an operator is meant to fill in', () => {
    // Pins template <-> validator against the likeliest future edit: someone
    // adds a spec field to one and not the other.
    const got = new Set(validateConnectOppSpec(template).map((i) => i.code));
    expect([...got].sort()).toEqual([
      'missing_required_field',      // program_id, name, descriptions, dates, app ids
      'no_required_deliver_units',   // filled in between Step 5 and Step 6
      'opportunity_underfunded',     // total_budget: 0
    ].sort());
  });

  it('ships no secret and no unknown HQ host', () => {
    const codesFound = validateConnectOppSpec(template).map((i) => i.code);
    expect(codesFound).not.toContain('inlined_secret');
    expect(codesFound).not.toContain('unknown_hq_host');
  });
});

describe('the Step 1 gate script', () => {
  it('exits 1 with a blocking report on the unfilled template', () => {
    const { code, output } = runValidation(resolve(REPO_ROOT, 'templates/connect-opp-spec.yaml'));
    expect(code).toBe(1);
    expect(output).toContain('[ERROR]');
    expect(output).toContain('error(s)');
  });

  it('exits 2 - never 0 - when the file cannot be read', () => {
    // The bug this script replaced exited 0 on failure, and Step 1 reads a
    // clean exit as permission to create.
    const { code, output } = runValidation(resolve(REPO_ROOT, 'no-such-spec.yaml'));
    expect(code).toBe(2);
    expect(output).toContain('[FATAL]');
  });

  it('exits 2 on malformed YAML', () => {
    const bad = join(tmpdir(), `ace-bad-spec-${process.pid}.yaml`);
    // Unclosed flow mapping — a parse error, not a schema problem.
    writeFileSync(bad, 'name: {unclosed\n  - "also wrong\n');
    try {
      const { code, output } = runValidation(bad);
      expect(code).toBe(2);
      expect(output).toContain('not valid YAML');
    } finally {
      rmSync(bad, { force: true });
    }
  });

  it('exits 0 on a spec with only warnings', () => {
    const ok = join(tmpdir(), `ace-warn-spec-${process.pid}.yaml`);
    // program_id_shape is a warn, so the gate must let this through.
    writeFileSync(ok, stringify({ ...healthySpec(), program_id: '12345' }));
    try {
      const { code, output } = runValidation(ok);
      expect(code).toBe(0);
      expect(output).toContain('[WARN]');
      expect(output).not.toContain('[ERROR]');
    } finally {
      rmSync(ok, { force: true });
    }
  });
});
