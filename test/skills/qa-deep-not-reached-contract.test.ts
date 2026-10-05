/**
 * The multi-day / NOT REACHED contract across the deep-QA chain (ace#2670).
 *
 * On a longitudinal-visits app, some deep-journey criteria need N > 1 DATED
 * records on the same case under a strictly-increasing, `<= today()` date
 * validate. spark-facilitator's Community Meeting Record `date_of_meeting`:
 *   `. <= today() and ... (#form/prev_meeting_date = '' or . > date(#form/prev_meeting_date))`
 * That allows one meeting per case per device-day, so one `/ace:qa-deep` session
 * cannot reach "the 4th meeting is labelled not paid". On
 * spark-facilitator/20261004-1706 two such criteria went unreached, and none of
 * the three documents in the chain had any word for that.
 *
 * The chain only works if all three links agree:
 *   - producer  `app-test-cases` DECLARES `reachability: multi-day`
 *   - executor  `/ace:qa-deep` Stage B RECORDS it NOT REACHED and never fakes it
 *   - judge     `app-ux-eval` LISTS it (`not_reached`), WARNs, and caps
 *               journey_completion at 2 instead of failing or passing it
 * If any link drops its half, unreached criteria go silent again. This test is
 * the drift detector, plus a schema check that `not_reached` survives
 * verdict validation (GateSchema is not passthrough, so a gate-nested list
 * would be stripped by zod).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VerdictSchema } from '../../lib/verdict-schema';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('multi-day criteria: declared → recorded NOT REACHED → listed by the judge (ace#2670)', () => {
  it('app-test-cases declares the mapping form, and the template shows it', () => {
    const skill = read('skills/app-test-cases/SKILL.md');
    expect(skill).toContain('reachability: multi-day');
    expect(skill).toMatch(/\{ name, reachability: multi-day, reason \}/);
    const tmpl = read('templates/app-test-cases-template.yaml');
    expect(tmpl).toMatch(/reachability: multi-day/);
    expect(tmpl).toMatch(/reason:/);
  });

  it('qa-deep Stage B records NOT REACHED and forbids faking the days', () => {
    const cmd = read('commands/qa-deep.md');
    const stageB = cmd.slice(cmd.indexOf('### Stage B'), cmd.indexOf('## What this does NOT do'));
    expect(stageB).toContain('reachability: multi-day');
    expect(stageB).toContain('NOT REACHED');
    expect(stageB).toMatch(/successive device-days against the SAME cases/);
    expect(stageB).toMatch(/Never mutate the device clock/);
    // The list must be handed to the judge, before the judge is dispatched.
    expect(stageB.indexOf('NOT REACHED')).toBeLessThan(stageB.indexOf('Dispatch `app-ux-eval`'));
  });

  it('app-ux-eval lists, WARNs, caps at 2, and names them in the gate summary', () => {
    const ux = read('skills/app-ux-eval/SKILL.md');
    expect(ux).toContain('not_reached');
    expect(ux).toMatch(/\{criterion, reason\}/);
    expect(ux).toMatch(/journey_completion` \*\*at most 2 \(warn\)\*\*/);
    // NOT the didn't-finish hard deduction, and never a pass.
    expect(ux).toMatch(/\*\*not\*\* the "journey didn't finish"/);
    expect(ux).toMatch(/names every NOT REACHED criterion/);
    // The flattened list is top-level, never under gate (GateSchema strips it).
    expect(ux).not.toContain('gate.not_reached');
  });

  it('llo-launch names NOT REACHED criteria at the gate, and the docs point at the lib', () => {
    const launch = read('skills/llo-launch/SKILL.md');
    expect(launch).toContain('notReachedGateLines');
    expect(launch).toMatch(/Name every NOT REACHED criterion, even on a pass/);
    expect(read('skills/app-test-cases/SKILL.md')).toContain('detectMultiDayDateConstraint');
    expect(read('skills/app-ux-eval/SKILL.md')).toContain('capJourneyCompletion');
  });

  it('a verdict carrying not_reached survives schema validation with the lists intact', () => {
    const verdict = {
      skill: 'app-ux-eval',
      target: 'spark-facilitator',
      mode: 'deep',
      ran_at: '2026-10-05T10:00:00Z',
      capture_path: '6-qa-and-training/app-screenshot-capture_manifest.yaml',
      overall_score: 8,
      verdict: 'pass',
      dimensions: {
        clarity: { score: 9, weight: 0.15 },
        flow_predictability: { score: 9, weight: 0.15 },
        error_recovery: { score: 9, weight: 0.15 },
        time_budget: { score: 7, weight: 0.1 },
        journey_completion: { score: 5, weight: 0.15 },
        capture_robustness: { score: 8, weight: 0.3 },
      },
      per_item: [
        {
          ref: 'journey-deliver-over-cap',
          score: 8,
          verdict: 'pass',
          not_reached: [
            { criterion: 'fourth_meeting_labelled_not_paid', reason: 'reachability: multi-day' },
          ],
        },
      ],
      not_reached: [
        { journey: 'journey-deliver-over-cap', criterion: 'fourth_meeting_labelled_not_paid' },
      ],
      gate: { threshold: 7, disposition: 'approve' },
    };
    const parsed = VerdictSchema.safeParse(verdict);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as Record<string, unknown> & { per_item?: Array<Record<string, unknown>> };
    expect(data.not_reached).toHaveLength(1);
    expect(data.per_item?.[0].not_reached).toHaveLength(1);
  });

  it('control: a not_reached nested under gate IS stripped (why the list is top-level)', () => {
    const parsed = VerdictSchema.safeParse({
      skill: 'app-ux-eval',
      target: 't',
      ran_at: '2026-10-05T10:00:00Z',
      capture_path: '6-qa-and-training/app-screenshot-capture_manifest.yaml',
      overall_score: 8,
      verdict: 'pass',
      dimensions: { d: { score: 8, weight: 1 } },
      gate: { threshold: 7, disposition: 'approve', not_reached: [{ criterion: 'x' }] },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect((parsed.data.gate as Record<string, unknown>).not_reached).toBeUndefined();
  });
});
