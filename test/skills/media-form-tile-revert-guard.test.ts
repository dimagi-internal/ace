/**
 * `app-media-coverage` must keep the form-tile revert guard (dimagi-internal/ace#2413).
 *
 * ## The failure class
 *
 * Step 4(b) of the skill promised built-in menu icons were free and
 * side-effect-free: *"Built-in menu icons — always, for every module and form.
 * These cost nothing and no upload."* For MODULE tiles that holds. For FORM
 * tiles it does not: Nova's `set_menu_media` accepts a form-tile icon slug
 * drawn from its own published enum, and every subsequent `get_form` on the
 * WHOLE app then fails with
 * `{"error_type":"invalid_input","message":"Choose one valid value at icon."}`.
 * Setting the icon back to `null` restores `get_form` immediately.
 *
 * Reproduced live on both apps of `poverty-graduation/20260915-1518`
 * (2026-09-16); filed upstream as `voidcraft-labs/commcare-nova#625`.
 *
 * The blast radius is four steps wide. `get_form` is load-bearing for
 * `app-deploy`'s XML-escape lint, `app-test-cases`' journey binding,
 * `app-release-qa`'s structural cross-reference, and both
 * `pdd-to-{learn,deliver}-app-eval` skills — so a step documented as free takes
 * out the rest of Phase 3 and surfaces as "Nova broke" in a skill that never
 * touched media.
 *
 * ## Why a test rather than prose
 *
 * The guard is a handful of sentences in a long skill. A future edit — a
 * rewrite of step 9, a tidy-up of the failure-modes table, or an over-eager
 * "upstream probably fixed this by now" — can drop it silently and re-arm the
 * class, and nothing would notice until the next Phase 3 deadlocked. This is
 * CLAUDE.md § "class-level preventers > instance-level fixes" applied to the
 * guard itself.
 *
 * SCOPE: offline and deterministic. It asserts the skill CARRIES the guard, not
 * that Nova still has the bug. When `voidcraft-labs/commcare-nova#625` closes
 * and the guard is deliberately removed, delete this file in the same PR —
 * `scripts/probe-upstream-asks.ts` is what surfaces the closed citation, which
 * is why the reference must stay in `owner/repo#n` form.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SKILL_REL = 'skills/app-media-coverage/SKILL.md';
const SKILL = readFileSync(join(REPO_ROOT, SKILL_REL), 'utf8');

/** The upstream issue, in the exact form `scripts/probe-upstream-asks.ts` matches. */
const UPSTREAM_REF = 'voidcraft-labs/commcare-nova#625';

/**
 * The guard has to live in the PROCESS, not only in the change log — a
 * changelog entry documents history, it does not instruct the next run. So
 * every assertion below runs against the body ABOVE `## Change log`.
 */
function processBody(): string {
  const idx = SKILL.indexOf('## Change log');
  expect(idx, `${SKILL_REL} lost its "## Change log" heading`).toBeGreaterThan(0);
  return SKILL.slice(0, idx);
}

describe('app-media-coverage form-tile revert guard (ace#2413)', () => {
  const body = processBody();

  it('cites the upstream issue in owner/repo#n form, in the process body', () => {
    expect(
      body.includes(UPSTREAM_REF),
      `${SKILL_REL} must cite \`${UPSTREAM_REF}\` in its process body. ` +
        'probe-upstream-asks.ts only matches `owner/repo#n`, so a bare "#625" or ' +
        'a prose reference is invisible to it and the guard can never be retired ' +
        'when upstream fixes the defect.',
    ).toBe(true);
  });

  it('sends module tiles and form tiles as SEPARATE set_menu_media batches', () => {
    const step8 = body.slice(body.indexOf('### 8.'), body.indexOf('### 9.'));
    expect(step8.length, 'step 8 not found in app-media-coverage').toBeGreaterThan(0);

    expect(
      /separate batch|two calls|never one mixed batch/i.test(step8),
      'Step 8 must apply MODULE tiles and FORM tiles as separate `set_menu_media` ' +
        'batches. Nova commits a batch whole, so one mixed batch puts the safe ' +
        'module tiles behind a form-tile write that step 9 may have to revert ' +
        `(${UPSTREAM_REF}).`,
    ).toBe(true);

    // Both tiers have to be named, or "separate batches" means nothing.
    expect(/module/i.test(step8) && /form/i.test(step8)).toBe(true);
  });

  it('reads a touched form back with get_form after the form-tile batch', () => {
    const step9 = body.slice(body.indexOf('### 9.'), body.indexOf('### 10.'));
    expect(step9.length, 'step 9 not found in app-media-coverage').toBeGreaterThan(0);

    expect(
      /get_form/.test(step9) && /form[- ]tile/i.test(step9),
      'Step 9 must prescribe a `get_form` read-back tied specifically to the ' +
        'FORM-tile batch. A generic "verify the blueprint" is what shipped before ' +
        'ace#2413 and it produced a confusing error four steps later instead of a ' +
        'recovery.',
    ).toBe(true);

    expect(
      /invalid_input/.test(step9),
      'Step 9 must name the `invalid_input` rejection it branches on, so a run ' +
        'can recognise it rather than guessing.',
    ).toBe(true);
  });

  it('prescribes the revert-to-null remedy and does NOT halt', () => {
    const step9 = body.slice(body.indexOf('### 9.'), body.indexOf('### 10.'));

    expect(
      /icon:\s*null/.test(step9),
      'Step 9 must prescribe re-sending the form-tile batch with `icon: null` — ' +
        'that is the observed recovery, and without it the read-back is a ' +
        'detector with no remedy.',
    ).toBe(true);

    expect(
      /do not halt|not halt/i.test(step9),
      'Step 9 must say to CONTINUE. Menu icons are an enhancement and nothing ' +
        'downstream gates on them; halting Phase 3 over a decorative tile is ' +
        'strictly worse than shipping without it.',
    ).toBe(true);

    expect(
      /form_tiles:\s*reverted-upstream-defect/.test(step9),
      'Step 9 must record `form_tiles: reverted-upstream-defect` so the report ' +
        'says why the form tiles are missing.',
    ).toBe(true);
  });

  it('carries form_tiles in the report frontmatter', () => {
    expect(
      /^form_tiles:/m.test(body),
      'The report frontmatter block in step 10 must carry a `form_tiles` field. ' +
        'Without it the revert is invisible to anyone reading the run artifacts.',
    ).toBe(true);
  });

  it('carries a failure-modes row for the bricked get_form', () => {
    const start = body.indexOf('## Failure modes');
    expect(start, 'app-media-coverage lost its "## Failure modes" table').toBeGreaterThan(0);
    const table = body.slice(start);

    const row = table
      .split('\n')
      .find((l) => l.startsWith('|') && /get_form/.test(l) && /icon/i.test(l));

    expect(
      row,
      'The failure-modes table must carry a row for "form-tile icon breaks ' +
        '`get_form` app-wide". The table is what a run consults when something ' +
        'goes wrong mid-phase; a remedy only in step 9 is missed by anyone who ' +
        `arrives from the error rather than from the step (${UPSTREAM_REF}).`,
    ).toBeDefined();

    expect(
      /icon:\s*null|reverted-upstream-defect/.test(row!),
      'The failure-modes row must name the remedy, not just the symptom.',
    ).toBe(true);
  });
});
