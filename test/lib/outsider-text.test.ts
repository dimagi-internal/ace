/**
 * The shared outsider-text checker (`auditOutsiderText`, the 'outsider'
 * profile of lib/pdd-description-plain-language.ts), proven on the verbatim
 * spark-facilitator ledger rows that motivated it (PR #2628).
 *
 * The ledger it was first written for is retired (owner decision 2026-10-04):
 * its markdown-level write gate (`checkOpenQuestionsPlainLanguage`) went with
 * it. The checker stays — `scripts/migrate-open-questions.ts` runs it on every
 * row it writes, and the decisions plain-language gate shares its table.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { auditOutsiderText, auditPddDescription } from '../../lib/pdd-description-plain-language';

const fixture = (name: string) =>
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/open-questions', name), 'utf8');

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
