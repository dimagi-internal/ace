// The plain-language gate over decisions.yaml — every row a partner reads on
// the public run-summary page must carry a plain sentence (and a plain value
// when the option is jargon), with no field ids, `=` expressions, run ids,
// platform record ids, issue numbers or "Phase N" in what is shown.
//
// Reproducer: spark-facilitator/20261001-2208. Its outsider review cited
// `entity_id`, `"meeting_conducted = yes"`, "opportunity ad6c2d40" and
// "(Phase 6)" in visible row text, and the existing lint passed every one of
// them (quoted spans were exempt; record ids and stage numbers were not rules).
// The fixture rows are verbatim from that run's decisions.yaml.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseDecisionsYaml, DecisionRowStrictSchema, type DecisionsLog, type DecisionRow } from '../../lib/decisions-schema';
import { auditDecisionsPlainLanguage, enrichDecisionsLog } from '../../lib/decisions-enrich';
import { plainForRule, plainLanguageFindings, quotedRule, spotCheckPlaceFromReasoning, classifyRule } from '../../lib/decision-review';
import { assessDecisionsPlainLanguage } from '../../lib/release-readiness';
import { auditPddDescription, auditOutsiderText } from '../../lib/pdd-description-plain-language';

const FIXTURE = 'test/fixtures/decisions-plain/spark-facilitator-20261001-2208.yaml';
const text = readFileSync(FIXTURE, 'utf8');
const SPARK: DecisionsLog = parseDecisionsYaml(readFileSync(FIXTURE, 'utf8'));
const byId = (id: string): DecisionRow => {
  const r = SPARK.decisions.find((d) => d.id === id);
  if (!r) throw new Error(`fixture lacks ${id}`);
  return r;
};
const audit = (rows: DecisionRow[]) => auditDecisionsPlainLanguage({ decisions: rows }).findings;
const tokens = (rows: DecisionRow[]) => audit(rows).map((f) => `${f.id}.${f.field}: ${f.finding}`);

describe('the shared checker catches what the spark page showed', () => {
  it('flags a quoted field expression — quoting does not make it a sentence', () => {
    const found = plainLanguageFindings(byId('connect-rule-meeting-conducted-yes-spark').plain!);
    expect(found.join(' ')).toContain('"meeting_conducted"');
    expect(found.join(' ')).toContain('expression operator');
  });

  it('flags a platform record id and a pipeline stage number', () => {
    expect(plainLanguageFindings('Connect › opportunity ad6c2d40 › verification rules').join(' ')).toContain('ad6c2d40');
    expect(plainLanguageFindings('training LLO guide (Phase 6)').join(' ')).toContain('Phase 6');
    expect(plainLanguageFindings('See #2512 for why.').join(' ')).toContain('#2512');
  });

  it('the shared table flags the verbatim spark check_at and stage aside, and passes their rewrites', () => {
    const row = (id: string) => SPARK.decisions.find((d) => d.id === id)!;
    expect(auditOutsiderText(row('connect-rule-meeting-conducted-yes-spark').check_at!, 'decision')).toHaveLength(1);
    expect(auditOutsiderText(row('payment-rate').plain!, 'decision')).toHaveLength(0);
    const kinds = (t: string) => auditOutsiderText(t, 'decision').map((i) => i.kind);
    expect(kinds(byId('connect-rule-meeting-conducted-yes-spark').check_at!)).toEqual(['opaque_id']);
    expect(kinds(byId('connect-rule-layer-b-review-spark').check_at!)).toEqual(['phase_reference']);
    expect(kinds(byId('deliver-latitude-payable-slot-key-component')['ai-default'])).toEqual(['snake_case_identifier', 'phase_reference']);
    expect(kinds(byId('payment-rate').plain!)).toEqual([]);
    expect(kinds(byId('deliver-latitude-payable-slot-key-component').check_at!)).toEqual([]);
  });

  it('flags a field id inside a quote', () => {
    expect(plainLanguageFindings(byId('connect-rule-no-duplicate-gps-flags-spark').plain!).join(' ')).toContain('entity_id');
  });

  it('passes plain prose, quoted words, money, dates and the unicode ≥', () => {
    for (const t of [
      'Each worker is paid 7,500 MWK per verified meeting.',
      '"at most 1 payable meeting per CBF per day" applies to each worker.',
      '"review covers ≥ 20% of paid meetings" applies to the programme as a whole.',
      '2 November 2026 to 26 February 2027',
      'Deliver app › Community Meeting Record › meeting photo',
    ]) expect(plainLanguageFindings(t), t).toEqual([]);
  });

  it('leaves the PDD description gate as it was — a programme may name its own "Phase 1 pilot"', () => {
    expect(auditPddDescription('The Phase 1 pilot runs in two districts.')).toEqual([]);
  });
});

describe('auditDecisionsPlainLanguage — the whole-log gate', () => {
  it('fails the verbatim spark rows, naming row id, field and token', () => {
    const report = auditDecisionsPlainLanguage(SPARK);
    expect(report.verdict).toBe('fail');
    expect(report.findings.length).toBeGreaterThan(0);
    const t = tokens(SPARK.decisions);
    expect(t).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^connect-rule-meeting-conducted-yes-spark\.plain: .*meeting_conducted/),
        expect.stringMatching(/^connect-rule-meeting-conducted-yes-spark\.check_at: .*ad6c2d40/),
        expect.stringMatching(/^connect-rule-no-duplicate-gps-flags-spark\.plain: .*entity_id/),
        expect.stringMatching(/^connect-rule-layer-b-review-spark\.check_at: .*Phase 6/),
        expect.stringMatching(/^deliver-latitude-payable-slot-key-component\.plain_value: missing .*payable_slot/),
      ]),
    );
  });

  it('fails a partner row with no `plain` (the spark row with its plain removed)', () => {
    const { plain: _p, ...noPlain } = byId('payment-rate');
    expect(tokens([noPlain as DecisionRow])).toEqual(['payment-rate.plain: missing']);
  });

  it('exempts internal rows — ace-web hides them — and superseded history', () => {
    const internal = byId('test-scenario-count');
    expect(internal.plain).toBeUndefined();
    expect(audit([internal])).toEqual([]);
    const { audience: _a, ...unmarked } = internal;
    expect(audit([unmarked as DecisionRow])).toEqual([]); // recognised by isInternalDecision
    expect(audit([{ ...byId('connect-rule-meeting-conducted-yes-spark'), superseded_by: 'x' }])).toEqual([]);
  });

  it('passes a row that already reads plainly', () => {
    expect(audit([byId('payment-rate')])).toEqual([]);
  });

  it('passes once the jargon rows are rewritten in plain words', () => {
    const rewritten: DecisionRow[] = [
      {
        ...byId('connect-rule-meeting-conducted-yes-spark'),
        plain: 'A meeting is paid only when the worker records that it took place; Connect and the app both check this.',
        plain_value: 'A Connect payment rule',
        check_at: 'Connect › opportunity › verification rules',
      },
      {
        ...byId('connect-rule-no-duplicate-gps-flags-spark'),
        plain: 'Duplicate records and location flags are checked outside Connect, by design, using each record\'s duplicate-check key.',
      },
      { ...byId('connect-rule-layer-b-review-spark'), check_at: 'the implementing organisation\'s training guide' },
      { ...byId('deliver-latitude-payable-slot-key-component'), plain_value: 'Only the first three meetings on a step are paid' },
      byId('payment-rate'),
      byId('test-scenario-count'),
    ];
    expect(rewritten).toHaveLength(SPARK.decisions.length);
    expect(auditDecisionsPlainLanguage({ decisions: rewritten }).findings).toHaveLength(0);
    expect(tokens(rewritten)).toEqual([]);
  });

  it('accepts an overridden row without a plain value — ace-web shows the human\'s answer', () => {
    const r = { ...byId('deliver-latitude-payable-slot-key-component'), override: 'x', status: 'overridden' as const };
    expect(audit([r]).filter((f) => f.field === 'plain_value')).toEqual([]);
  });
});

describe('the gate is wired into the paths that already validate decisions', () => {
  it('decisions_enrich reports a structural fail verdict with every failure', () => {
    const { report } = enrichDecisionsLog(SPARK, { runState: {} });
    expect(report.plainLanguageGate.verdict).toBe('fail');
    expect(report.plainLanguageGate.findings.map((f) => f.id)).toContain('connect-rule-meeting-conducted-yes-spark');
    expect(report.jargon.join(' ')).toContain('ad6c2d40');
  });

  it('release readiness blocks on it, one blocker per producing skill', () => {
    const findings = assessDecisionsPlainLanguage([{ path: 'decisions.yaml', modifiedTime: '2026-10-03T00:00:00Z', text }]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === 'blocker' && f.area === 'public-summary')).toBe(true);
    expect(findings.map((f) => f.owner)).toContain('connect-opp-setup');
    expect(findings.map((f) => f.detail).join(' ')).toContain('connect-rule-meeting-conducted-yes-spark.check_at');
    for (const f of findings) expect(plainLanguageFindings(`${f.summary} ${f.action}`), f.id).toEqual([]);
  });

  it('release readiness passes a clean log and skips a run with no decisions file', () => {
    const clean = text.replace(/^  - id: (?!payment-rate|test-scenario-count)[\s\S]*?(?=^  - id: |(?![\s\S]))/gm, '');
    expect(parseDecisionsYaml(clean).decisions.map((d) => d.id)).toEqual(['payment-rate', 'test-scenario-count']);
    expect(assessDecisionsPlainLanguage([{ path: 'decisions.yaml', modifiedTime: '', text: clean }])).toEqual([]);
    expect(assessDecisionsPlainLanguage([])).toEqual([]);
  });

  it('the strict write boundary refuses the spark plain and check_at text', () => {
    const r = byId('connect-rule-meeting-conducted-yes-spark');
    const base = { ...r, value_set_by: 'ace', evidence_basis: 'stated', plain: 'A plain line.', check_at: undefined };
    expect(() => DecisionRowStrictSchema.parse({ ...base, plain: r.plain })).toThrow(/`plain` must read for a programme partner/);
    expect(() => DecisionRowStrictSchema.parse({ ...base, check_at: r.check_at })).toThrow(/`check_at` must read/);
  });
});

describe('derived text is generated clean', () => {
  it('a rule written as an expression is spelled out, not quoted raw', () => {
    expect(quotedRule('at most 1 payable meeting per CBF per day')).toBe('"at most 1 payable meeting per CBF per day"');
    const q = quotedRule('meeting_conducted = yes AND meeting_type = community_meeting');
    expect(q).toBe('the design\'s rule "meeting conducted is yes and meeting type is community meeting"');
    const line = plainForRule(classifyRule('meeting_conducted = yes', 'Connect form_field_rules'));
    expect(plainLanguageFindings(line)).toEqual([]);
  });

  it('check_at drops record ids and stage asides from a Spot-check sentence', () => {
    expect(spotCheckPlaceFromReasoning('Why. Spot-check: Connect › opportunity ad6c2d40 › payment units.')).toBe('Connect › opportunity › payment units');
    expect(spotCheckPlaceFromReasoning('Why. Spot-check: training LLO guide (Phase 6).')).toBe('training LLO guide');
  });
});
