import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// ace#2244. checkGapCopy needs the why-brief's gaps[], and why_brief.yaml is
// authored by demo-narrative — one step AFTER demo-data-setup uploads its
// dashboards. Placed in demo-data-setup § 3c it could never run
// (spark-facilitator/20260907-1120 recorded it NOT RUN), so the dashboard-copy
// half of ace#1750 was dead. These pin it to where its input exists.
const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('the gap-copy check runs where the why-brief exists (ace#2244)', () => {
  const narrative = read('skills/demo-narrative/SKILL.md');
  const setup = read('skills/demo-data-setup/SKILL.md');

  it('demo-narrative runs it after authoring why_brief and before validating, over the uploaded renders', () => {
    const brief = narrative.indexOf('2. **Author `why_brief.yaml`.**');
    const step = narrative.indexOf('3d. **Gap-copy check');
    const validate = narrative.indexOf('4. **Validate — the gate.**');
    expect(brief).toBeGreaterThan(0);
    expect(step).toBeGreaterThan(brief);
    expect(validate).toBeGreaterThan(step);
    const body = narrative.slice(step, validate);
    expect(body).toMatch(/checkGapCopy/);
    expect(body).toMatch(/scripts\/check-gap-copy\.ts/);
    expect(body).toMatch(/workflow_get/);
    expect(body).toMatch(/narrativeSources/);
    expect(body).toMatch(/workflow_patch_render_code/);
  });

  it('demo-data-setup § 3c no longer asks to run it before upload', () => {
    const start = setup.indexOf('\n3c. ');
    const step = setup.slice(start, setup.indexOf('\n3c-layout. '));
    expect(step).not.toMatch(/Run `checkGapCopy/);
    expect(step).not.toMatch(/before\s+uploading anything/);
    expect(step).toMatch(/demo-narrative` § Step 3d/);
    expect(step).toMatch(/workflow_id/);
  });

  it('the Phase 7 agent says the check runs in the narrative step', () => {
    expect(read('agents/synthetic-data-and-workflows.md')).toMatch(/gap-copy check runs here, not in Step 1/);
  });

  it('scripts/check-gap-copy.ts scans render_code and the narrative together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gapcopy-'));
    writeFileSync(
      join(dir, 'why_brief.yaml'),
      [
        'spine: [{id: s1, claim: "Reviewers see every visit"}]',
        'gaps:',
        '  - id: area-register-does-not-exist',
        '    type: CAPABILITY',
        '    detail: There is no area register; area_ref is present on 0 records.',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'review.jsx'), ['  <div>', '      Worst location reading, outside the normal range for this area.', '  </div>'].join('\n'));
    const out = execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/tsx/dist/cli.mjs'),
        join(root, 'scripts/check-gap-copy.ts'),
        '--why-brief',
        join(dir, 'why_brief.yaml'),
        '--render',
        `review=${join(dir, 'review.jsx')}`,
      ],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(out.trim().split('\n').pop()!);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f: { source: string }) => f.source === 'render:review')).toBe(true);
    expect(report.scanned).toContain('why_brief:spine[s1].claim');
  });
});
