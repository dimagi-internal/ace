// connect-opp-setup's rule-row contract ↔ the plain-language gate (ace#2654).
//
// The skill mandates a closed `options` vocabulary for rule rows and requires
// `ai-default` to be one of them — but three of those labels are themselves
// jargon (`Connect form_field_rules`, `Connect deliver_unit_checks`,
// `CCZ constraint`), and the gate requires `plain_value` whenever `ai-default`
// is jargon. The contract never mentioned `plain_value`, so a compliant
// producer failed `decisions_enrich` on every rule placed on Connect's
// form-field rules or in the app: spark-facilitator/20261004-1706 re-emitted 9
// of 12 rows with `supersedes` to pass.
//
// These tests read the labels and the worked example FROM THE SKILL and run the
// REAL gate over them, so a new jargon label or a worked-example row without
// `plain_value` fails here rather than in a live Phase 4.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { auditDecisionsPlainLanguage, stampRow } from '../../lib/decisions-enrich';
import { plainLanguageFindings, RULE_ENFORCEMENT_PLAIN_VALUE } from '../../lib/decision-review';
import type { DecisionRow } from '../../lib/decisions-schema';

const SKILL = readFileSync('skills/connect-opp-setup/SKILL.md', 'utf8');

/** The rule-row `options` labels, read from the row-field table. */
function ruleOptionLabels(): string[] {
  const line = SKILL.split('\n').find((l) => l.startsWith('| `options` |'));
  if (!line) throw new Error('row-field table has no `options` row');
  const ruleCell = line.split('|')[2].split(';')[0];
  return [...ruleCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** The rows of the worked `decisions_append_rows` example, evaluated. */
function workedExampleRows(): DecisionRow[] {
  const block = [...SKILL.matchAll(/```[\w-]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .find((b) => b.includes('decisions_append_rows') && b.includes('connect-rule-'));
  if (!block) throw new Error('no worked rule-row example found');
  const start = block.indexOf('rows: [') + 'rows: '.length;
  const end = block.lastIndexOf(']');
  return new Function(`return ${block.slice(start, end + 1)};`)() as DecisionRow[];
}

const partnerRow = (aiDefault: string, extra: Partial<DecisionRow> = {}): DecisionRow =>
  ({
    id: 'connect-rule-example',
    phase: '4-connect',
    skill: 'connect-opp-setup',
    question: "Where is the PDD verification rule 'only a completed survey is payable' enforced?",
    'ai-default': aiDefault,
    options: [aiDefault],
    source: 'Targeting PDD §9',
    status: 'ai-default',
    evidence_basis: 'stated',
    value_set_by: 'ace',
    plain: 'Connect pays a survey only when the worker recorded it as completed.',
    reasoning: 'Placement. Spot-check: Connect › opportunity › verification rules.',
    ...extra,
  }) as DecisionRow;

describe('connect-opp-setup rule rows pass the plain-language gate (ace#2654)', () => {
  const labels = ruleOptionLabels();

  it('reads the closed label vocabulary (guards the guard)', () => {
    expect(labels).toContain('Connect form_field_rules');
    expect(labels).toContain('CCZ constraint');
    expect(labels.length).toBeGreaterThanOrEqual(7);
  });

  it('control: a jargon label with no plain_value fails the gate unstamped — the live failure', () => {
    const report = auditDecisionsPlainLanguage({ decisions: [partnerRow('Connect form_field_rules')] });
    expect(report.verdict).toBe('fail');
    expect(report.findings.map((f) => f.field)).toContain('plain_value');
  });

  it('every jargon label has a stamped plain wording, and that wording is itself plain', () => {
    for (const label of labels) {
      if (plainLanguageFindings(label).length === 0) continue;
      const words = RULE_ENFORCEMENT_PLAIN_VALUE[label];
      expect(words, `no plain wording for jargon label "${label}"`).toBeTruthy();
      expect(plainLanguageFindings(words)).toEqual([]);
    }
  });

  it('a row written with ANY label and no plain_value passes once the write boundary stamps it', () => {
    for (const label of labels) {
      const row = partnerRow(label);
      stampRow(row);
      const report = auditDecisionsPlainLanguage({ decisions: [row] });
      expect(report.findings, label).toEqual([]);
    }
  });

  it('the contract table names plain_value', () => {
    expect(SKILL).toMatch(/^\| `plain_value` \|/m);
  });

  it('every worked-example row passes the gate as written (no stamping), and the example covers a jargon label', () => {
    const rows = workedExampleRows();
    expect(rows.some((r) => plainLanguageFindings(r['ai-default']).length > 0)).toBe(true);
    for (const r of rows) {
      if (plainLanguageFindings(r['ai-default']).length > 0) expect(r.plain_value, r.id).toBeTruthy();
    }
    expect(auditDecisionsPlainLanguage({ decisions: rows }).findings).toEqual([]);
  });
});
