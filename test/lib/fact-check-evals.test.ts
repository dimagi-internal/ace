/**
 * The three former LLM fact-check evals, now graded in code
 * (lib/app-release-check.ts, lib/connect-opp-config-check.ts,
 * lib/ocs-widget-handoff-check.ts over lib/deterministic-verdict.ts).
 *
 * Fixture shapes follow the producers' declared contracts:
 * `skills/app-release/SKILL.md § Products` (summary frontmatter),
 * `mcp/connect/backends/commcare.ts` `DownloadCczResult`,
 * `mcp/connect/types.ts` `Opportunity` / `PaymentUnit` / `DeliverUnit`, and
 * `lib/phase-products-schema.ts` `products.connect` / `products.ocs_chatbot`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateVerdict } from '../../lib/verdict-schema';
import { composeVerdict, parseResidue } from '../../lib/deterministic-verdict';
import { checkAppRelease } from '../../lib/app-release-check';
import { checkConnectOppSetup, checkOppConfigFacts, expectedPaymentUnitCount } from '../../lib/connect-opp-config-check';
import { checkWidgetHandoff, findCredentialLeaks } from '../../lib/ocs-widget-handoff-check';

const SUMMARY = `---
apps:
  learn_app:   { hq_app_id: 5e1c0a7f4b2d4e8a9c3f1b2d3e4f5a6b, build_id: 9a8b7c6d5e4f4a3b2c1d0e9f8a7b6c5d, version: 3, is_released: true, released_at: 2026-10-15T21:40:00Z }
  deliver_app: { hq_app_id: 58ef8132e5ac4b5cafa575d9d570c368, build_id: 1f2e3d4c5b6a4978a1b2c3d4e5f60718, version: 9, is_released: true, released_at: 2026-10-15T22:05:00Z }
---
# App release
`;

const LEARN_CCZ = {
  connect_markers: { deliver: 0, module: 6, task: 0, assessment: 1 },
  projected_connect_state: {
    deliver_units: [],
    learn_modules: [{ slug: 'm0_intro', first_seen_in: 'modules-0/forms-0.xml' }],
    assessments: [{ slug: 'post_test', first_seen_in: 'modules-5/forms-0.xml' }],
    collision_count: 0,
    oversized_slugs: { deliver_units: [], learn_modules: [] },
  },
};
const DELIVER_CCZ = {
  connect_markers: { deliver: 1, module: 0, task: 0, assessment: 0 },
  projected_connect_state: {
    deliver_units: [{ slug: 'community_meeting', name: 'Community meeting', first_seen_in: 'modules-1/forms-0.xml' }],
    learn_modules: [],
    assessments: [],
    collision_count: 0,
    oversized_slugs: { deliver_units: [], learn_modules: [] },
  },
};

describe('composeVerdict', () => {
  it('a BLOCKER fails the verdict even when the weighted mean would pass', () => {
    const v = composeVerdict({
      skill: 'x-eval', target: 'o/r', capturePath: 'p.md', liveStateVerified: true, checks: [],
      dimensions: { a: { score: 9, weight: 0.5, note: '', source: 'deterministic' }, b: { score: 8, weight: 0.5, note: '', source: 'deterministic' } },
      autoSurfaced: [{ severity: 'BLOCKER', message: 'must fix' }],
    });
    expect(v.verdict).toBe('fail');
  });
  it('two WARNs cap at 8.5 and land warn; PLATFORM/DRIFT never count', () => {
    const base = { skill: 'x-eval', target: 'o/r', capturePath: 'p.md', liveStateVerified: true, checks: [], dimensions: { a: { score: 10, weight: 1, note: '', source: 'deterministic' as const } } };
    expect(composeVerdict({ ...base, autoSurfaced: [{ severity: 'WARN', message: '1' }, { severity: 'WARN', message: '2' }] })).toMatchObject({ verdict: 'warn', overall_score: 8.5, overall_score_pre_cap: 10 });
    expect(composeVerdict({ ...base, autoSurfaced: [{ severity: 'PLATFORM', message: '1' }, { severity: 'DRIFT', message: '2' }] }).verdict).toBe('pass');
  });
  it('unverified live state downgrades pass to partial (≤ 8.5)', () => {
    const v = composeVerdict({ skill: 'x-eval', target: 'o/r', capturePath: 'p.md', liveStateVerified: false, checks: [], autoSurfaced: [], dimensions: { a: { score: 10, weight: 1, note: '', source: 'deterministic' } } });
    expect(v).toMatchObject({ verdict: 'partial', overall_score: 8.5 });
  });
  it('residue must carry a score and a reason', () => {
    expect(() => parseResidue({ deployability: { score: 8 } }, { deployability: 0.22 })).toThrow(/note/);
    expect(() => parseResidue({}, { deployability: 0.22 })).toThrow(/numeric score/);
  });
});

describe('app-release-eval (deterministic)', () => {
  const base = { target: 'spark/20261001-2208', releaseSummaryText: SUMMARY, ccz: { learn: LEARN_CCZ, deliver: DELIVER_CCZ }, payableDeliverSlugs: ['community_meeting'] };

  it('a clean dual release passes and validates against the verdict schema', () => {
    const v = checkAppRelease(base);
    expect(v.verdict).toBe('pass');
    expect(v.overall_score).toBe(10);
    expect((v as Record<string, unknown>).method).toBe('deterministic');
    expect(validateVerdict(v).ok).toBe(true);
  });

  it('is incomplete ONLY when the owned summary is missing (ace#1567)', () => {
    expect(checkAppRelease({ ...base, releaseSummaryText: null }).verdict).toBe('incomplete');
    expect(checkAppRelease({ ...base, releaseSummaryText: '---\nfoo: 1\n---\n' }).verdict).toBe('incomplete');
    // absent corroboration is never incomplete
    expect(checkAppRelease({ ...base, ccz: {} }).verdict).toBe('partial');
  });

  it('an unreleased app is a BLOCKER fail', () => {
    const v = checkAppRelease({ ...base, releaseSummaryText: SUMMARY.replace(/(deliver_app:.*)is_released: true/, '$1is_released: false') });
    expect(v.verdict).toBe('fail');
    expect(v.dimensions.both_apps_released.score).toBe(6);
  });

  it('a Deliver CCZ with zero deliver units fails', () => {
    const empty = { connect_markers: { deliver: 0 }, projected_connect_state: { deliver_units: [], collision_count: 0 } };
    const v = checkAppRelease({ ...base, ccz: { learn: LEARN_CCZ, deliver: empty } });
    expect(v.verdict).toBe('fail');
  });

  it('units < forms is not a deduction when the payable slugs all appear (ace#1331)', () => {
    const v = checkAppRelease(base);
    expect(v.dimensions.deliver_units_enumerable.score).toBe(10);
  });

  it('a unit on an unpaid form is a WARN, a missing payable unit deducts 4', () => {
    const v = checkAppRelease({ ...base, payableDeliverSlugs: ['community_meeting', 'household_visit'] });
    expect(v.dimensions.deliver_units_enumerable.score).toBe(6);
    const w = checkAppRelease({ ...base, payableDeliverSlugs: ['other_unit'] });
    expect((w.auto_surfaced ?? []).some((a) => a.severity === 'WARN' && /not declare payable/.test(a.message))).toBe(true);
  });

  it('a failed CCZ download is PLATFORM + partial, not a deduction', () => {
    const v = checkAppRelease({ ...base, ccz: { learn: LEARN_CCZ, deliver: null } });
    expect(v.verdict).toBe('partial');
    expect((v.checks ?? []).find((c) => c.name === 'ccz-projection-deliver')?.status).toBe('unable');
  });
});

// ── connect-opp-setup-eval ────────────────────────────────────────────────
const PDD = `# PDD
## Program Parameters
| Key | Value |
|---|---|
| payment_rate_min | 3 |
| payment_rate_max | 5 |
| daily_cap_per_flw | 4 |
| total_cap_per_flw | 60 |
| opportunity_currency | NGN |
| opportunity_start_date | 2026-11-02 |
| opportunity_end_date | 2027-02-26 |
`;
const OPP_ID = '249ad8fe-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const opp = {
  id: OPP_ID, name: 'Kaduna graduation — ACE', active: true, is_test: true, currency: 'NGN',
  start_date: '2026-11-02', end_date: '2027-02-26',
  deliver_app: { cc_domain: 'connect-ace-prod', cc_app_id: '58ef8132e5ac4b5cafa575d9d570c368', name: 'Deliver' },
};
const liveBase = {
  target: 'kaduna/20261015-1411',
  archetype: 'longitudinal-visits',
  pddText: PDD,
  products: { opportunity: { id: OPP_ID, verification: { form_field_rules: [{ name: 'consent_confirmed=yes', question_path: 'form.consent_grp.consent', question_value: 'yes', deliver_unit_id: 7084 }], form_field_rules_saved: 1 } } },
  opportunity: opp,
  paymentUnits: [{ id: 1, name: 'Per verified visit', payment_unit_uuid: 'aece2d58-bc28-41c0-ba77-5b4155652202' }],
  createdPaymentUnits: [{ id: 2495, name: 'Per verified visit', amount: 4, max_daily: 4, max_total: 60, required_deliver_units: [7084], optional_deliver_units: [] }],
  deliverUnits: [{ id: 1, server_id: 7084, name: 'Community meeting', slug: 'community_meeting' }],
  testUserInvite: { match: { phone: '+15555550100', claimed: false } },
  payableDeliverSlugs: ['community_meeting'],
  expectedHqDeliverAppId: '58ef8132e5ac4b5cafa575d9d570c368',
};
const RESIDUE = { deployability: { score: 8.5, note: 'NGN 4/visit × 4/day clears the Kaduna field-worker day rate' }, archetype_config_coherence: { score: 9, note: 'one PU over the arc, consent rule on the payable form' } };

describe('connect-opp-setup-eval facts (deterministic) + residue', () => {
  it('a faithful opportunity passes with the judgment residue folded in', () => {
    const v = checkConnectOppSetup({ ...liveBase, residue: RESIDUE });
    expect(v.verdict).toBe('pass');
    expect((v as Record<string, unknown>).method).toBe('deterministic+judgment-residue');
    expect(Object.keys(v.dimensions).sort()).toEqual(['active_window_status', 'archetype_config_coherence', 'deliver_unit_wiring', 'deployability', 'payment_unit_fit', 'verification_flag_fidelity']);
    expect(validateVerdict(v).ok).toBe(true);
  });

  it('refuses to compose a final verdict without the residue', () => {
    expect(() => checkConnectOppSetup(liveBase)).toThrow(/residue/);
  });

  it('an XPath question_path is a BLOCKER (ace#1301)', () => {
    const f = checkOppConfigFacts({ ...liveBase, products: { opportunity: { id: OPP_ID, verification: { form_field_rules: [{ name: 'c', question_path: '/data/consent', question_value: 'yes', deliver_unit_id: 7084 }], form_field_rules_saved: 1 } } } });
    expect(f.dimensions.verification_flag_fidelity.score).toBeLessThanOrEqual(3);
  });

  it('a boolean predicate (YAML 1.1 coerced yes) deducts (ace#2296)', () => {
    const f = checkOppConfigFacts({ ...liveBase, products: { opportunity: { id: OPP_ID, verification: { form_field_rules: [{ name: 'c', question_path: 'form.c', question_value: true, deliver_unit_id: 7084 }], form_field_rules_saved: 1 } } } });
    expect(f.dimensions.verification_flag_fidelity.score).toBe(8);
  });

  it('longitudinal-visits expects ONE payment unit for the whole arc (ace#2294)', () => {
    expect(expectedPaymentUnitCount('longitudinal-visits', ['a', 'b'])).toBe(1);
    expect(expectedPaymentUnitCount('multi-stage', ['a', 'b'])).toBe(2);
  });

  it('caps, band and currency are diffed against the PDD', () => {
    const f = checkOppConfigFacts({ ...liveBase, opportunity: { ...opp, currency: 'USD' }, createdPaymentUnits: [{ name: 'Per verified visit', amount: 9, max_daily: 2, max_total: 60, required_deliver_units: [7084] }] });
    expect(f.dimensions.payment_unit_fit.score).toBe(2); // −3 band, −2 daily, −3 currency
  });

  it('no create response = INFO-SKIPPED, never a deduction (the list read cannot see amounts, ace#1026)', () => {
    const f = checkOppConfigFacts({ ...liveBase, createdPaymentUnits: undefined });
    expect(f.dimensions.payment_unit_fit.score).toBe(10);
    expect(f.checks.find((c) => c.name === 'payment-unit-create-response')?.status).toBe('unable');
  });

  it('empty required_deliver_units in the create response is a BLOCKER (ace#843)', () => {
    const v = checkConnectOppSetup({ ...liveBase, createdPaymentUnits: [{ name: 'Per verified visit', amount: 4, max_daily: 4, max_total: 60, required_deliver_units: [] }], residue: RESIDUE });
    expect(v.verdict).toBe('fail');
  });

  it('is_test false, or activation unproven, fails active_window_status', () => {
    expect(checkOppConfigFacts({ ...liveBase, opportunity: { ...opp, is_test: false } }).dimensions.active_window_status.score).toBeLessThanOrEqual(3);
    expect(checkOppConfigFacts({ ...liveBase, testUserInvite: { match: null } }).dimensions.active_window_status.score).toBeLessThanOrEqual(3);
  });

  it('a window shorter than the PDD deducts 2', () => {
    expect(checkOppConfigFacts({ ...liveBase, opportunity: { ...opp, end_date: '2026-12-31' } }).dimensions.active_window_status.score).toBe(8);
  });

  it('wrong HQ Deliver app pointer is a BLOCKER', () => {
    const f = checkOppConfigFacts({ ...liveBase, expectedHqDeliverAppId: 'ffffffffffffffffffffffffffffffff' });
    expect(f.dimensions.deliver_unit_wiring.score).toBeLessThanOrEqual(3);
  });

  it('deployability ≤ 3 is the out-of-chain hard gate', () => {
    const v = checkConnectOppSetup({ ...liveBase, residue: { ...RESIDUE, deployability: { score: 2, note: 'rate below the local floor' } } });
    expect(v.verdict).toBe('fail');
  });

  it('degraded TBD-MANUAL artifacts are incomplete', () => {
    expect(checkConnectOppSetup({ ...liveBase, products: { opportunity: { id: 'TBD-MANUAL' } }, residue: RESIDUE }).verdict).toBe('incomplete');
  });
});

// ── ocs-widget-handoff-eval ───────────────────────────────────────────────
const PUBLIC_ID = '1fcddd08-3c2b-4a5d-9e8f-7a6b5c4d3e2f';
const EMBED_KEY = 'wDwe70vquTLx9kQ2';
const HANDOFF = `# OCS chatbot handoff

**What to do today:** share this public chat link with the LLO — it needs no configuration:
https://www.openchatstudio.com/c/Zx81kLmN0pQrStUvWxYz12345678abcd/

**Bound opportunity:** https://connect.dimagi.com/a/ace-nm/opportunity/${OPP_ID}/ (an identity reference, not a paste target — Connect has no per-opportunity widget field).

**Verify you have the right bot:** ask "How much am I paid per verified visit?" — the answer is opportunity-specific. The run check is the public_id ${PUBLIC_ID}.

**Held for CCC-301:** public_id ${PUBLIC_ID}, embed_key ${EMBED_KEY} — the widget embed becomes possible when CCC-301 ships.
`;
const wBase = {
  target: 'spark/20260925-1536',
  handoffText: HANDOFF,
  chatbot: { public_id: PUBLIC_ID, embed_key: EMBED_KEY, public_url: 'https://www.openchatstudio.com/c/Zx81kLmN0pQrStUvWxYz12345678abcd/' },
  opportunity: { id: OPP_ID },
  probe: { status: 200, body: '<html><title>Chat</title></html>' },
};

describe('ocs-widget-handoff-eval (deterministic)', () => {
  it('a clean handoff passes', () => {
    const v = checkWidgetHandoff(wBase);
    expect(v.verdict).toBe('pass');
    expect(validateVerdict(v).ok).toBe(true);
  });

  it('link_token, team_slug, public_id and embed_key are never hygiene findings (ace#1680)', () => {
    expect(findCredentialLeaks(HANDOFF + '\nteam_slug: connect-ace\nlink_token: Zx81kLmN0pQrStUvWxYz12345678abcd')).toEqual([]);
  });

  it('a cross-opportunity credential auto-fails, by name or by verbatim value', () => {
    expect(checkWidgetHandoff({ ...wBase, handoffText: HANDOFF + '\nOCS_API_TOKEN=abcd1234efgh\n' }).verdict).toBe('fail');
    const v = checkWidgetHandoff({ ...wBase, handoffText: HANDOFF + '\nuse s3cr3t-labs-token-xyz\n', secretValues: { LABS_MCP_TOKEN: 's3cr3t-labs-token-xyz' } });
    expect(v.verdict).toBe('fail');
    expect(JSON.stringify(v)).not.toContain('s3cr3t-labs-token-xyz');
  });

  it('a phantom Connect paste-in instruction auto-fails clarity (ace#1811)', () => {
    const v = checkWidgetHandoff({ ...wBase, handoffText: HANDOFF + '\nNext, paste it into the Connect opp config tab.\n' });
    expect(v.dimensions.operator_instructions_clarity.score).toBeLessThanOrEqual(3);
    expect(v.verdict).toBe('fail');
  });

  it('a legacy /start/ URL only scores ≤ 6 (OCS #4209)', () => {
    const legacy = HANDOFF.replace(/https:\/\/www\.openchatstudio\.com\/c\/\S+/, `https://www.openchatstudio.com/a/connect-ace/chatbots/${PUBLIC_ID}/start/`);
    expect(checkWidgetHandoff({ ...wBase, handoffText: legacy }).dimensions.widget_url_resolves.score).toBe(6);
  });

  it('a 503 maintenance page is PLATFORM, not a deduction (ace#1812)', () => {
    const v = checkWidgetHandoff({ ...wBase, probe: { status: 503, body: 'maintenance' } });
    expect(v.dimensions.widget_url_resolves.score).toBe(10);
    expect(v.verdict).toBe('partial');
  });

  it('the "not published" banner deducts', () => {
    expect(checkWidgetHandoff({ ...wBase, probe: { status: 200, body: 'This chatbot is not published yet.' } }).dimensions.widget_url_resolves.score).toBe(6);
  });

  it('missing opportunity binding is a BLOCKER (≤ 4)', () => {
    const noOpp = HANDOFF.replace(/\*\*Bound opportunity:.*\n/, '');
    const v = checkWidgetHandoff({ ...wBase, handoffText: noOpp });
    expect(v.dimensions.connect_opp_binding.score).toBe(4);
    expect(v.verdict).toBe('fail');
  });

  it('a skipped probe is partial; a missing doc is incomplete', () => {
    expect(checkWidgetHandoff({ ...wBase, probe: undefined }).verdict).toBe('partial');
    expect(checkWidgetHandoff({ ...wBase, handoffText: null }).verdict).toBe('incomplete');
  });

  it('the readability residue may deduct at most 2, with a reason', () => {
    expect(checkWidgetHandoff({ ...wBase, clarityResidue: { deduction: 1.5, note: 'jargon-heavy' } }).dimensions.operator_instructions_clarity.score).toBe(8.5);
    expect(() => checkWidgetHandoff({ ...wBase, clarityResidue: { deduction: 4, note: 'x' } })).toThrow();
  });
});

describe('scripts/fact-check-eval.ts', () => {
  it('app-release writes a schema-valid verdict file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fce-'));
    writeFileSync(join(dir, 'summary.md'), SUMMARY);
    writeFileSync(join(dir, 'learn.json'), JSON.stringify(LEARN_CCZ));
    writeFileSync(join(dir, 'deliver.json'), JSON.stringify(DELIVER_CCZ));
    const out = join(dir, 'v.yaml');
    const root = resolve(__dirname, '..', '..');
    const r = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/fact-check-eval.ts'), 'app-release',
      '--summary', join(dir, 'summary.md'), '--learn-ccz', join(dir, 'learn.json'), '--deliver-ccz', join(dir, 'deliver.json'),
      '--payable-slugs', 'community_meeting', '--target', 'o/r', '--out', out], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const v = parseYaml(readFileSync(out, 'utf8'));
    expect(v.verdict).toBe('pass');
    expect(validateVerdict(v).ok).toBe(true);
  }, 30000);
});
