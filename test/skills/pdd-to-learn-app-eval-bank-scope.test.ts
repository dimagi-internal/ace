// ace#2923 — `assessment_rule_coverage` must say which scored banks it counts.
// On smallholder-seasonal/20261014-0859 the same Learn build scored 0.955
// (every bank) or 0.43 (pre-test + gate only) depending on the judge's reading,
// because § 5c step 3 assumed a pre-test and a post-test and never mentioned
// the non-gating per-module checks pdd-to-learn-app builds. Pin the resolved
// reading so a rubric edit cannot quietly reopen it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const RUBRIC = readFileSync('skills/pdd-to-learn-app-eval/SKILL.md', 'utf8');

describe('pdd-to-learn-app-eval assessment bank scope (ace#2923)', () => {
  it('§ 5c step 3 maps items across every scored bank, per-module checks included', () => {
    const step3 = RUBRIC.slice(RUBRIC.indexOf('3. **Map each scored item to the rule it keys on**'));
    expect(step3.slice(0, 600)).toMatch(/EVERY scored\s+bank/);
    expect(step3.slice(0, 600)).toMatch(/per-module checks/);
    expect(step3.slice(0, 600)).not.toMatch(/across BOTH the pre-test\s+and the post-test/);
  });

  it('the assessment_rule_coverage row counts every scored bank toward the numerator', () => {
    expect(RUBRIC).toContain('**Every scored bank counts toward the numerator** — pre-test, per-module checks and the gate alike');
  });

  it('assessment_gating (b) treats a rule tested only in a non-gating module check like the non-gating pre-test case', () => {
    expect(RUBRIC).toMatch(/only in the NON-GATING pre-test — or only in a non-gating per-module check/);
  });
});
