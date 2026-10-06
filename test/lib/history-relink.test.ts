import { describe, expect, it } from 'vitest';
import { buildRunIdMap, relinkText, relinkValue, type HistoryListing } from '../../lib/history-relink';

// The real rebuild on spark-facilitator/20261004-1706 (ace#2700): registry 7185
// v2 -> v3, programme report 7187 runs replaced, hand-downs to opp reports
// 7192/7194/7196 replaced. Last two weeks shown; ids verbatim from
// workflow_history_runs before and after.
const before: HistoryListing[] = [
  { workflowId: 7187, runs: [{ run_id: 7249, period_end: '2026-09-27' }, { run_id: 7254, period_end: '2026-10-04' }] },
  { workflowId: 7192, runs: [{ run_id: 7251, period_end: '2026-09-27' }, { run_id: 7256, period_end: '2026-10-04' }] },
  { workflowId: 7194, runs: [{ run_id: 7252, period_end: '2026-09-27' }, { run_id: 7257, period_end: '2026-10-04' }] },
  { workflowId: 7196, runs: [{ run_id: 7253, period_end: '2026-09-27' }, { run_id: 7258, period_end: '2026-10-04' }] },
];
const after: HistoryListing[] = [
  { workflowId: 7187, runs: [{ run_id: 7312, period_end: '2026-09-27' }, { run_id: 7317, period_end: '2026-10-04' }] },
  { workflowId: 7192, runs: [{ run_id: 7314, period_end: '2026-09-27' }, { run_id: 7319, period_end: '2026-10-04' }] },
  { workflowId: 7194, runs: [{ run_id: 7315, period_end: '2026-09-27' }, { run_id: 7320, period_end: '2026-10-04' }] },
  { workflowId: 7196, runs: [{ run_id: 7316, period_end: '2026-09-27' }, { run_id: 7321, period_end: '2026-10-04' }] },
];

describe('buildRunIdMap', () => {
  it('matches each workflow\'s runs on period_end', () => {
    const map = buildRunIdMap(before, after);
    expect(map.get(7254)).toBe(7317);
    expect(map.get(7256)).toBe(7319);
    expect(map.get(7257)).toBe(7320);
    expect(map.get(7258)).toBe(7321);
    expect(map.get(7249)).toBe(7312);
    expect(map.size).toBe(8);
  });

  it('refuses a period that vanished in the rebuild rather than leaving its links dead', () => {
    const short = after.map((l) => (l.workflowId === 7196 ? { ...l, runs: l.runs.slice(0, 1) } : l));
    expect(() => buildRunIdMap(before, short)).toThrow(/7196 period ending 2026-10-04/);
  });

  it('refuses a workflow with no after-listing', () => {
    expect(() => buildRunIdMap(before, after.slice(0, 1))).toThrow(/no after-listing for workflow 7192/);
  });

  it('leaves a period the rebuild skipped (same id) out of the map', () => {
    const same = [{ workflowId: 7187, runs: [{ run_id: 7254, period_end: '2026-10-04' }] }];
    expect(buildRunIdMap(same, same).size).toBe(0);
  });
});

describe('relinkText', () => {
  const map = buildRunIdMap(before, after);

  it('rewrites the realized.json URLs, including source_run on a worker-review link', () => {
    const realized = JSON.stringify({
      primary_par_url: 'https://labs.connect.dimagi.com/labs/workflow/7187/run/?run_id=7254&program_id=10097',
      worker_review_url:
        'https://labs.connect.dimagi.com/labs/workflow/7189/run/?run_id=7191&program_id=10097&flw=10099%3A%3Acbf_c12&source_run=7254',
      example_partner_c_opp_report_par_url:
        'https://labs.connect.dimagi.com/labs/workflow/7196/run/?run_id=7258&opportunity_id=10099',
    });
    const r = relinkText(realized, map);
    expect(r.text).toContain('run_id=7317&program_id=10097');
    expect(r.text).toContain('source_run=7317');
    expect(r.text).toContain('run_id=7321&opportunity_id=10099');
    // The worker-review run itself (7191) was not rebuilt and must survive.
    expect(r.text).toContain('run_id=7191');
    expect(r.replaced).toBe(3);
    expect(r.leftovers).toEqual([]);
  });

  it('rewrites YAML run_id fields but leaves prose for an explicit bare pass', () => {
    const yaml = 'programme_report:\n  run_id: 7254\nnote: latest saved run 7254, history 7249..7254\n';
    const r = relinkText(yaml, map);
    expect(r.text).toContain('run_id: 7317');
    expect(r.leftovers).toEqual([7254, 7249]);
    const bare = relinkText(yaml, map, { bare: true });
    expect(bare.text).toBe('programme_report:\n  run_id: 7317\nnote: latest saved run 7317, history 7312..7317\n');
    expect(bare.leftovers).toEqual([]);
  });

  it('does not touch a longer number or a decimal that contains an old id', () => {
    const r = relinkText('ids 172540 and 7254.5 and 37254', map, { bare: true });
    expect(r.text).toBe('ids 172540 and 7254.5 and 37254');
    expect(r.replaced).toBe(0);
  });

  // ace#2731: spark-facilitator/20261004-1706 cascade-story.yaml had its
  // community case id 7499fdb3-... rewritten to 7638fdb3-... by --bare.
  it('leaves a UUID whose leading hex run or a segment equals an old id untouched, and does not report it', () => {
    const text = [
      'entities:',
      '  - id: 7254fdb3-7dd5-0fda-ac03-c3ecca8f6cf4',
      '  - id: c3ecca8f-7254-0fda-ac03-7dd50fdac3ec',
      '  - id: c3ecca8f-0fda-ac03-7dd5-7254',
      '  - hash: 7254_cbf',
      '',
    ].join('\n');
    const r = relinkText(text, map, { bare: true });
    expect(r.text).toBe(text);
    expect(r.replaced).toBe(0);
    expect(r.leftovers).toEqual([]);
  });

  it('still rewrites prose ids next to punctuation in a bare pass', () => {
    const r = relinkText('run 7254, (7254) and 7249..7254 then 7254 → 7258.\n"7254"', map, { bare: true });
    expect(r.text).toBe('run 7317, (7317) and 7312..7317 then 7317 → 7321.\n"7317"');
    expect(r.leftovers).toEqual([]);
  });
});

describe('relinkValue', () => {
  it('maps run_id numbers, run_ids lists and URL strings in a run_state products block', () => {
    const map = buildRunIdMap(before, after);
    const products = {
      programme_report: { workflow_id: 7187, run_id: 7254, url: 'https://x/labs/workflow/7187/run/?run_id=7254&program_id=10097' },
      opp_reports: [{ workflow_id: 7196, run_id: 7258, opportunity_id: 10099 }],
      history: { run_ids: [7249, 7254] },
      worker_review: { workflow_id: 7189, run_id: 7191 },
    };
    const out = relinkValue(products, map);
    expect(out.programme_report.run_id).toBe(7317);
    expect(out.programme_report.url).toContain('run_id=7317');
    expect(out.programme_report.workflow_id).toBe(7187);
    expect(out.opp_reports[0].run_id).toBe(7321);
    expect(out.opp_reports[0].opportunity_id).toBe(10099);
    expect(out.history.run_ids).toEqual([7312, 7317]);
    expect(out.worker_review.run_id).toBe(7191);
  });
});
