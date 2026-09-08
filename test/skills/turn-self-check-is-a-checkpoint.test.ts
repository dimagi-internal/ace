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
 * dimagi-internal/ace#2173 — the checkpoint must degrade, not deadlock.
 *
 * `TodoWrite` does not resolve in every session. Measured live in a
 * non-orchestrator ACE session: `ToolSearch select:TaskCreate,TaskUpdate,TodoWrite`
 * returned "No matching deferred tools found" for ALL THREE names — including the
 * TaskCreate/TaskUpdate pair that ace#2127 pointed the orchestrator at as the
 * alternate spelling.
 *
 * That turns the ordering constraint above into a deadlock: an item that can never
 * be created can never be marked `completed`, and the close-out "may not be written
 * while it is still `pending`". ace#2127 gave the orchestrator an explicit
 * skip-and-note fallback for the identical shape and left this file — the one a
 * non-orchestrator session actually loads — without one.
 *
 * SCOPE: the fallback must relieve the DEADLOCK without relieving the CHECK. Those
 * are separable because the two halves are not equally load-bearing — the REQUIRED
 * close-out line is the half that makes absence visible, and it needs no tool.
 */
describe('ace#2173 — the self-check survives an absent TodoWrite', () => {
  it('states what to do when the tool is absent, and names the issue', () => {
    // ace#2210 inverted the DEFAULT (absent is normal since Claude Code
    // 2.1.233), so the wording moved from a conditional fallback to the
    // primary path. The guarantee is unchanged: a session meeting no tool has
    // an unambiguous instruction and never deadlocks.
    expect(
      /do the check, write the close-out/i.test(TURN) && /do not halt the turn/i.test(TURN),
      'skills/turn/SKILL.md no longer tells a session what to do when TodoWrite ' +
        'is absent. Without it the mandatory ordering constraint is a deadlock: ' +
        'no todo can be created, so none can be completed, so the close-out may ' +
        'never be written.',
    ).toBe(true);
    expect(TURN).toMatch(/ace#2173/);
  });

  it('drops the TODO, not the CHECK', () => {
    // The whole risk of a fallback (now: of the tool simply being gone) is that
    // it reads as permission to skip the step. The check is the point; the todo
    // is the reminder.
    expect(
      /The todo is optional; the check\s+never is/i.test(TURN),
      'The fallback no longer distinguishes skipping the todo from skipping the ' +
        'self-check. Collapsing those hands every session a way out of the step ' +
        'that produced checklist_gap: skill-self-check in the first place.',
    ).toBe(true);
  });

  it('records the root cause, so absence is not re-investigated a fourth time', () => {
    // ace#2127, #2173 and #2210 each re-derived "the tool is gone" from
    // scratch. The cause is model-gated and opt-in-able, not permanent.
    expect(TURN).toMatch(/2\.1\.233/);
    expect(TURN).toMatch(/CLAUDE_CODE_ENABLE_TODO_TOOLS/);
    expect(TURN).toMatch(/ace#2210/);
  });

  it('does not require a per-turn "todo was skipped" disclosure', () => {
    // The noise ace#2210 removes: narrating the documented default every turn
    // reads as an anomaly report.
    expect(TURN).toMatch(/do NOT announce that a todo was skipped/i);
  });

  it('keeps the REQUIRED close-out line as the surviving enforcement', () => {
    // A tool-free half has to remain, or "TodoWrite was missing" silently excuses
    // the whole checkpoint.
    expect(
      /needs no tool|no tool at all/i.test(TURN),
      'The fallback no longer records that the close-out line works without any ' +
        'tool. That is why dropping the todo is safe; without it a reader may ' +
        'conclude the entire checkpoint is unavailable.',
    ).toBe(true);
  });

  it('forbids reporting `none` for a check that was never run', () => {
    // The degradation path must not become a route to a false clean report.
    expect(
      /false claim/i.test(TURN),
      'The fallback no longer forbids emitting `skill-self-check: none` without ' +
        'having asked the questions. That line asserts a negative FINDING, not an ' +
        'absent check — permitting it would make a skipped turn read as a clean one.',
    ).toBe(true);
  });

  it('does not tell the turn to halt or improvise a substitute', () => {
    // Both are the failure modes ace#2127 recorded for the orchestrator: an agent
    // told a step is mandatory, with no fallback, invents one mid-run.
    expect(TURN).toMatch(/not halt the turn/i);
    expect(TURN).toMatch(/improvise a substitute/i);
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
