import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  checkOpenQuestionsPlainLanguage,
  isInternalOnlyOwner,
} from '../../lib/open-questions-plain-language';
import { auditOutsiderText, auditPddDescription } from '../../lib/pdd-description-plain-language';

const fixture = (name: string) =>
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/open-questions', name), 'utf8');
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/**
 * spark-facilitator's live ledger (Drive revision 6, read 2026-10-03): nine
 * `## Open` rows copied verbatim. ace-web shows `question:` / `answered_where:`
 * to the named owner on the public run-summary page, and these were written for
 * ACE — run-surface-audit-eval capped the page's jargon at 4/10.
 */
describe('checkOpenQuestionsPlainLanguage — the spark-facilitator rows', () => {
  const jargon = checkOpenQuestionsPlainLanguage(fixture('spark-facilitator-outsider-jargon.text-markdown.md'));
  const hits = (rowId: string) => jargon.findings.filter((f) => f.rowId === rowId).map((f) => f.token);

  it('refuses the verbatim rows', () => {
    expect(jargon.ok).toBe(false);
    expect(jargon.reason).toMatch(/^REFUSED/);
  });

  it('names row id and offending token for every row the issue cites', () => {
    expect(hits('household-count-denominator')).toContain('hh_count_tt');
    expect(hits('lookup-table-provisioning')).toEqual(expect.arrayContaining(['v1392', 'malawi_steps', 'project_type_fvs']));
    expect(hits('lookup-table-provisioning').filter((t) => /_/.test(t))).toHaveLength(12);
    expect(hits('phase-authoritative-writer')).toEqual(expect.arrayContaining(['m0f0', 'm0f3', 'm0f5', 'm0f8']));
    expect(hits('savings-indicator-denominator-bias')).toContain('currently_saving');
    expect(hits('group-photo-refusal-path')).toEqual(expect.arrayContaining(['decisions.yaml', 'PDD']));
    expect(hits('nya-tum-native-review')).toEqual(expect.arrayContaining(['Nova', 'update_translations']));
    expect(hits('s1-s6-indicators-not-computable')).toContain('ace#2590');
    expect(hits('payment-schedule-undefined')).toContain('§6');
    expect(jargon.reason).toContain('household-count-denominator: question');
  });

  it('scans question and answered_where only — latest: holds the evidence', () => {
    expect(new Set(jargon.findings.map((f) => f.field))).toEqual(new Set(['question', 'answered_where']));
    // `<bind nodeset=…>` lives in household-count-denominator's latest:, never reported.
    expect(jargon.findings.some((f) => f.token.startsWith('<bind'))).toBe(false);
  });

  it('exempts a row whose owner is internal only', () => {
    expect(jargon.exemptRowIds).toEqual(['solicitation-distribution-plan']);
    expect(hits('solicitation-distribution-plan')).toEqual([]);
  });

  it('passes the same rows rewritten for their owner, latest: untouched', () => {
    const plain = checkOpenQuestionsPlainLanguage(fixture('spark-facilitator-outsider-plain.text-markdown.md'));
    expect(plain.findings).toEqual([]);
    expect(plain.ok).toBe(true);
    expect(fixture('spark-facilitator-outsider-plain.text-markdown.md')).toContain('<bind nodeset="/data/hh_tt"');
  });

  it('leaves a doc with no ## Open to the shape check', () => {
    expect(checkOpenQuestionsPlainLanguage('# Open Questions\n\nno sections').ok).toBe(true);
  });
});

describe('isInternalOnlyOwner', () => {
  it.each(['ACE', 'Operator', 'operator', 'Connect team', 'Dimagi', 'ACE / Operator'])('%s is internal', (o) => {
    expect(isInternalOnlyOwner(o)).toBe(true);
  });
  it.each(['Spark', 'Spark / ACE', 'Spark M&E / ACE', 'awarded LLO'])('%s is not', (o) => {
    expect(isInternalOnlyOwner(o)).toBe(false);
  });
  it('treats a missing owner as outside (checked)', () => {
    expect(isInternalOnlyOwner(null)).toBe(false);
  });
});

describe('auditOutsiderText — the shared outsider-text checker', () => {
  it('flags the ledger-specific shapes', () => {
    const kinds = (t: string) => auditOutsiderText(t).map((i) => i.kind);
    expect(kinds('see PDD §4.2')).toContain('section_reference');
    expect(kinds('tracked in ace#2590')).toContain('issue_reference');
    expect(kinds('a decisions.yaml ruling')).toContain('internal_file');
    expect(kinds('the released .ccz')).toContain('internal_file');
    expect(kinds('forms m0f3 and m1f0')).toContain('form_id');
    expect(kinds('the v1392 app')).toContain('app_version');
    expect(kinds('the <update> block')).toContain('xml_markup');
    expect(kinds('a PDD revision')).toContain('ace_jargon');
    expect(kinds('a Nova review')).toContain('skill_or_tool_name');
  });

  it('flags every verbatim spark answered_where value, read from the captured ledger', () => {
    const md = fixture('spark-facilitator-outsider-jargon.text-markdown.md').replace(/\\([_#&])/g, '$1');
    const values = [...md.matchAll(/\*\*answered_where:\*\* (.*?) \*\*blocking:/g)]
      .map((m) => m[1])
      .filter((v) => /decisions\.yaml|Nova|ace#|§/.test(v));
    expect(values).toHaveLength(4);
    for (const v of values) expect(auditOutsiderText(v)).not.toEqual([]);
  });

  it('passes the rewritten questions, read from the captured plain ledger', () => {
    const md = fixture('spark-facilitator-outsider-plain.text-markdown.md');
    const questions = [...md.matchAll(/\*\*question:\*\* (.*?) \*\*raised\\_by:/g)].map((m) => m[1]);
    expect(questions).toHaveLength(9);
    for (const q of questions.slice(0, 4)) expect(auditOutsiderText(q)).toEqual([]);
  });

  it('passes plain prose', () => {
    expect(
      auditOutsiderText(
        "Will Spark share its list of villages, or should the pilot keep its own? Answer in your reply to this review, or the implementing organisation's application.",
      ),
    ).toEqual([]);
  });

  it("keeps auditPddDescription on the original 'description' rules", () => {
    expect(auditPddDescription('Based on the PDD and the v1392 app.')).toEqual([]);
    expect(auditOutsiderText('Based on the PDD and the v1392 app.', 'description')).toEqual([]);
  });
});

describe('the row contract has ONE canonical home and every writer links to it', () => {
  const CONTRACT = 'Row contract — written for the named owner';

  it('idea-to-pdd states it', () => {
    expect(read('skills/idea-to-pdd/SKILL.md')).toContain(`### ${CONTRACT}`);
  });

  it.each([
    'agents/ace-orchestrator.md',
    'agents/orchestrator-reference.md',
    'skills/inbox-triage/SKILL.md',
    'skills/feedback-ledger/SKILL.md',
  ])('%s links to it rather than restating it', (rel) => {
    const doc = read(rel);
    expect(doc).toContain(CONTRACT);
    expect(doc).not.toContain(`### ${CONTRACT}`);
  });

  it.each(['agents/ace-orchestrator.md', 'skills/inbox-triage/SKILL.md', 'skills/idea-to-pdd/SKILL.md'])(
    '%s names the pre-write check',
    (rel) => {
      expect(read(rel)).toContain('checkOpenQuestionsPlainLanguage');
    },
  );
});
