/**
 * dimagi-internal/ace#1643 — `app-release` went straight to
 * `commcare_make_build`, which versions the CCHQ DRAFT and does not pull from
 * Nova. Any Nova edit made after `app-deploy` was silently absent from the
 * released CCZ, and the release reported success. Live on
 * hh-poverty-targeting/20260824-1404: the first Deliver release (v5) shipped
 * without three fixes; the HQ draft had 48 fields where Nova had 50, zero hits
 * for the new consent sentence, and `area_ref` with no constraint.
 *
 * The fix is an ordered TRIPLE, and the middle item is the one a naive fix
 * omits: **re-upload → re-apply `app-hq-settings` → build.** A re-upload wipes
 * `appearance="acquire"` and the per-module `display_style`, and
 * `app-release-qa` Step 2.8 BLOCKER-gates both — so "just re-upload before
 * release" converts a silent stale-content bug into a hard phase halt.
 *
 * This file pins all three, and pins the ORDER, so a future edit cannot drop
 * the middle one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url));
const release = readFileSync(`${SKILLS}app-release/SKILL.md`, 'utf8');
const hqSettings = readFileSync(`${SKILLS}app-hq-settings/SKILL.md`, 'utf8');

/** The `## Process` body only — a claim parked in Failure Modes is not a step. */
function processBody(md: string): string {
  const m = /^## Process\s*$/m.exec(md);
  if (!m) throw new Error('no ## Process section');
  const after = md.slice(m.index + m[0].length);
  const next = /^## /m.exec(after);
  return next ? after.slice(0, next.index) : after;
}

const proc = processBody(release);

describe('app-release checks for Nova↔HQ-draft drift BEFORE it builds', () => {
  it('has a drift-check step in the Process', () => {
    expect(proc).toMatch(/drift/i);
  });

  it('states that make_build versions the DRAFT and does not pull from Nova', () => {
    // The root cause, in the procedure the operator actually reads.
    expect(proc).toMatch(/versions the \*\*CCHQ draft\*\*|versions the \*\*CCHQ draft/);
    expect(proc).toMatch(/does not pull\s+from Nova|not pull from Nova/);
  });

  it('the drift check precedes commcare_make_build', () => {
    const drift = proc.search(/drift/i);
    const build = proc.indexOf('commcare_make_build');
    expect(drift).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(
      drift,
      'A drift check that runs after the build is not a check — the stale CCZ is ' +
        'already cut (ace#1643).',
    ).toBeLessThan(build);
  });

  it('delegates the decision to the unit-tested pure helper, not to prose', () => {
    expect(proc).toContain('classifyAppDrift');
    expect(proc).toContain('lib/app-release-drift.ts');
  });

  it('says marker integrity is not a proxy for content integrity', () => {
    // app-release-eval's sharpest finding: Step 6 verifies Connect MARKERS and
    // the markers were correct on the stale build too.
    expect(proc).toMatch(/marker integrity is not a proxy for content\s+integrity/i);
  });
});

describe('the drift branch carries all THREE actions, in order', () => {
  const step = (() => {
    const m = /^3a\.\s+\*\*/m.exec(proc);
    if (!m) throw new Error('app-release has no Step 3a');
    const after = proc.slice(m.index);
    const next = /^4\.\s+\*\*/m.exec(after);
    return next ? after.slice(0, next.index) : after;
  })();

  it('names the re-upload', () => {
    expect(step).toMatch(/upload_to_hq|upload_app_to_hq/);
  });

  it('names the re-apply of app-hq-settings — the item a naive fix omits', () => {
    expect(
      /re-?apply[^.]*app-hq-settings/i.test(step),
      'Step 3a must re-apply app-hq-settings after the re-upload. Without it the ' +
        're-upload wipes appearance="acquire" and the per-module display_style, and ' +
        'app-release-qa Step 2.8 BLOCKER-gates both — turning ace#1643 into a hard ' +
        'Phase 3 halt.',
    ).toBe(true);
  });

  /** The numbered sub-list under the "on drift" branch — the triple itself. */
  const triple = (() => {
    const m = /^\s*3\.\s+\*\*On `action: 'reupload-reapply-settings-then-build'`/m.exec(step);
    if (!m) throw new Error('Step 3a has no "on drift" branch');
    const after = step.slice(m.index);
    const next = /^\s*4\.\s+\*\*On `action: 'build-directly'`/m.exec(after);
    return next ? after.slice(0, next.index) : after;
  })();

  it('orders the triple upload → re-apply → build, and nothing between', () => {
    const up = triple.search(/upload_to_hq|upload_app_to_hq/);
    const reapply = triple.search(/Re-?apply `app-hq-settings`/i);
    const build = triple.search(/proceed to Step 4/);
    expect(up, 'the re-upload is missing from the drift branch').toBeGreaterThan(-1);
    expect(
      reapply,
      'the app-hq-settings re-apply must sit BETWEEN the re-upload and the build — ' +
        'that is the item ace#1643 says a naive fix omits',
    ).toBeGreaterThan(up);
    expect(build, 'the build must come last').toBeGreaterThan(reapply);
  });

  it('records which settings a re-upload actually reverts, and which survive', () => {
    expect(step).toMatch(/appearance="acquire"/);
    expect(step).toMatch(/display_style/);
    expect(step).toMatch(/use_grid_menus/);
    expect(step).toMatch(/grid_form_menus/);
  });

  it('has a no-drift branch that builds directly and says it did', () => {
    expect(step).toMatch(/build-directly/);
    expect(step).toMatch(/summary/i);
  });

  it('records the decision in an auditable artifact key', () => {
    expect(step).toMatch(/app-release_summary\.md/);
    expect(release).toMatch(/^\s*drift_check:/m);
  });
});

describe('app-hq-settings knows a re-upload reverts what it applied', () => {
  // The seam: app-release owns the ordering, but whoever re-uploads anywhere
  // else owes the same re-apply. Both ends must carry it or the contract has
  // a hole (same class as the ace#1009 backstop seam).
  it('states that a Nova re-upload wipes acquire and the module display_style', () => {
    expect(hqSettings).toMatch(/re-?upload/i);
    expect(hqSettings).toMatch(/appearance="acquire"[^]{0,400}wipe|wipe[^]{0,400}appearance="acquire"/);
  });

  it('points at the step that owns the ordering', () => {
    expect(hqSettings).toMatch(/app-release[^\n]*Step 3a/);
  });
});

describe('both skills tell the operator the 40-hex uid path is open (ace#1644)', () => {
  it('app-release names the post-re-upload uid width', () => {
    expect(release).toMatch(/40-hex/);
    expect(release).toMatch(/lib\/hq-unique-id\.ts/);
  });

  it('app-hq-settings names it too — it is the skill that consumes the uid', () => {
    expect(hqSettings).toMatch(/40-hex/);
    expect(hqSettings).toMatch(/hq-unique-id/);
  });
});
