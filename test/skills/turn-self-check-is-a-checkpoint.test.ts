import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The turn's skill self-check must be verifiable, not a paragraph.
 *
 * ## The failure class
 *
 * `skills/turn/SKILL.md` carried the self-check as an "ACE addition" prose
 * bullet. Nothing verified it ran, so `canopy agent-review ace` recorded
 * `checklist_gap: skill-self-check` for the 2026-09-02 window: the step was
 * skipped and the turn still closed green. That is precisely what CLAUDE.md
 * predicts of an unenforced invariant — "prose relies on the model choosing to
 * comply, which fails under load".
 *
 * The fix is the cheapest thing that is VISIBLE WHEN ABSENT: a `TodoWrite` item
 * created at turn start and reported on a REQUIRED close-out line. Skipping it
 * now costs a missing line instead of costing nothing.
 *
 * SCOPE: the two halves that make absence detectable. A todo nobody reports on
 * is as skippable as the prose was; a report line with no todo behind it is a
 * claim rather than a check.
 */

const ROOT = join(__dirname, '..', '..');
const TURN = readFileSync(join(ROOT, 'skills', 'turn', 'SKILL.md'), 'utf8');

describe('turn self-check is a hard checkpoint', () => {
  it('creates a named todo at turn start', () => {
    expect(
      /TodoWrite/.test(TURN) && /`skill-self-check`/.test(TURN),
      'skills/turn/SKILL.md no longer creates a `skill-self-check` TodoWrite ' +
        'item at turn start. Without it the step is prose again, which is what ' +
        'produced checklist_gap: skill-self-check.',
    ).toBe(true);
  });

  it('binds it to a REQUIRED close-out line so absence is visible', () => {
    expect(
      /REQUIRED/.test(TURN),
      'The close-out no longer marks the line carrying the self-check outcome ' +
        'as required. An optional line cannot make a skipped step visible.',
    ).toBe(true);
    expect(
      /skill-self-check: none|ABSENT line is not/i.test(TURN),
      'The close-out no longer distinguishes a NEGATIVE outcome ("none") from ' +
        'an ABSENT line. Collapsing those is how a skipped check reads as a ' +
        'clean one.',
    ).toBe(true);
  });

  it('does not let the close-out be written while the check is pending', () => {
    expect(
      /may not be written while it is still `pending`|only after you have actually/i.test(TURN),
      'The ordering constraint is gone: the checkpoint has to gate the ' +
        'close-out, otherwise it is a note that happens to sit near one.',
    ).toBe(true);
  });
});

/**
 * task-tracker must not misattribute a board outage to `canopy-gws`.
 *
 * The 2026-09-02 review proposed giving `skills/task-tracker` a degraded path
 * "when canopy-gws is unavailable". Two corrections, both verified:
 *
 *   1. The board is backed by the `canopy-web` MCP
 *      (`labs.connect.dimagi.com/canopy/api/mcp/`). `canopy-gws` is canopy's
 *      Google-Workspace server and the board never touches it — so a dead
 *      canopy-gws takes nothing in this skill down with it.
 *   2. task-tracker ALREADY had a degraded path. What it lacked was the
 *      distinction between "not configured" and "down": reporting a live
 *      outage as `not configured` files a transient failure as a settled state.
 *
 * The observed canopy-gws failure is a provisioning gap, not a server bug —
 * `FATAL: GWS_IDENTITY_MODE is not set`, surfacing to Claude Code as an opaque
 * CONNECTION_CLOSED. Reproduced 2026-09-02 by running the server directly.
 */
describe('task-tracker degrades honestly', () => {
  const TT = readFileSync(join(ROOT, 'skills', 'task-tracker', 'SKILL.md'), 'utf8');

  it('separates "not configured" from "unavailable"', () => {
    expect(
      /not configured/.test(TT) && /unavailable/.test(TT),
      'task-tracker collapses outage and non-configuration into one close-out ' +
        'line again. They need different words or the outage is never chased.',
    ).toBe(true);
  });

  it('records that canopy-gws is not the board', () => {
    expect(
      /canopy-gws/.test(TT) && /canopy-web/.test(TT),
      'task-tracker no longer records which MCP actually backs the board. That ' +
        'omission is what let a canopy-gws outage be filed as a task-tracker ' +
        'defect on 2026-09-02.',
    ).toBe(true);
    expect(
      /GWS_IDENTITY_MODE/.test(TT),
      'The canopy-gws root cause (unset GWS_IDENTITY_MODE -> FATAL at startup, ' +
        'seen as CONNECTION_CLOSED) is gone. Without it the next reader sees ' +
        'only the opaque symptom and re-derives the wrong owner.',
    ).toBe(true);
  });
});
