/**
 * dimagi-internal/ace#1787 — Nova's canonical starter module can ship to
 * production.
 *
 * `create_app` seeds every new Nova app with a placeholder module: a top-level
 * menu "Survey" holding one form "Survey" holding one text field `question_1`
 * labelled "Question 1". Nothing in ACE ever told the architect to remove it:
 *
 *     $ grep -rniE "starter module|canonical starter|placeholder module" \
 *           skills/ agents/ lib/
 *     (no output)
 *
 * On `bednet-check-2-visit/20260828-0629` the Deliver app shipped carrying it.
 * The Learn app, briefed from the same template in the same phase, did not —
 * its architect removed it unprompted. So removal depended entirely on whether
 * the architect happened to notice, which is architect discretion, which is
 * exactly what varies run to run.
 *
 * And no gate could see it. `app-release-qa` Step 4 cross-references released
 * CCZ form count against Nova blueprint form count — the starter module is in
 * BOTH, so the counts match and the check passes. The Connect-marker checks key
 * on forms that DECLARE `connect.*` blocks, and the starter form declares none,
 * so it is invisible there too. Form-count EQUALITY is structurally blind to an
 * extra module: it needs a name/identity comparison.
 *
 * Net effect: a menu reading "Survey" containing one question labelled
 * "Question 1" reaches a field worker's home screen with every Phase 3 gate
 * green. On a Deliver app it is worse than cosmetic — an FLW tapping it lands
 * in a dead form that writes nothing and is not a payable unit.
 *
 * This file pins BOTH halves. The brief line alone is the class of instruction
 * that gets skipped under load — that is how the defect happened — so the gate
 * is the part that has to be structural.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url));
const library = readFileSync(`${SKILLS}_app-component-library.md`, 'utf8');
const learn = readFileSync(`${SKILLS}pdd-to-learn-app/SKILL.md`, 'utf8');
const deliver = readFileSync(`${SKILLS}pdd-to-deliver-app/SKILL.md`, 'utf8');
const releaseQa = readFileSync(`${SKILLS}app-release-qa/SKILL.md`, 'utf8');

/** The `## Process` body only — a claim parked in Failure Modes is not a step. */
function processBody(md: string): string {
  const m = /^## Process\s*$/im.exec(md);
  if (!m) throw new Error('no ## Process section');
  const after = md.slice(m.index + m[0].length);
  const next = /^## /m.exec(after);
  return next ? after.slice(0, next.index) : after;
}

// ---------------------------------------------------------------------------
// Build side — the brief must tell the architect to remove it
// ---------------------------------------------------------------------------

describe('the build side names the starter module (#1787)', () => {
  it('the component library carries a no-starter-module component', () => {
    expect(
      library,
      'The instruction belongs in the shared library, not duplicated in two ' +
        'build skills — it applies to Learn and Deliver alike.',
    ).toMatch(/^### no-starter-module\s*$/m);
  });

  it('the component applies to BOTH apps and always fires', () => {
    const m = /^### no-starter-module\s*$/m.exec(library);
    const body = m ? library.slice(m.index, m.index + 2600) : '';
    expect(body).toMatch(/\*\*App:\*\*.*Learn \+ Deliver/i);
    expect(body).toMatch(/\*\*Trigger:\*\*\s*always/i);
  });

  it('the component carries a verbatim brief paragraph naming the seeded shape', () => {
    const m = /^### no-starter-module\s*$/m.exec(library);
    const body = m ? library.slice(m.index, m.index + 2600) : '';
    expect(body).toMatch(/\*\*Brief paragraph \(verbatim\)/);
    // The architect has to be able to recognise the thing, not just be told a
    // category name. The seeded shape is fixed and nameable.
    expect(body).toMatch(/question_1/);
    expect(body).toMatch(/Survey/);
    // Markdown blockquote wrapping puts "> " between the words.
    expect(body).toMatch(/only the modules[\s>]+the brief specifies/i);
  });

  it('appears in the component index', () => {
    const m = /^## Component index\s*$/m.exec(library);
    const after = m ? library.slice(m.index) : '';
    const table = after.slice(0, after.search(/^## /m) === -1 ? after.length : after.search(/\n## /));
    expect(table).toMatch(/no-starter-module/);
  });

  it('both build skills name it in their emit-checklist', () => {
    expect(
      processBody(learn),
      'pdd-to-learn-app must emit the component — a library entry nothing ' +
        'triggers is not an instruction.',
    ).toMatch(/no-starter-module/);
    expect(processBody(deliver)).toMatch(/no-starter-module/);
  });
});

// ---------------------------------------------------------------------------
// Gate side — the class-level preventer
// ---------------------------------------------------------------------------

describe('app-release-qa can actually SEE an extra module (#1787)', () => {
  const proc = processBody(releaseQa);

  it('has a starter-module check in the Process', () => {
    expect(proc).toMatch(/starter module/i);
  });

  it('states why form-count equality cannot catch it', () => {
    // Without this sentence the next editor "simplifies" the identity check
    // back into the count check that was already there and already blind. The
    // reason must sit WITH the check, not somewhere else in a 1000-line file.
    const m = /starter module/i.exec(proc);
    const body = m ? proc.slice(Math.max(0, m.index - 1200), m.index + 3000) : '';
    expect(body).toMatch(/form count|form-count/i);
    expect(body).toMatch(/blind to an extra module|equal on both sides|count equality cannot/i);
  });

  it('the check is identity-based, not count-based', () => {
    // The starter module is present in the CCZ *and* in the Nova blueprint, so
    // any check comparing the two totals passes on a dirty app by construction.
    const m = /starter module/i.exec(proc);
    const body = m ? proc.slice(Math.max(0, m.index - 1200), m.index + 3000) : '';
    expect(body).toMatch(/question_1/);
  });

  it('delegates the decision to the unit-tested pure helper, not to prose', () => {
    expect(proc).toContain('auditReleasedModules');
    expect(proc).toContain('lib/starter-module.ts');
  });

  it('halts on it — a WARN is not a gate', () => {
    // The whole finding is that every structural gate reported green while a
    // dead menu shipped. A non-blocking note reproduces that.
    expect(proc).toMatch(/starter-module-present/);
    const failureModes = releaseQa.slice(releaseQa.search(/^## Failure modes/m));
    expect(failureModes).toMatch(/starter-module-present/);
  });

  it('records the check in the verdict so a run can be audited after the fact', () => {
    expect(releaseQa).toMatch(/starter_module/);
  });
});
