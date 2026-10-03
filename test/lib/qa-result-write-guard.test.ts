/**
 * The QA-result write guard — the one place every `-qa` skill's result passes.
 *
 * Fixtures are the REAL result files two gates wrote, read from Drive
 * 2026-10-01: bednet-check-2-visit/20260908-1544's demo-data-setup-qa (19 checks
 * hand-written as `checks_total` / `checks[]`) and spark-facilitator/20260926-1800's
 * semantic-registry-author-qa (`{verdict, findings}`). ace-web read both as
 * "Passed (0/0 checks)".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { qaResultWriteRefusal } from '../../lib/qa-result-write-guard';
import { aggregateQAResult } from '../../lib/qa-types';

const FIX = join(__dirname, '../fixtures/qa-gaps');

describe('qaResultWriteRefusal', () => {
  it('refuses the real hand-rolled results that read as "Passed (0/0)"', () => {
    const bednet = readFileSync(join(FIX, 'bednet-check-2-visit-20260908-1544-demo-data-setup-qa_result.yaml'), 'utf8');
    const spark = readFileSync(join(FIX, 'spark-facilitator-20260926-1800-semantic-registry-author-qa_result.yaml'), 'utf8');
    expect(qaResultWriteRefusal('demo-data-setup-qa_result.yaml', bednet)).toMatch(/INVALID_QA_RESULT.*stats: Required/);
    expect(qaResultWriteRefusal('semantic-registry-author-qa_result.yaml', spark)).toMatch(/INVALID_QA_RESULT.*failures: Required/);
  });

  it('accepts the same gates written through the shared writer', () => {
    const spark = readFileSync(join(FIX, 'spark-facilitator-20260926-1800-semantic-registry-author-qa_result.yaml'), 'utf8');
    expect(spark).toMatch(/verdict: pass/);
    const canonical = aggregateQAResult({
      skill: 'semantic-registry-author-qa',
      target: 'spark-facilitator/20260926-1800',
      capture_path: '7-synthetic/semantic-registry-author_registry.json',
      outcomes: [{ check: 'labs-validate', result: { pass: true } }, { check: 'model', result: { pass: true } }],
    });
    expect(qaResultWriteRefusal('semantic-registry-author-qa_result.yaml', stringifyYaml(canonical))).toBeNull();
  });

  it('refuses a canonical-looking pass that checked nothing, and leaves other files alone', () => {
    const zero = readFileSync(join(FIX, 'spark-facilitator-20260926-1800-semantic-registry-author-qa_result.yaml'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace('findings: []', 'capture_path: x\nstats: {checks_run: 0, checks_passed: 0, checks_failed: 0}\nfailures: []');
    expect(qaResultWriteRefusal('x-qa_result.yaml', zero)).toMatch(/nothing was checked/);
    expect(qaResultWriteRefusal('run_state.yaml', 'not: [valid')).toBeNull();
  });
});

describe('verdictWriteRefusal', () => {
  const RC = join(__dirname, '../fixtures/release-readiness/spark-20260926-1800');
  it("refuses Spark's real learn-app verdict (a repeated key) and accepts a real well-formed one", async () => {
    const { verdictWriteRefusal } = await import('../../lib/qa-result-write-guard');
    const inv = JSON.parse(readFileSync(join(RC, 'inventory.json'), 'utf8')) as Array<{ path: string; text?: string }>;
    const learn = inv.find((f) => f.path.endsWith('pdd-to-learn-app-eval_verdict.yaml'))!.text!;
    expect(verdictWriteRefusal('pdd-to-learn-app-eval_verdict.yaml', learn)).toMatch(/INVALID_VERDICT.*Map keys must be unique/);
    const good = readFileSync(join(RC, 'build-memo-eval_verdict.yaml'), 'utf8');
    expect(verdictWriteRefusal('build-memo-eval_verdict.yaml', good)).toBeNull();
    expect(verdictWriteRefusal('build-memo-eval_verdict.yaml', 'just: a map\n')).toMatch(/verdict/);
    expect(verdictWriteRefusal('run_state.yaml', 'a: 1\na: 2\n')).toBeNull();
  });
});
