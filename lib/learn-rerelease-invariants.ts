/**
 * Re-release invariants for a LEARN app whose Connect opportunity already
 * exists (dimagi-internal/ace#2705). The Learn sibling of
 * `lib/deliver-rerelease-invariants.ts` (ace#2691); same `CheckOutcome` shape,
 * same form reader.
 *
 * ## What Connect actually keys on
 *
 * Read from `dimagi/commcare-connect` @ `046c7fd7` (2026-10-05), not guessed:
 *
 * - At opportunity creation Connect creates one `LearnModule` row per Learn
 *   `<module id>` in the build (`opportunity/tasks.py:86-95`,
 *   `update_or_create(app, slug=block.id)`). Nothing ever deletes a row.
 * - A forwarded Learn submission's `<module>` block is matched by **`@id`**
 *   (`form_receiver/processor.py:107-116`, `get_or_create(app, slug=@id)`);
 *   an `@id` Connect has not seen creates a NEW `LearnModule` row lazily.
 * - Learn progress = unique completed modules / `LearnModule.objects.filter(app=learn_app).count()`
 *   (`opportunity/models.py:386-392`), and `completed_learn_date` is set only
 *   at exactly 100 % (`processor.py:192-205`).
 *
 * So for an opportunity already configured on a baseline build:
 *
 *   - a module `@id` that **disappears** leaves a row no worker on the new
 *     build can ever complete — progress caps below 100 % and Learn never
 *     completes (BLOCK);
 *   - a module `@id` that **appears** grows the denominator the first time
 *     anyone completes it — every worker who already finished Learn drops
 *     below 100 % (BLOCK). A rename is both.
 *
 * ## The assessment: presence BLOCKS, its `@id` only WARNS
 *
 * The filed remedy (ace#2705) said to BLOCK on an assessment `@id` change.
 * Connect's source says otherwise: `process_assessments`
 * (`processor.py:208-241`) reads only `user_score` and keys the `Assessment`
 * row on `(user, app, opportunity, xform_id)` — the `@id` is never read, and
 * no model stores it. What DOES break the opportunity is the assessment block
 * vanishing: with no `<assessment>` in any form no `Assessment` row can be
 * written, so `assessment_status` (`models.py:446-452`) can never be "passed".
 * Hence: assessment disappeared → BLOCK; assessment `@id` changed while one
 * is still present → WARN (non-Connect consumers may key on it).
 *
 * ## xmlns
 *
 * WARN, same reasoning as the Deliver check: Connect never reads form xmlns,
 * but HQ exports/UCR and connect-labs CCHQ-form pipelines do.
 *
 * ## Class
 *
 * Static parsing of two released CCZs. Nothing here is sent to or matched
 * against a device; unit tests on real released fixtures are complete
 * evidence.
 */
import { type CheckOutcome, checked, formatUnable, unable } from './check-outcome.js';
import {
  formXmlnsChanges,
  shapes,
  uniq,
  type ReleasedBuild,
  type XmlnsChange,
} from './deliver-rerelease-invariants.js';

export interface LearnRereleaseInput {
  /** The Learn build the opportunity was configured on (else the previous release). */
  baseline: ReleasedBuild;
  /** The Learn build being released now. */
  candidate: ReleasedBuild;
}

export type LearnRereleaseFindingKind =
  | 'learn-module-id-disappeared'
  | 'learn-module-id-added'
  | 'assessment-disappeared'
  | 'assessment-id-changed'
  | 'form-xmlns-changed';

export interface LearnRereleaseFinding {
  kind: LearnRereleaseFindingKind;
  severity: 'blocker' | 'warn';
  message: string;
}

export interface LearnRereleaseReport {
  /** True when any finding is a blocker — halt the release. */
  blocking: boolean;
  baselineModuleIds: string[];
  candidateModuleIds: string[];
  baselineAssessmentIds: string[];
  candidateAssessmentIds: string[];
  xmlnsChanges: XmlnsChange[];
}

export type LearnRereleaseOutcome = CheckOutcome<LearnRereleaseFinding, LearnRereleaseReport>;

export function checkLearnRerelease(input: LearnRereleaseInput): LearnRereleaseOutcome {
  const base = shapes(input.baseline);
  const cand = shapes(input.candidate);
  const B = input.baseline.buildId;
  const C = input.candidate.buildId;
  if (base.ok.length === 0) {
    return unable(
      `no readable form in the baseline build ${B}` +
        (base.unreadable.length ? ` (unreadable: ${base.unreadable.join(', ')})` : ''),
    );
  }
  if (cand.ok.length === 0) {
    return unable(
      `no readable form in the candidate build ${C}` +
        (cand.unreadable.length ? ` (unreadable: ${cand.unreadable.join(', ')})` : ''),
    );
  }
  if (cand.unreadable.length > 0) {
    // A form we cannot read might be exactly the one carrying a module block.
    return unable(`unreadable form(s) in the candidate build ${C}: ${cand.unreadable.join(', ')}`);
  }
  const baseMods = uniq(base.ok.flatMap((s) => s.learnModuleIds));
  const baseAsmt = uniq(base.ok.flatMap((s) => s.assessmentIds));
  if (baseMods.length === 0 && baseAsmt.length === 0) {
    return unable(
      `baseline build ${B} carries no Connect <module> or <assessment> block — ` +
        `it is not the Learn build the opportunity was configured on`,
    );
  }
  const candMods = uniq(cand.ok.flatMap((s) => s.learnModuleIds));
  const candAsmt = uniq(cand.ok.flatMap((s) => s.assessmentIds));
  const findings: LearnRereleaseFinding[] = [];

  for (const id of baseMods.filter((x) => !candMods.includes(x))) {
    findings.push({
      kind: 'learn-module-id-disappeared',
      severity: 'blocker',
      message:
        `learn module @id "${id}" (configured in ${B}) is absent from ${C}. Connect created a LearnModule row ` +
        `for it at opportunity creation (commcare-connect opportunity/tasks.py:86-95) and never deletes it, ` +
        `while learn progress divides by that row count (opportunity/models.py:386-392) — so no worker on ` +
        `the new build can reach 100% and Learn never completes. Restore the @id in the Learn app and re-release.`,
    });
  }
  for (const id of candMods.filter((x) => !baseMods.includes(x))) {
    findings.push({
      kind: 'learn-module-id-added',
      severity: 'blocker',
      message:
        `learn module @id "${id}" is new in ${C}. Connect creates its LearnModule row lazily on the first ` +
        `submission (commcare-connect form_receiver/processor.py:107-116), which grows the learn-progress ` +
        `denominator (opportunity/models.py:386-392) — every worker who already finished Learn drops below ` +
        `100%. Restore the configured module @ids (${baseMods.join(', ') || 'none'}), or re-release against a fresh opportunity.`,
    });
  }

  if (baseAsmt.length > 0 && candAsmt.length === 0) {
    findings.push({
      kind: 'assessment-disappeared',
      severity: 'blocker',
      message:
        `${C} carries no Connect <assessment> block (baseline ${B} had ${baseAsmt.join(', ')}). Connect writes ` +
        `an Assessment row only from that block (commcare-connect form_receiver/processor.py:208-241), so no ` +
        `worker on the new build can ever pass the assessment. Restore the assessment form's Connect block and re-release.`,
    });
  } else if (candAsmt.length > 0 && baseAsmt.join('\u0000') !== candAsmt.join('\u0000')) {
    findings.push({
      kind: 'assessment-id-changed',
      severity: 'warn',
      message:
        `assessment @id changed between ${B} and ${C} (${baseAsmt.join(', ') || 'none'} → ${candAsmt.join(', ')}). ` +
        `Connect is unaffected — process_assessments reads only user_score and keys the row on ` +
        `(user, app, opportunity, xform_id), never the @id (form_receiver/processor.py:208-241). Tell the owner ` +
        `of any report or pipeline that keys on the assessment id.`,
    });
  }

  const xmlnsChanges = formXmlnsChanges(base.ok, cand.ok);
  if (xmlnsChanges.length > 0) {
    findings.push({
      kind: 'form-xmlns-changed',
      severity: 'warn',
      message:
        `${xmlnsChanges.length} Learn form xmlns changed between ${B} and ${C} ` +
        `(${xmlnsChanges.map((x) => `${x.form}: …${x.from.slice(-8)} → …${x.to.slice(-8)}`).join('; ')}). ` +
        `Connect learn progress is unaffected — it never reads form xmlns. HQ exports/reports/UCR and ` +
        `connect-labs CCHQ-form pipelines keyed on xmlns split at this release; tell the owner of any such consumer.`,
    });
  }

  const blocking = findings.some((f) => f.severity === 'blocker');
  return {
    ...checked(findings.length === 0, findings),
    blocking,
    baselineModuleIds: baseMods,
    candidateModuleIds: candMods,
    baselineAssessmentIds: baseAsmt,
    candidateAssessmentIds: candAsmt,
    xmlnsChanges,
  };
}

/** Operator-facing rendering; `[BLOCKER]` / `[WARN]` lines, never green on `unable`. */
export function formatLearnRerelease(outcome: LearnRereleaseOutcome): string {
  const label = 'learn-rerelease-invariants';
  if (outcome.status === 'unable') return formatUnable(label, outcome.reason);
  if (outcome.findings.length === 0) {
    return (
      `${label}: learn module @id(s) ${outcome.candidateModuleIds.join(', ')} unchanged; ` +
      `assessment @id(s) ${outcome.candidateAssessmentIds.join(', ') || 'none'} unchanged; form xmlns unchanged.`
    );
  }
  return outcome.findings
    .map((f) => `[${f.severity === 'blocker' ? 'BLOCKER' : 'WARN'}] ${f.kind}: ${f.message}`)
    .join('\n');
}
