import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The dispatch prompt must cite the ship checkpoint's REAL step number.
 *
 * ## The failure class (ace#2042)
 *
 * `agents/orchestrator-reference.md § Fix-and-ship subagent template` handed
 * every subagent a prompt saying "Return its Step 5 ship checkpoint verbatim."
 * `skills/shipping` has no Step 5 — the canopy core it stubs over ends at
 * `## Step 3 — the ship checkpoint (unconditional)`, and the ACE stub says so
 * at SKILL.md:23. The citation kept the numbering from the days when ACE
 * inlined its own loop, before the 2026-08-17 conversion to a stub (canopy
 * #498).
 *
 * It matters because the dispatch prompt is deliberately terse — "Don't
 * re-list the steps" — so the step number is the ONLY pointer the subagent
 * gets to what it must return. Naming a step that does not exist leaves it to
 * guess, which is exactly what the required-return list exists to prevent, and
 * the `Remedy:` field (ace#1900) is graded off that same checkpoint.
 *
 * ## Why the two files, not the canopy core
 *
 * The authoritative source is `canopy/agent-core/shipping.md`, which is not in
 * this repo and is not installed in CI, so a test cannot read it. What CAN be
 * pinned is that ACE's two references AGREE: the skill's number is correct
 * today and is maintained next to the delegation itself, so a drift in either
 * direction fails here rather than reaching a subagent's prompt.
 */

const REPO = join(__dirname, '..', '..');
const REF = 'agents/orchestrator-reference.md';
const SKILL = 'skills/shipping/SKILL.md';

const read = (f: string) => readFileSync(join(REPO, f), 'utf8');
/** Collapse first: the citations wrap, so a raw .split() renames only some. */
const flat = (f: string) => read(f).replace(/\s+/g, ' ');

/**
 * "Step 3's ship checkpoint" / "its Step 3 ship checkpoint" -> "3".
 * Whitespace is collapsed first: one of the two citations in the dispatch
 * template wraps between "ship" and "checkpoint", and a raw match silently
 * saw only one of them.
 */
export function citedStep(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ');
  return [...flat.matchAll(/Step (\d+[a-z]?)(?:'s)? ship checkpoint/g)].map((m) => m[1]);
}

describe('ship-checkpoint step number agreement (ace#2042)', () => {
  it('both surfaces cite the checkpoint, and cite the SAME step', () => {
    const inRef = citedStep(read(REF));
    const inSkill = citedStep(read(SKILL));
    expect(inRef.length, `${REF} cites no ship checkpoint step`).toBeGreaterThan(0);
    expect(inSkill.length, `${SKILL} cites no ship checkpoint step`).toBeGreaterThan(0);
    expect(new Set([...inRef, ...inSkill]).size, `disagreement: ${REF}=${inRef} vs ${SKILL}=${inSkill}`).toBe(1);
  });

  /**
   * CONTROL — the exact regression. Restore the shipped-wrong value in the
   * dispatch prompt only; the skill is untouched and still reads correctly,
   * which is the state that survived on main.
   */
  it('control: the pre-fix text (Step 5 in the prompt, Step 3 in the skill) is a disagreement', () => {
    const inRef = citedStep(flat(REF).split('Step 3 ship checkpoint').join('Step 5 ship checkpoint'));
    const inSkill = citedStep(read(SKILL));
    expect(inRef).toEqual(['5', '5']);
    expect(inSkill).toEqual(['3']);
    expect(new Set([...inRef, ...inSkill]).size).toBe(2);
  });

  /**
   * CONTROL — the inverse. Drift in the OTHER direction must fail too, so the
   * test is an agreement check rather than a hardcode of "3" that would have
   * to be edited every time canopy renumbers.
   */
  it('control: renumbering the SKILL alone is also a disagreement', () => {
    const inRef = citedStep(read(REF));
    const inSkill = citedStep(flat(SKILL).split("Step 3's ship checkpoint").join("Step 9's ship checkpoint"));
    expect(inSkill).toEqual(['9']);
    expect(new Set([...inRef, ...inSkill]).size).toBe(2);
  });

  /**
   * CONTROL — renumbering BOTH together passes. Without this the test would
   * be indistinguishable from a hardcode, and a legitimate canopy renumber
   * would read as a defect.
   */
  it('control: renumbering both together passes', () => {
    const inRef = citedStep(flat(REF).split('Step 3 ship checkpoint').join('Step 4 ship checkpoint'));
    const inSkill = citedStep(flat(SKILL).split("Step 3's ship checkpoint").join("Step 4's ship checkpoint"));
    expect(new Set([...inRef, ...inSkill]).size).toBe(1);
  });
});
