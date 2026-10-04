/**
 * The folded open-questions ledger (docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md,
 * owner-approved 2026-10-04): asks live on decision rows, `open-asks.yaml` is
 * the generated run-end safety net, and `review_ask: required-before` is the
 * only gate. Fixture: the real spark-facilitator/20261001-2208 decisions log,
 * plus the one row the spec found genuinely open and blocking
 * (`rct-sample-overlap`, category E).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DecisionRowSchema,
  DecisionRowStrictSchema,
  parseDecisionsYaml,
  type DecisionRow,
  type DecisionsLog,
} from '../../lib/decisions-schema.js';
import { auditDecisionsPlainLanguage, enrichDecisionsLog, openResiduals } from '../../lib/decisions-enrich.js';
import {
  buildOpenAsksFile,
  checkOpenAsksCarried,
  missingAskResiduals,
  openAsks,
  parseOpenAsksYaml,
  requiredBeforeBlockers,
  serializeOpenAsks,
} from '../../lib/open-asks.js';
import { assessRequiredBeforeAsks } from '../../lib/release-readiness.js';

const DIR = join(__dirname, '..', 'fixtures', 'decisions-backfill', 'spark-facilitator-20261001-2208');
const SPARK = parseDecisionsYaml(readFileSync(join(DIR, 'decisions.yaml'), 'utf8'));

const base = {
  phase: '1-design',
  skill: 'idea-to-pdd',
  source: 'PDD § Evaluation design',
  status: 'ai-default' as const,
  evidence_basis: 'inferred' as const,
  value_set_by: 'external' as const,
};

const RCT: DecisionRow = {
  ...base,
  id: 'rct-sample-overlap',
  question: 'May the pilot work in communities that are in the impact study sample?',
  'ai-default': 'Exclude study communities',
  options: ['Exclude study communities', 'Allow study communities'],
  plain: 'The pilot assumes it will not work in communities that are part of the impact study.',
  plain_question: 'May the pilot work in communities that are part of the impact study?',
  review_ask: 'required-before',
  needed_by: 'award',
  owner: 'partner',
  answer_channel: 'review',
  confirm_reason: 'The award could pick study communities, and nothing in the sources says whether that is allowed.',
};

const RWANDA: DecisionRow = {
  ...base,
  id: 'rwanda-expansion-scope',
  question: 'Does the pilot design cover Rwanda?',
  'ai-default': 'Malawi only',
  options: ['Malawi only', 'Malawi and Rwanda'],
  status: 'deferred',
  plain: 'The pilot covers Malawi only.',
  owner: 'partner',
  revisit_when: 'When the programme expands to Rwanda.',
};

function withRows(...rows: DecisionRow[]): DecisionsLog {
  return { ...SPARK, decisions: [...SPARK.decisions, ...rows] };
}

describe('schema: the four new fields, deferred, required-before', () => {
  it('accepts a well-formed required-before row and a deferred row on the strict write path', () => {
    expect(DecisionRowStrictSchema.safeParse(RCT).success).toBe(true);
    expect(DecisionRowStrictSchema.safeParse(RWANDA).success).toBe(true);
  });

  it('required-before requires needed_by', () => {
    const { needed_by: _n, ...noGate } = RCT;
    const r = DecisionRowSchema.safeParse(noGate);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('needed_by');
  });

  it('recommended-confirmation does not require needed_by', () => {
    const { needed_by: _n, ...row } = RCT;
    expect(DecisionRowSchema.safeParse({ ...row, review_ask: 'recommended-confirmation' }).success).toBe(true);
  });

  it('revisit_when only with deferred; deferred carries no ask; a new deferred row needs revisit_when', () => {
    expect(DecisionRowSchema.safeParse({ ...RCT, revisit_when: 'Later.' }).success).toBe(false);
    expect(DecisionRowSchema.safeParse({ ...RWANDA, review_ask: 'recommended-confirmation', confirm_reason: 'x' }).success).toBe(false);
    const { revisit_when: _r, ...bare } = RWANDA;
    expect(DecisionRowSchema.safeParse(bare).success).toBe(true); // permissive read
    expect(DecisionRowStrictSchema.safeParse(bare).success).toBe(false); // strict write
  });

  it('answer_channel is review | call | solicitation:<id>', () => {
    for (const ok of ['review', 'call', 'solicitation:q7', 'solicitation:rct-overlap']) {
      expect(DecisionRowSchema.safeParse({ ...RCT, answer_channel: ok }).success, ok).toBe(true);
    }
    for (const bad of ['email', 'solicitation:', 'Review']) {
      expect(DecisionRowSchema.safeParse({ ...RCT, answer_channel: bad }).success, bad).toBe(false);
    }
  });

  it('needed_by is the closed lifecycle set — never "Before Phase N"', () => {
    expect(DecisionRowSchema.safeParse({ ...RCT, needed_by: 'Before Phase 9' }).success).toBe(false);
  });

  it('revisit_when is held to the plain-language gate, at the write boundary and over the log', () => {
    const jargon = { ...RWANDA, revisit_when: 'When Phase 9 starts for spark_rwanda.' };
    expect(DecisionRowStrictSchema.safeParse(jargon).success).toBe(false);
    const findings = auditDecisionsPlainLanguage({ decisions: [jargon] }).findings;
    expect(findings.map((f) => f.field)).toContain('revisit_when');
  });

  it('enrich never puts an ask on a deferred row', () => {
    const { log } = enrichDecisionsLog({ ...SPARK, decisions: [{ ...RWANDA, 'ai-default': 'OPEN — not decided', options: ['OPEN — not decided'] }] }, { runState: {} });
    expect(log.decisions[0].review_ask).toBeUndefined();
  });
});

describe('open asks', () => {
  it('lists live rows with an unanswered review_ask or status deferred', () => {
    const asks = openAsks(withRows(RCT, RWANDA));
    const ids = asks.map((a) => a.id);
    expect(ids).toContain('rct-sample-overlap');
    expect(ids).toContain('rwanda-expansion-scope');
    for (const a of asks) {
      expect(a.superseded_by).toBeUndefined();
      expect(a.review_ask !== undefined || a.status === 'deferred').toBe(true);
    }
  });

  it('a saved ruling in decision-overrides.yaml answers an ask written before it', () => {
    const asks = openAsks(withRows(RCT), {
      overrides: [{ id: 'rct-sample-overlap', override: 'Allow study communities', decided_by: 'jjackson@dimagi.com', decided_at: '2026-10-04' }],
    });
    expect(asks.map((a) => a.id)).not.toContain('rct-sample-overlap');
  });

  it('open-asks.yaml round-trips and carries only open asks', () => {
    const file = buildOpenAsksFile({ opp: 'spark-facilitator', runId: '20261001-2208', log: withRows(RCT, RWANDA), generatedAt: '2026-10-04T00:00:00Z' });
    const text = serializeOpenAsks(file);
    expect(text.startsWith('# GENERATED')).toBe(true);
    const back = parseOpenAsksYaml(text);
    expect(back).toEqual(file);
    expect(back.schema_version).toBe(1);
    expect(back.asks.every((a) => a.review_ask !== undefined || a.status === 'deferred')).toBe(true);
  });
});

describe('the required-before gate', () => {
  it('an unanswered required-before: award row blocks the award', () => {
    const r = requiredBeforeBlockers(withRows(RCT), { neededBy: 'award' });
    expect(r.blocking.map((a) => a.id)).toEqual(['rct-sample-overlap']);
    expect(r.blocking[0].question).toBe(RCT.plain_question);
  });

  it('the spark log alone has no required-before asks (its asks are all recommended-confirmation)', () => {
    expect(requiredBeforeBlockers(SPARK).blocking).toEqual([]);
  });

  it('a go-live ask does not block an award', () => {
    expect(requiredBeforeBlockers(withRows({ ...RCT, needed_by: 'go-live' }), { neededBy: 'award' }).blocking).toEqual([]);
  });

  it('the chosen response answering the named solicitation question closes it', () => {
    const viaSolicitation = { ...RCT, answer_channel: 'solicitation:rct-overlap' };
    const r = requiredBeforeBlockers(withRows(viaSolicitation), { neededBy: 'award', answeredSolicitationQuestions: ['rct-overlap'] });
    expect(r.blocking).toEqual([]);
    expect(r.closedBySolicitation.map((a) => a.id)).toEqual(['rct-sample-overlap']);
  });

  it('release readiness: required-before is a blocker naming the question; recommended-confirmation is not', () => {
    const files = (log: DecisionsLog) => [{ path: 'decisions.yaml', modifiedTime: '2026-10-04T00:00:00Z', text: JSON.stringify(log) }];
    const blocked = assessRequiredBeforeAsks(files(withRows(RCT)));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ id: 'required-before:rct-sample-overlap', severity: 'blocker', owner: 'idea-to-pdd' });
    expect(blocked[0].summary).toContain(RCT.plain_question);
    expect(assessRequiredBeforeAsks(files(withRows({ ...RCT, review_ask: 'recommended-confirmation' })))).toEqual([]);
    expect(
      assessRequiredBeforeAsks(files(withRows(RCT)), [
        { id: 'rct-sample-overlap', override: 'Allow study communities', decided_by: 'jjackson@dimagi.com', decided_at: '2026-10-04' },
      ]),
    ).toEqual([]);
  });
});

describe('nothing dropped between runs', () => {
  const prior = buildOpenAsksFile({ opp: 'spark-facilitator', runId: '20261001-2208', log: withRows(RCT, RWANDA), generatedAt: '2026-10-02T00:00:00Z' });

  it('every prior ask is carried when this run re-derives the same log', () => {
    const check = checkOpenAsksCarried({ prior, log: withRows(RCT, RWANDA) });
    expect(check.missing).toEqual([]);
    expect(check.carried.length).toBe(prior.asks.length);
  });

  it('a re-worded question still counts as carried; a dropped one is missing and becomes a residual', () => {
    const reworded = { ...RCT, id: 'study-community-overlap', plain_question: 'Can the pilot work in communities that are part of the impact study sample?' };
    const check = checkOpenAsksCarried({ prior, log: withRows(reworded) });
    expect(check.carried.find((c) => c.priorId === 'rct-sample-overlap')?.how).toBe('text');
    expect(check.missing.map((m) => m.id)).toContain('rwanda-expansion-scope');
    const residuals = missingAskResiduals(check);
    const rw = residuals.find((r) => r.what.includes('Malawi only') || r.what.includes('pilot covers Malawi'));
    expect(rw).toBeDefined();
    // decisions_enrich reads it back as a person-must-decide residual, so the
    // dropped ask comes back as an ask on THIS run — without the old value.
    const rs = { phases: { 'idea-to-design': { residuals } } };
    expect(openResiduals(rs).length).toBe(residuals.length);
    const { log } = enrichDecisionsLog({ ...SPARK, decisions: [] }, { runState: rs });
    const synthesized = log.decisions.filter((d) => d.id.startsWith('open-question-'));
    expect(synthesized.length).toBe(residuals.length);
    for (const s of synthesized) expect(s['ai-default']).not.toBe('Malawi only');
  });

  it('an answered ask counts as carried and closed', () => {
    const check = checkOpenAsksCarried({
      prior,
      log: withRows(RCT, RWANDA),
      overrides: [{ id: 'rct-sample-overlap', override: 'Allow study communities' }],
    });
    expect(check.carried.find((c) => c.priorId === 'rct-sample-overlap')?.answered).toBe(true);
  });

  it('Phase 1 only checks asks raised by phases it has reached', () => {
    const later = { ...RCT, id: 'later-ask', phase: '6-qa', question: 'Something unrelated entirely', plain: 'Unrelated.', plain_question: 'Unrelated?' };
    const p2 = buildOpenAsksFile({ opp: 'x', runId: 'r0', log: { decisions: [later] }, generatedAt: 't' });
    const check = checkOpenAsksCarried({ prior: p2, log: { decisions: [] }, throughOrdinal: 1 });
    expect(check.notYetDue).toEqual(['later-ask']);
    expect(check.missing).toEqual([]);
  });
});
