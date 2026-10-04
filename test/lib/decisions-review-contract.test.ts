/**
 * The decisions review contract (schema v6, docs/decisions-contract.md) — the
 * decisions log replaces the per-run build memo as the review artifact
 * (owner decision 2026-10-03).
 *
 * Fixture: the real spark/spark-facilitator/20261001-2208 decisions.yaml and
 * run_state.yaml, its fork source's decisions.yaml (20260926-1800), and its
 * build memo exported as markdown — the comparison that motivated the
 * contract. The memo's "Decisions you own" listed five asks and its item 33
 * a sixth (the whole-group photo refusal); the decisions log marked none of
 * them (all 197 rows `status: ai-default`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  classifyRule,
  isInternalDecision,
  plainLanguageFindings,
  spotCheckPlaceFromReasoning,
} from '../../lib/decision-review';
import {
  dedupeCrossSkill,
  deriveReviewAsks,
  enrichDecisionsLog,
  openResiduals,
  reviewAskRows,
} from '../../lib/decisions-enrich';
import { backfillDecisionsLog, harvestMemo, type BackfillOverlay } from '../../lib/decisions-backfill';
import { retireForRerun, retireStaleInherited } from '../../lib/decisions-rerun';
import {
  DecisionRowStrictSchema,
  DecisionsLogSchema,
  liveDecisions,
  parseDecisionsYaml,
  resolveDecision,
  type DecisionRow,
  type DecisionsLog,
} from '../../lib/decisions-schema';
import { composeAppendedLog } from '../../lib/decisions-write';
import { renderDecisionsLog } from '../../lib/decisions-renderer';

const DIR = join(__dirname, '..', 'fixtures', 'decisions-backfill', 'spark-facilitator-20261001-2208');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const LOG = parseDecisionsYaml(read('decisions.yaml'));
const RUN_STATE = parseYaml(read('run_state.yaml'));
const SOURCE = parseDecisionsYaml(read('source-decisions.yaml'));
const MEMO = read('build-memo.md');
const OVERLAY = JSON.parse(read('overlay.json')) as BackfillOverlay;

const row = (over: Partial<DecisionRow> & { id: string }): DecisionRow =>
  ({
    phase: '3-commcare',
    skill: 'pdd-to-deliver-app',
    question: `Question for ${over.id}?`,
    'ai-default': 'a',
    options: ['a', 'b'],
    source: 'PDD § 1',
    status: 'ai-default',
    value_set_by: 'ace',
    evidence_basis: 'stated',
    plain: 'A plain line.',
    ...over,
  }) as DecisionRow;

const logOf = (decisions: DecisionRow[]): DecisionsLog => ({
  schema_version: 6,
  opportunity: 'opp',
  run_id: '20261003-0000',
  generated_at: '2026-10-03T00:00:00.000Z',
  decisions,
});

// ── The schema ─────────────────────────────────────────────────────────────

describe('schema v6 — the strict write contract', () => {
  const base = { ...row({ id: 'payment-rate', phase: '4-connect', skill: 'connect-opp-setup' }) };

  it('requires `plain` on a partner-facing row', () => {
    const { plain: _p, ...noPlain } = base;
    expect(() => DecisionRowStrictSchema.parse(noPlain)).toThrow(/`plain` is required/);
  });

  it('exempts ACE test-harness rows (by classifier or by audience: internal)', () => {
    const { plain: _p, ...noPlain } = base;
    expect(() => DecisionRowStrictSchema.parse({ ...noPlain, id: 'test-scenario-count', skill: 'app-test-cases' })).not.toThrow();
    expect(() => DecisionRowStrictSchema.parse({ ...noPlain, audience: 'internal' })).not.toThrow();
  });

  it('rejects jargon in `plain` and `confirm_reason`; a quoted rule keeps its words but not field ids', () => {
    expect(() => DecisionRowStrictSchema.parse({ ...base, plain: 'Set per PDD §14 on entity_key.' })).toThrow(/must read for a programme partner/);
    expect(() =>
      DecisionRowStrictSchema.parse({ ...base, review_ask: 'recommended-confirmation', confirm_reason: 'See ace#2419.' }),
    ).toThrow(/confirm_reason/);
    expect(() => DecisionRowStrictSchema.parse({ ...base, plain: '"at most 1 payable meeting per CBF per day" is held by Connect.' })).not.toThrow();
    // Quoting a field expression does not make it plain (spark-facilitator/20261001-2208).
    expect(() => DecisionRowStrictSchema.parse({ ...base, plain: '"meeting_conducted = yes" is held by Connect.' })).toThrow(/must read for a programme partner/);
  });

  it('pairs review_ask with confirm_reason, and scope with enforcement', () => {
    expect(() => DecisionRowStrictSchema.parse({ ...base, review_ask: 'recommended-confirmation' })).toThrow(/confirm_reason/);
    expect(() => DecisionRowStrictSchema.parse({ ...base, confirm_reason: 'Because.' })).toThrow(/only valid with `review_ask`/);
    expect(() => DecisionRowStrictSchema.parse({ ...base, scope: 'worker' })).toThrow(/set both or neither/);
    expect(() => DecisionRowStrictSchema.parse({ ...base, scope: 'worker', enforcement: 'gap' })).not.toThrow();
  });

  it('keeps old rows readable — every v6 field is optional on read', () => {
    expect(() => DecisionsLogSchema.parse(LOG)).not.toThrow();
    expect(LOG.schema_version).toBe(5);
  });
});

// ── Row-local computation ──────────────────────────────────────────────────

describe('rule scope and enforcement (moved from the build memo)', () => {
  it('a per-worker cap credited to an app check is rescoped onto the payment limit', () => {
    const c = classifyRule('at most 1 payable meeting per CBF per day', 'CCZ constraint. Backed by payment unit max_daily 1.');
    expect(c.scope).toBe('worker');
    expect(c.enforcement).toBe('enforced');
    expect(c.points[0].kind).toBe('connect-payment-unit');
    expect(c.correction).toMatch(/only covers one/);
  });

  it('a per-worker cap held ONLY by an app check is a gap (app checks are keyed on one case)', () => {
    expect(classifyRule('total cap 21 per CBF', 'CCZ constraint').enforcement).toBe('gap');
  });

  it('separates a rule Connect refused (gap) from one the design places off-platform (by-design)', () => {
    expect(classifyRule('meeting_conducted = yes', 'Not configurable on Connect — not applied. Connect refused.').enforcement).toBe('gap');
    expect(classifyRule('location captured for review only', 'Not configurable on Connect — applied elsewhere. Review.').enforcement).toBe(
      'by-design',
    );
  });

  it('a share-of-all-work rule is programme-scoped; a per-community rule is entity-scoped', () => {
    expect(classifyRule('review covers ≥ 20% of paid meetings', 'x').scope).toBe('programme');
    expect(classifyRule('at most 3 paid meetings per community per FCAP step', 'x').scope).toBe('entity');
  });

  it('recognises the harness rows the Spark memo moved out of its choices table', () => {
    for (const id of [
      'test-scenario-count',
      'test-archetype-coverage-rebuild',
      'deliver-smoke-leg-structure',
      'date-picker-screen-scroll-method-rebuild',
      'learn-smoke-long-lesson-walk',
      'test-prompt-count',
    ]) {
      expect(isInternalDecision({ id, skill: 'pdd-to-learn-app' }), id).toBe(true);
    }
    expect(isInternalDecision({ id: 'deliver-latitude-consent-scripts', skill: 'pdd-to-deliver-app' })).toBe(false);
  });

  it('reads check_at from the producers\' "Spot-check:" sentence', () => {
    expect(spotCheckPlaceFromReasoning('Because. Spot-check: Deliver app › Community Meeting Record › entity_key.')).toBe(
      'Deliver app › Community Meeting Record › entity key',
    );
    expect(spotCheckPlaceFromReasoning('No place named.')).toBeNull();
  });

  it('plain-language lint names what it found', () => {
    expect(plainLanguageFindings('Per PDD §4 via pdd-to-learn-app')).toEqual(
      expect.arrayContaining([expect.stringMatching(/section/), expect.stringMatching(/ACE jargon/), expect.stringMatching(/skill name/)]),
    );
    expect(plainLanguageFindings('Each worker is paid 7,500 MWK per verified meeting.')).toEqual([]);
  });
});

describe('the write boundary stamps what a row decides by itself', () => {
  it('internal audience, rule scope/enforcement and check_at land on append; the header moves to v6', () => {
    const r = composeAppendedLog({
      existingYamlText: null,
      opportunity: 'opp',
      run_id: '20261003-0000',
      now: () => '2026-10-03T00:00:00.000Z',
      rows: [
        { ...row({ id: 'test-scenario-count', skill: 'app-test-cases' }), plain: undefined },
        row({
          id: 'connect-rule-daily-limit',
          phase: '4-connect',
          skill: 'connect-opp-setup',
          question: "Where is the PDD verification rule 'at most 1 payable meeting per CBF per day' enforced?",
          'ai-default': 'Connect payment unit limit',
          options: ['Connect payment unit limit', 'CCZ constraint'],
          reasoning: 'max_daily 1. Spot-check: Connect › payment unit › max_daily.',
        }),
      ].map((x) => JSON.parse(JSON.stringify(x))),
    });
    const log = parseDecisionsYaml(r.content);
    expect(log.schema_version).toBe(6);
    expect(log.decisions[0].audience).toBe('internal');
    expect(log.decisions[1]).toMatchObject({ scope: 'worker', enforcement: 'enforced', check_at: 'Connect › payment unit › max daily' });
  });
});

describe('cross-skill duplicates fold into one row that cites both skills', () => {
  it('folds the ampersand question the Learn and Deliver builds both raised', () => {
    const log = JSON.parse(JSON.stringify(LOG)) as DecisionsLog;
    const { folded } = dedupeCrossSkill(log.decisions);
    expect(folded).toContainEqual(['learn-ambiguity-step-name-ampersand-verbatim', 'deliver-ambiguity-step-name-ampersand-verbatim']);
    const kept = resolveDecision(log, 'deliver-ambiguity-step-name-ampersand-verbatim');
    expect(kept?.id).toBe('learn-ambiguity-step-name-ampersand-verbatim');
    expect(kept?.also_raised_by).toEqual(['pdd-to-deliver-app']);
  });

  it('leaves a real disagreement (same question, different answers) alone', () => {
    const rows = [
      row({ id: 'a-one', skill: 'pdd-to-learn-app', question: 'Same?', 'ai-default': 'a' }),
      row({ id: 'b-one', skill: 'pdd-to-deliver-app', question: 'Same?', 'ai-default': 'b' }),
    ];
    expect(dedupeCrossSkill(rows).folded).toEqual([]);
  });
});

// ── Review asks ────────────────────────────────────────────────────────────

const EXPECTED_ASKS = [
  'connect-latitude-payment-amount-spark',
  'connect-latitude-org-amount-spark',
  'connect-latitude-total-budget-spark',
  'connect-latitude-opportunity-dates-spark',
  'working-language',
  'open-question-recording-path-whole-community-group-declines',
];

describe('review asks are derived from the run, not from model diligence', () => {
  it("reproduces the memo's six: rate, organisation payment, budget, dates, translation sign-off, group-photo refusal", () => {
    const asks = deriveReviewAsks(RUN_STATE, LOG.decisions);
    expect(asks.map((a) => a.id)).toEqual(EXPECTED_ASKS);
    expect(asks.find((a) => a.id === 'connect-latitude-payment-amount-spark')?.reason).toMatch(/7,500 MWK as a placeholder/);
    expect(asks.find((a) => a.id === 'working-language')?.reason).toMatch(/Chichewa and Tumbuka/);
  });

  it('pulls the whole-group photo refusal out of run_state residuals, once (Phase 3 and Phase 6 both list it)', () => {
    const open = openResiduals(RUN_STATE).filter((r) => /photo/.test(r.what));
    expect(open).toHaveLength(1);
    expect(open[0].phaseKey).toBe('commcare-setup');
    // resolved by Phase 4 / handled as a build step → no ask
    expect(openResiduals(RUN_STATE).some((r) => /payable_slot/.test(r.what))).toBe(false);
  });

  it('never asks about a value a person already ruled on', () => {
    const log = JSON.parse(JSON.stringify(LOG)) as DecisionsLog;
    const rate = log.decisions.find((d) => d.id === 'connect-latitude-payment-amount-spark')!;
    rate.status = 'overridden';
    rate.override = rate.options[0];
    expect(deriveReviewAsks(RUN_STATE, log.decisions).map((a) => a.id)).not.toContain(rate.id);
  });

  it('asks on an enforcement gap and on a row the build left OPEN', () => {
    const rows = [
      row({ id: 'connect-rule-total', phase: '4-connect', enforcement: 'gap', scope: 'worker' }),
      row({ id: 'connect-ambiguity-rules', phase: '4-connect', 'ai-default': 'OPEN — apply later', options: ['OPEN — apply later'] }),
    ];
    expect(deriveReviewAsks({}, rows).map((a) => a.basis)).toEqual(['enforcement: gap', 'OPEN']);
  });

  it('synthesizes a row when no row carries a PROPOSED parameter', () => {
    const rs = {
      phases: {
        'idea-to-design': {
          products: { pdd: { program_parameters: { total_budget: { amount: 100, currency: 'USD', status: 'PROPOSED' } } } },
        },
      },
    };
    const asks = deriveReviewAsks(rs, []);
    expect(asks[0].synthesize?.id).toBe('confirm-total-budget');
    expect(() => DecisionRowStrictSchema.parse(asks[0].synthesize)).not.toThrow();
  });

  it('enrichment is idempotent', () => {
    const once = enrichDecisionsLog(LOG, { runState: RUN_STATE }).log;
    const twice = enrichDecisionsLog(once, { runState: RUN_STATE });
    expect(twice.log).toEqual(once);
    expect(twice.report.asked).toEqual([]);
    expect(twice.report.appended).toEqual([]);
  });
});

// ── Re-runs ────────────────────────────────────────────────────────────────

describe('inherited rows on a re-run', () => {
  it('retireForRerun frees the canonical id and keeps the row as history (mirror of the ace-web fork)', () => {
    const { log, report } = retireForRerun(LOG, { phaseTags: ['5-ocs'], label: '20260926-1800' });
    expect(report.retired.map(([a]) => a)).toEqual(['system-prompt-baseline', 'rag-collection-scope', 'test-prompt-count']);
    expect(resolveDecision(log, 'system-prompt-baseline')).toBeUndefined();
    const moved = log.decisions.find((d) => d.id === 'system-prompt-baseline-20260926-1800')!;
    expect(moved).toMatchObject({ superseded_by: 'system-prompt-baseline', inherited_from_run: '20260926-1800' });
  });

  it('never retires a human ruling', () => {
    const log = logOf([row({ id: 'kept', status: 'overridden', override: 'b' })]);
    expect(retireForRerun(log, { fromOrdinal: 3, label: 'x' }).report.keptLive).toEqual(['kept']);
  });

  it('retireStaleInherited supersedes onto a successor, keeps the re-affirmed, retires the rest', () => {
    const log = logOf([row({ id: 'old-a' }), row({ id: 'old-b' }), row({ id: 'old-c' }), row({ id: 'new-a' })]);
    const { log: out, report } = retireStaleInherited(log, {
      inheritedIds: new Set(['old-a', 'old-b', 'old-c']),
      fromOrdinal: 3,
      label: 'src',
      successors: { 'old-a': 'new-a' },
      reaffirmed: new Set(['old-b']),
    });
    expect(report.supersededBy).toEqual([['old-a', 'new-a']]);
    expect(report.keptLive).toEqual(['old-b']);
    expect(report.retired).toEqual([['old-c', 'old-c-src']]);
    expect(liveDecisions(out).map((d) => d.id)).toEqual(['old-b', 'new-a']);
  });
});

// ── The Spark backfill, end to end ─────────────────────────────────────────

describe('backfill of spark/spark-facilitator/20261001-2208', () => {
  const memo = harvestMemo(MEMO);
  const { log, report } = backfillDecisionsLog({ log: LOG, runState: RUN_STATE, sourceLog: SOURCE, memo, overlay: OVERLAY });

  it("harvests the memo's 32 table rows that cite a decision, and its harness list", () => {
    expect(memo.choices.length).toBeGreaterThanOrEqual(31);
    expect(memo.choices.find((c) => c.n === 13)).toMatchObject({
      ids: ['deliver-latitude-education-options'],
      inherited: ['deliver-latitude-education-codes'],
      checkAt: 'Deliver app › Facilitator Registration › education',
    });
    expect(memo.harness).toContain('learn-smoke-long-lesson-walk');
  });

  it('marks the stale inherited payability discriminator superseded by the paid-slot key', () => {
    expect(resolveDecision(log, 'deliver-latitude-payability-discriminator')?.id).toBe('deliver-latitude-payable-slot-key-component');
    expect(report.retire?.badSuccessors).toEqual([]);
  });

  it('leaves no inherited Phase 3+ row live unless the re-run re-affirmed it', () => {
    const inherited = SOURCE.decisions.filter((d) => Number(d.phase.split('-')[0]) >= 3).map((d) => d.id);
    const liveInherited = liveDecisions(log)
      .map((d) => d.id)
      .filter((id) => inherited.includes(id));
    expect(liveInherited.sort()).toEqual(
      [
        'learn-latitude-module-layout',
        'learn-latitude-high-consequence-items',
        'deliver-latitude-community-child-of-cbf',
        'deliver-latitude-duplicate-enrolment-guard',
        'deliver-latitude-derived-case-writes-only',
        'deliver-unit-count',
        'learn-ambiguity-step-name-ampersand-verbatim',
        'test-scenario-count',
        'deliver-smoke-leg-structure',
        'program-delivery-type',
        'system-prompt-baseline',
        'rag-collection-scope',
        'test-prompt-count',
      ].sort(),
    );
  });

  it('carries exactly the six review asks, each with a plain line and a reason', () => {
    const asks = reviewAskRows(log);
    expect(asks.map((a) => a.id).sort()).toEqual([...EXPECTED_ASKS].sort());
    for (const a of asks) {
      expect(a.plain, a.id).toBeTruthy();
      expect(plainLanguageFindings(a.confirm_reason!), a.id).toEqual([]);
    }
  });

  it('formats the values a reviewer reads and asks each question in partner words', () => {
    const by = (id: string) => log.decisions.find((d) => d.id === id)!;
    expect(by('connect-latitude-payment-amount-spark')).toMatchObject({
      'ai-default': '7500',
      plain_value: '7,500 MWK',
      plain_question: 'What should a facilitator be paid per verified community meeting?',
    });
    expect(by('connect-latitude-org-amount-spark').plain_value).toBe('3,000 MWK');
    expect(by('connect-latitude-total-budget-spark').plain_value).toBe('3,276,000 MWK');
    expect(by('connect-latitude-opportunity-dates-spark').plain_value).toBe('2 November 2026 to 26 February 2027');
    for (const a of reviewAskRows(log)) {
      expect(a.plain_question, a.id).toBeTruthy();
      expect(plainLanguageFindings(a.plain_question!), a.id).toEqual([]);
      expect(a.plain_value ?? '', a.id).not.toMatch(/\[PROPOSED\]|^\d{4,}$/);
    }
    expect(by('open-question-recording-path-whole-community-group-declines').confirm_reason).toMatch(
      /^Only Spark and the implementing organisation can decide/,
    );
  });

  it('derives an ownership reason, not a design suggestion, for a residual a named party must decide (no overlay)', () => {
    const { log: bare } = backfillDecisionsLog({ log: LOG, runState: RUN_STATE, sourceLog: SOURCE, memo });
    expect(bare.decisions.find((d) => d.id === 'open-question-recording-path-whole-community-group-declines')?.confirm_reason).toMatch(
      /^Only Spark and the implementing organisation can decide how this is handled; as built/,
    );
  });

  it('gives every live partner row a plain line, free of jargon, and marks the harness internal', () => {
    expect(report.enrich.missingPlain).toEqual([]);
    expect(report.enrich.jargon).toEqual([]);
    expect(report.unknownIds).toEqual([]);
    const internal = liveDecisions(log).filter((d) => d.audience === 'internal').map((d) => d.id);
    expect(internal).toEqual(expect.arrayContaining(['test-scenario-count', 'learn-smoke-long-lesson-walk', 'test-prompt-count']));
  });

  it('stamps scope and enforcement on every live rule row, with no gap on this run', () => {
    const rules = liveDecisions(log).filter((d) => d.id.startsWith('connect-rule-'));
    expect(rules).toHaveLength(14);
    for (const r of rules) expect(r.scope && r.enforcement, r.id).toBeTruthy();
    expect(rules.find((r) => r.id === 'connect-rule-daily-limit-spark')?.scope).toBe('worker');
    expect(rules.filter((r) => r.enforcement === 'by-design')).toHaveLength(4);
    expect(rules.filter((r) => r.enforcement === 'gap')).toEqual([]);
  });

  it('writes a log every strict reader accepts, at v6', () => {
    expect(() => DecisionsLogSchema.parse(log)).not.toThrow();
    expect(log.schema_version).toBe(6);
    for (const d of log.decisions.filter((r) => report.enrich.appended.includes(r.id))) {
      expect(() => DecisionRowStrictSchema.parse(d)).not.toThrow();
    }
  });

  it('the decisions Doc leads with a "To confirm before launch" list of the live asks', () => {
    const text = renderDecisionsLog(log)
      .map((r) => ('insertText' in r ? r.insertText.text : ''))
      .join('');
    const at = text.indexOf('To confirm before launch');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(text.indexOf('Phase 1'));
    for (const id of EXPECTED_ASKS) expect(text).toContain(`(${id})`);
    expect(text).toContain('In plain words:');
    expect(text).toContain('PLEASE CONFIRM:');
  });
});
