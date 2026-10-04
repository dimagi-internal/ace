import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { auditPddDescription } from '../../lib/pdd-description-plain-language';
import { CHECKS, checkPddDescriptionPlainLanguage } from '../../skills/idea-to-pdd-qa/checks';

// products.pdd.description of spark-facilitator/20261001-2208, captured verbatim
// from that run's run_state.yaml — the opening paragraph of the public
// run-summary page that failed its outsider review.
const REPRO = (
  JSON.parse(
    readFileSync(new URL('../fixtures/pdd-description/spark-facilitator-20261001-2208.json', import.meta.url), 'utf8'),
  ) as { description: string }
).description;

const PLAIN =
  'Community facilitators in rural Kenya run monthly village meetings on child nutrition. Connect pays ' +
  'the facilitator for each community meeting they confirm took place — up to three paid meetings — and ' +
  'door-to-door follow-up by CHWs is recorded but not paid.';

describe('auditPddDescription', () => {
  it('flags every engineer-facing token in the 20261001-2208 description', () => {
    const issues = auditPddDescription(REPRO);
    const tokens = issues.map((i) => i.token);
    expect(tokens).toEqual(expect.arrayContaining(['meeting_conducted', 'meeting_type', 'community_meeting', 'AND']));
    expect(issues.filter((i) => i.kind === 'expression_operator')).toHaveLength(2);
  });

  it('flags run ids, code spans and template markers', () => {
    const kinds = auditPddDescription('Built on run 20261001-2208 from `pdd.md` for {{llo_name}}.').map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['run_id', 'code_markup']));
  });

  it('passes plain prose — lower-case "and", hyphenated words and acronyms are English', () => {
    expect(auditPddDescription(PLAIN)).toEqual([]);
  });
});

describe('idea-to-pdd-qa pdd_description_plain_language', () => {
  it('fails the reproducer and names the tokens', () => {
    const r = checkPddDescriptionPlainLanguage({ pddDescription: REPRO });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('meeting_conducted');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  it('passes a plain-language description', () => {
    expect(checkPddDescriptionPlainLanguage({ pddDescription: PLAIN }).pass).toBe(true);
  });

  it('fails, not passes, when the description was not supplied', () => {
    expect(checkPddDescriptionPlainLanguage({}).pass).toBe(false);
    expect(checkPddDescriptionPlainLanguage(undefined).pass).toBe(false);
  });

  it('is registered in CHECKS and reads ctx, not the PDD body', () => {
    const entry = CHECKS.find((c) => c.id === 'pdd_description_plain_language');
    expect(entry).toBeDefined();
    expect(entry!.run('# PDD\n', { pddDescription: REPRO })).toMatchObject({ pass: false });
    expect(entry!.run('# PDD\nmeeting_conducted = yes\n', { pddDescription: PLAIN })).toMatchObject({ pass: true });
  });
});
