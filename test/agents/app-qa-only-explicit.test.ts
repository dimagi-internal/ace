import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ace#2897 — `app-QA-only` must be an EXPLICIT opt-in, never inferred from
 * `phases.ocs-setup.status == skipped`.
 *
 * ## The bug this pins
 *
 * The mode fired automatically whenever Phase 5 was skipped, and dropped the
 * whole of Phase 6 Step 2 on the stated grounds that "the training skills
 * depend on the OCS chatbot URL, which is absent without Phase 5".
 *
 * That dependency does not exist. Every one of those skills declares its own
 * requirement and none names OCS — `training-deck-generate` wants "an approved
 * PDD and built apps", `training-llo-guide` "the PDD and built apps",
 * `training-flw-guide` / `training-quick-reference` / `training-faq` /
 * `training-onboarding-email` the PDD. The single chatbot reference in the set
 * is `training-deck-generate`'s "add OCS widget URL ... **if available**".
 *
 * Skipping the chatbot is the NORMAL shape of a 1/2/3/4/6 operator run, so the
 * inference meant such a run silently lost all seven partner-facing training
 * artifacts — and because the same `mode` field waives the boundary fences,
 * `verify_phase_artifacts` stopped asking for them and the phase terminated
 * `status: done`, `verdict: pass`. Observed on
 * turmeric-market-study-ghana/20261012-1749: the partner package was empty and
 * nothing in the verdict said so.
 *
 * The loop still needs the fast path, so the mode survives — as something the
 * seeder asks for, not something Phase 6 guesses.
 */

const root = process.cwd();
const QA = readFileSync(join(root, 'agents/qa-and-training.md'), 'utf8');
const ORCH = readFileSync(join(root, 'agents/ace-orchestrator.md'), 'utf8');
const ITER = readFileSync(join(root, 'agents/iterate-loop.md'), 'utf8');

function modeSection(md: string): string {
  const start = md.indexOf('## Mode: app-QA-only');
  expect(start, 'qa-and-training lost its app-QA-only section').toBeGreaterThan(-1);
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start, next === -1 ? undefined : next);
}

describe('app-QA-only is explicit, not inferred (ace#2897)', () => {
  it('the mode section keys off the explicit run_state field', () => {
    const s = modeSection(QA);
    expect(s).toMatch(/phases\.qa-and-training\.mode/);
    expect(s).toMatch(/explicit|opt-in/i);
  });

  it('the mode section explicitly disowns the ocs-setup inference', () => {
    const s = modeSection(QA);
    expect(s).toMatch(/NOT derived from/i);
    expect(s).toMatch(/ocs-setup\.status/);
    expect(s).toMatch(/2897/);
  });

  it('the orchestrator reads the mode rather than deriving it', () => {
    // The old text said: "when phases.ocs-setup.status == skipped ... add a
    // context line". That sentence is the bug; it must not survive.
    expect(ORCH).toMatch(/READ it, never DERIVE it/i);
    expect(ORCH).toMatch(/Do NOT infer it from `phases\.ocs-setup\.status == skipped`/);
    expect(ORCH).not.toMatch(
      /\*\*App-QA-only mode:\*\* when `phases\.ocs-setup\.status == skipped`/,
    );
  });

  it('records that the training skills need the PDD and apps, not OCS', () => {
    const s = modeSection(QA);
    expect(s).toMatch(/training-deck-generate/);
    expect(s).toMatch(/if available/);
    // The false premise must not be restated as fact anywhere in the section.
    expect(s).not.toMatch(/the training skills depend on the OCS chatbot URL/);
  });

  it('says to produce the artifact and omit the widget URL when Phase 5 is absent', () => {
    const s = modeSection(QA);
    expect(s).toMatch(/omit the widget URL/i);
    expect(s).toMatch(/never invent a URL|Never invent/i);
  });

  it('the iteration loop now seeds the mode explicitly, keeping its fast path', () => {
    expect(ITER).toMatch(/phases\.qa-and-training\.mode: app-QA-only/);
    expect(ITER).toMatch(/2897/);
  });

  it('REGRESSION CONTROL: the mode still exists and still skips Step 2 when set', () => {
    const s = modeSection(QA);
    expect(s).toMatch(/Run Step 1 only/);
    expect(s).toMatch(/Skip all of Step 2/);
    expect(s).toMatch(/training-onboarding-email/);
  });
});
