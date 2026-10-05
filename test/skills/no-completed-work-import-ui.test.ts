import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * dimagi-internal/ace#2613: Connect has NO self-service UI for rejecting a
 * completed work. On `dimagi/commcare-connect` main @ `046c7fd7` (2026-10-05)
 * the `completed_work_export` / `completed_work_import` routes are registered
 * in `opportunity/urls.py:122-124`, but no template or JS links either one.
 * The Payments tab's "Import Payment Records" upload records payments and
 * does not reject anything. The Deliver tab's visit import is hidden on an
 * auto-verified (ACE) opportunity.
 *
 * `training-llo-guide` used to tell the LLO to "export the completed-work
 * status sheet ... set that row's status to rejected ... and re-import it",
 * and its eval then marked the guide down for having no frame of a screen
 * that does not exist (observed on `spark-facilitator/20261004-1706`, raising
 * the LLO guide of a run cloned from `spark-facilitator/20261001-2208`). This ratchet fails if any training producer, rubric
 * or template re-asserts that path. A sentence may still NAME the path, as
 * long as the same sentence negates it ("Do NOT tell the LLO to ...").
 *
 * If Connect ever links the import from a page, the LLO gains a real path:
 * relax this test and update
 * `playbook/integrations/connect-api.md § A paid visit found false`.
 */

const ROOT = join(__dirname, '..', '..');

/** Phrases that describe the self-service completed-work rejection path. */
const SELF_SERVICE_PATH: RegExp[] = [
  /\bexport (?:the |a )?completed[- ]work\b/i,
  /\bre-?import(?:s|ing|ed)? (?:it|the (?:sheet|file|status))\b/i,
  /\bPayment Verification import\b/i,
  /\bset (?:that|the|a) row(?:'s)?(?: status)? to `?rejected/i,
];

/** A sentence that names the path while negating it is the fix, not the defect. */
const NEGATION = /\b(?:not|never|no|cannot|can't|doesn't|isn't|without)\b/i;

function corpus(): { path: string; text: string }[] {
  const files: string[] = [];
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    if (!dir.startsWith('training-')) continue;
    const p = join('skills', dir, 'SKILL.md');
    if (existsSync(join(ROOT, p))) files.push(p);
  }
  files.push('skills/_training-template.md');
  for (const f of readdirSync(join(ROOT, 'templates'))) {
    if (f.endsWith('.md')) files.push(join('templates', f));
  }
  return files.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf-8') }));
}

function affirmativeSelfServiceClaims(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z*_("`|-])/);
  return sentences.filter(
    (s) => SELF_SERVICE_PATH.some((re) => re.test(s)) && !NEGATION.test(s),
  );
}

describe('no self-service completed-work rejection path (ace#2613)', () => {
  it('positive control: the pre-fix training-llo-guide step 2 is flagged', () => {
    const old =
      '2. **Stop the accrual on the completed work.** Use the Payment Verification ' +
      'import: export the completed-work status sheet from the opportunity, set ' +
      "that row's status to `rejected` with a reason, and re-import it. The " +
      'holding org can do this (`opp_standard_access`), and automatic ' +
      'verification does not gate it.';
    expect(affirmativeSelfServiceClaims(old)).toHaveLength(1);
  });

  it('negative control: a sentence that forbids the path is not flagged', () => {
    const fixed =
      'Do NOT tell the LLO to "export the completed-work status sheet", ' +
      '"set the row to rejected and re-import it", or use a "Payment ' +
      'Verification import". There is no such screen.';
    expect(affirmativeSelfServiceClaims(fixed)).toEqual([]);
  });

  it('no training skill, rubric or template describes the path as usable', () => {
    const hits = corpus().flatMap(({ path, text }) =>
      affirmativeSelfServiceClaims(text).map((s) => `${path}: ${s.slice(0, 200)}`),
    );
    expect(hits).toEqual([]);
  });

  it('training-llo-guide routes the rejection through the escalation contact', () => {
    const skill = readFileSync(join(ROOT, 'skills/training-llo-guide/SKILL.md'), 'utf-8');
    const sec = (skill.split('## A paid record found false')[1]?.split(/^## /m)[0] ?? '').replace(/\s+/g, ' ');
    expect(sec).toContain('Connect has NO screen the LLO can use to reject a completed work');
    expect(sec).toContain("program's escalation contact");
    expect(sec).toMatch(/\*\*hold\*\* that record's payment/);
    expect(sec).toContain('Import Payment Records');
  });

  it('the eval does not expect a frame for the rejection step', () => {
    const evalSkill = readFileSync(join(ROOT, 'skills/training-llo-guide-eval/SKILL.md'), 'utf-8');
    expect(evalSkill).toContain('Do not expect a frame for rejecting a paid record.');
  });

  it('the playbook records the source evidence', () => {
    const playbook = readFileSync(join(ROOT, 'playbook/integrations/connect-api.md'), 'utf-8').replace(/\s+/g, ' ');
    expect(playbook).toContain('NO UI');
    expect(playbook).toContain('046c7fd7');
    expect(playbook).toContain('Import Payment Records');
  });
});
