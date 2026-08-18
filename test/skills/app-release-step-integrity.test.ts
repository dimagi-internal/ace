/**
 * app-release Process-list integrity (dimagi-internal/ace#1490).
 *
 * Commit 898918fd (2026-04-29) inserted a new Steps 5–8 into the Process list
 * and added a `## Connect-marker verification` section, but left the ORIGINAL
 * 5/6 pair from the pre-existing file stranded BELOW that section. The file
 * then carried two numbered blocks: Steps 1–8 in the list, and an orphaned
 * `5.` / `6.` after a `##` break.
 *
 * That is skip-risk rather than wrong-instruction risk, which is why it read as
 * `polish` — but the two failure modes are real: a run that stops at Step 8
 * never performs the Connect `/opportunity/init/` sanity check (it lived only
 * in the orphan), and a run that treats the trailing block as the tail of the
 * procedure skips the collision-count and oversized-slug gates that block
 * Phase 4.
 *
 * Every external citation — `app-release-eval` ("CCZ verification (Step 6 of
 * app-release)"), CHANGELOG, `connect-sync-projection.test.ts`, and this
 * skill's own Mode Behavior ("pause after step 4") — indexes the MAIN list, so
 * the main list is authoritative and the orphan's one unique step became
 * Step 9.
 *
 * NOTE ON SCOPE: this is deliberately not a repo-wide "no restarting numbers"
 * rule. Six skills legitimately restart numbering for nested sub-lists inside a
 * step, so a blanket check would be six false positives and zero signal. The
 * defect here is a SECOND top-level block in ONE procedure, which is what a
 * contiguous 1..N assertion on this file actually catches.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = path.join(REPO_ROOT, 'skills/app-release/SKILL.md');
const text = fs.readFileSync(SKILL, 'utf8');

/** Top-level `N.` / `Na.` step headings inside `## Process`. */
function processSteps(): { num: number; suffix: string }[] {
  const m = /^## Process\s*$/m.exec(text);
  if (!m) throw new Error('app-release/SKILL.md has no ## Process section');
  const after = text.slice(m.index + m[0].length);
  const next = /^## /m.exec(after);
  const body = next ? after.slice(0, next.index) : after;
  return [...body.matchAll(/^(\d+)([a-z]?)\.\s+\*\*/gm)].map((x) => ({
    num: Number(x[1]),
    suffix: x[2],
  }));
}

describe('app-release § Process is one contiguous procedure', () => {
  const steps = processSteps();

  it('numbers never restart (no second stranded step block)', () => {
    const restarts = steps
      .map((s, i) => (i > 0 && s.num < steps[i - 1].num ? `${steps[i - 1].num}→${s.num}` : null))
      .filter(Boolean);
    expect(
      restarts,
      `Step numbering restarts at ${restarts.join(', ')}. A second numbered block in ` +
        'one procedure means a run can stop at the wrong tail and skip the Phase-4 ' +
        'gates, or never reach the Connect sanity check (ace#1490).',
    ).toEqual([]);
  });

  it('major steps are contiguous 1..N', () => {
    const majors = [...new Set(steps.filter((s) => !s.suffix).map((s) => s.num))];
    expect(majors).toEqual(Array.from({ length: majors.length }, (_, i) => i + 1));
  });

  // THE defect shape. The orphaned 5./6. sat AFTER the
  // `## Connect-marker verification` heading, so a check scoped to the
  // `## Process` section could not see them at all — the numbering looked
  // clean while a whole second procedure hung off the end of the file.
  it('has no numbered step block stranded after the Process section', () => {
    const m = /^## Process\s*$/m.exec(text)!;
    const after = text.slice(m.index + m[0].length);
    const next = /^## /m.exec(after)!;
    const tail = after.slice(next.index);
    const stranded = [...tail.matchAll(/^(\d+[a-z]?)\.\s+\*\*(.{0,60})/gm)].map(
      (x) => `${x[1]}. ${x[2].trim()}`,
    );
    expect(
      stranded,
      'Numbered step blocks appear after the ## Process section. That is how ace#1490 ' +
        'happened: a superseding commit added new steps to the list and left the old ' +
        'ones below a section break, where every Process-scoped check is blind to them.',
    ).toEqual([]);
  });

  it('keeps the Connect visibility check that was stranded in the orphan block', () => {
    // The orphan's one genuinely-unique step — it exists nowhere else, so
    // deleting the whole trailing block would have silently dropped it.
    expect(text).toContain('Verify Connect can see the release.');
    expect(text).toMatch(/opportunity\/init\//);
    expect(text).toMatch(/Unreleased - /);
  });

  it('external citations still resolve: Step 6 is the CCZ projection gate', () => {
    // app-release-eval:60/:93/:103/:200, CHANGELOG and
    // connect-sync-projection.test.ts all cite "app-release Step 6".
    const step6 = /^6\.\s+\*\*(.+)$/m.exec(text)?.[1] ?? '';
    expect(step6).toMatch(/commcare_download_ccz/);
  });
});
