import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A dispatched PHASE agent must run in its OWN git worktree too.
 *
 * ## Why this is a SECOND contract and not one more line in the first
 *
 * ace#2001 was closed by PR #2041, whose test is the sibling file this one
 * imports. That remedy is scoped to the fix-and-ship / self-heal-sweep
 * dispatch — which is where the flag is documented, and the only place that
 * checker looks. A **phase** agent is dispatched from a different template
 * that never mentioned isolation, and phase agents ship code too:
 * `CLAUDE.md § Self-heal a filed issue when you can` tells every agent to fix
 * what it files, in session.
 *
 * So the class came straight back. On `poverty-graduation/20260908-0510`,
 * `Agent(ace:solicitation-management)` was dispatched for Phase 8 with no
 * isolation. Mid-phase it correctly filed and self-healed ace#2231 -> PR
 * #2232 from the orchestrator's live worktree, and said so itself:
 *
 *   > this worktree is left on merged branch
 *   > `fix/2231-conditional-span-ceiling` at VERSION 0.13.1362
 *
 * At the Phase 8->9 boundary the orchestrator's worktree sat on a foreign
 * branch four versions ahead of its own (0.13.1362 vs 0.13.1358) while the
 * orchestrator was concurrently writing `run_state.yaml` patches and Drive
 * artifacts from it. Nothing failed — the tree happened to be clean — which
 * is the same luck ace#2001 ran on, in the same three-minute `git add -A`
 * window where either actor sweeps the other's edits into its own commit.
 *
 * ## What makes this test bite where the sibling does not
 *
 * `agents/ace-orchestrator.md` has ALWAYS contained the string
 * `isolation: "worktree"` — in the self-heal sweep. A whole-file presence
 * check was green throughout the incident above, which is exactly why the
 * sibling checker did not catch it. The assertion here is therefore
 * POSITIONAL: the flag must appear inside § Per-phase conventions, the
 * section an orchestrator reads when it is about to dispatch a phase.
 * CONTROL 2 reconstructs the pre-fix file that way — flag in the sweep,
 * absent from the phase template — and requires it to fail.
 *
 * ## The fix is isolation, NOT prohibition
 *
 * "Tell phase agents not to self-heal" contradicts the standing operator
 * directive (Jon, 2026-07-22) and would suppress exactly the cheap in-context
 * fixes that directive exists to get — ace#2231 was a good catch. Nothing
 * here may be satisfied by removing a phase agent's ability to ship.
 *
 * ace#2233. Prior instance: ace#2001 / PR #2041.
 */

const REPO = join(__dirname, '..', '..');

const FLAG = 'isolation: "worktree"';

/** Owns the incident write-up; every dispatch site cites it by name. */
const ANCHOR_OWNER = 'agents/orchestrator-reference.md';
const ANCHOR = 'Dispatch it into its OWN worktree';
const ANCHOR_HEADING = `### ${ANCHOR}`;
const ANCHOR_END = '### The dispatch prompt';

/** The section an orchestrator reads immediately before dispatching a phase. */
const ORCH = 'agents/ace-orchestrator.md';
const PHASE_SECTION_START = '### Per-phase conventions (apply at every phase boundary)';
const PHASE_SECTION_END = '**Inline the artifact BODY, or pass it BY REFERENCE';

/** `/ace:iterate`'s autofix — the third site that dispatches something that commits. */
const ITERATE = 'agents/iterate-loop.md';
const ITERATE_START = '## Autofix (on dirty';
const ITERATE_END = '**After the subagent returns MERGED:**';

const norm = (s: string) => s.replace(/\s+/g, ' ');

/** Slice `[start, end)`; null when either marker is missing or misordered. */
function slice(text: string, start: string, end: string): string | null {
  const a = text.indexOf(start);
  if (a === -1) return null;
  const b = text.indexOf(end, a);
  if (b === -1) return null;
  return text.slice(a, b);
}

export function checkPhaseDispatchIsolation(corpus: Record<string, string>): string[] {
  const v: string[] = [];

  // 1. The phase-dispatch section carries the flag VERBATIM and IN PLACE.
  //    Not "somewhere in the file" — the file already said it, in the sweep,
  //    for the whole duration of the ace#2233 incident.
  const phase = slice(corpus[ORCH] ?? '', PHASE_SECTION_START, PHASE_SECTION_END);
  if (phase === null) {
    v.push(`${ORCH}: cannot locate "${PHASE_SECTION_START}" ... "${PHASE_SECTION_END}"`);
  } else {
    const region = norm(phase);
    if (!region.includes(FLAG)) {
      v.push(`${ORCH}: the phase-dispatch conventions must name ${FLAG} verbatim`);
    }
    if (!region.includes(ANCHOR)) {
      v.push(`${ORCH}: the phase-dispatch conventions do not cite "${ANCHOR}" by name`);
    }
  }

  // 2. The anchor section is GENERALISED past fix-and-ship. A phase
  //    dispatcher that follows the citation must not land on a section that
  //    reads as a rule about self-heal dispatches only — i.e. excuses it.
  const anchor = slice(corpus[ANCHOR_OWNER] ?? '', ANCHOR_HEADING, ANCHOR_END);
  if (anchor === null) {
    v.push(`${ANCHOR_OWNER}: cannot locate "${ANCHOR_HEADING}"`);
  } else if (!norm(anchor).includes('Agent(<phase>)')) {
    v.push(
      `${ANCHOR_OWNER}: the anchor must name Agent(<phase>) as covered, not fix-and-ship alone`,
    );
  }

  // 3. `/ace:iterate`'s autofix dispatches a fix-and-ship subagent from the
  //    same checkout ("always local, against the ACE checkout") and PR #2041
  //    never reached it — the same under-scoping, one site over.
  const autofix = slice(corpus[ITERATE] ?? '', ITERATE_START, ITERATE_END);
  if (autofix === null) {
    v.push(`${ITERATE}: cannot locate "${ITERATE_START}"`);
  } else if (!norm(autofix).includes(FLAG)) {
    v.push(`${ITERATE}: the autofix dispatch must name ${FLAG} verbatim`);
  }

  return v;
}

const PHASE_FILES = [ORCH, ANCHOR_OWNER, ITERATE];
function phaseCorpus(): Record<string, string> {
  return Object.fromEntries(PHASE_FILES.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]));
}

/** Strip the flag (and optionally the citation) from the phase region ONLY. */
function stripPhaseRegion(src: string, alsoAnchor: boolean): string {
  const a = src.indexOf(PHASE_SECTION_START);
  const b = src.indexOf(PHASE_SECTION_END, a);
  let region = src.slice(a, b).split(FLAG).join('an isolated worktree');
  if (alsoAnchor) region = region.split(ANCHOR).join('that section');
  return src.slice(0, a) + region + src.slice(b);
}

describe('phase-dispatch worktree isolation (ace#2233)', () => {
  it('the three live surfaces satisfy it', () => {
    expect(checkPhaseDispatchIsolation(phaseCorpus())).toEqual([]);
  });

  /** CONTROL 1 — every surface is load-bearing, and only for itself. */
  it('control: neutering any ONE surface fails, and only that surface', () => {
    const counts: Record<string, number> = {};
    for (const f of PHASE_FILES) {
      const violations = checkPhaseDispatchIsolation({ ...phaseCorpus(), [f]: '# gutted\n' });
      counts[f] = violations.length;
      expect(violations.length, `${f} is not load-bearing`).toBeGreaterThan(0);
      expect(violations.every((x) => x.startsWith(f))).toBe(true);
    }
    expect(counts).toEqual({
      [ORCH]: 1, // the phase-dispatch section itself is gone
      [ANCHOR_OWNER]: 1, // the anchor is gone
      [ITERATE]: 1, // the autofix block is gone
    });
  });

  /**
   * CONTROL 2 — the one that reproduces the incident. Leave the flag exactly
   * where PR #2041 put it (the self-heal sweep) and strip it from the phase
   * conventions: that is `agents/ace-orchestrator.md` as it stood on
   * 2026-09-08, and a whole-file presence check reads it as green.
   */
  it('control: the flag in the SWEEP alone does not cover a phase dispatch', () => {
    const live = phaseCorpus();
    const stripped = stripPhaseRegion(live[ORCH], true);

    // The sweep's copy of the flag survives untouched — the pre-fix shape.
    expect(stripped).toContain(FLAG);
    expect(checkPhaseDispatchIsolation({ ...live, [ORCH]: stripped })).toEqual([
      `${ORCH}: the phase-dispatch conventions must name ${FLAG} verbatim`,
      `${ORCH}: the phase-dispatch conventions do not cite "${ANCHOR}" by name`,
    ]);
  });

  /**
   * CONTROL 3 — the citation has to land somewhere that covers the citer.
   * Narrow the anchor back to fix-and-ship only and the generalisation check
   * bites, with all three dispatch sites left reading perfectly.
   */
  it('control: re-narrowing the anchor to fix-and-ship alone fails', () => {
    const live = phaseCorpus();
    const src = live[ANCHOR_OWNER];
    const a = src.indexOf(ANCHOR_HEADING);
    const b = src.indexOf(ANCHOR_END, a);
    const narrowed =
      src.slice(0, a) + src.slice(a, b).split('Agent(<phase>)').join('the sweep') + src.slice(b);
    expect(checkPhaseDispatchIsolation({ ...live, [ANCHOR_OWNER]: narrowed })).toEqual([
      `${ANCHOR_OWNER}: the anchor must name Agent(<phase>) as covered, not fix-and-ship alone`,
    ]);
  });

  /**
   * CONTROL 4 — the two contracts are independent, which is the whole reason
   * this file exists. `fix-and-ship-isolation.test.ts` asserts two things
   * about this file: that it names the flag SOMEWHERE, and that it cites the
   * anchor SOMEWHERE. Both are whole-file presence checks, so both stay
   * satisfied by the sweep's copy alone — which is why the sibling was green
   * on 2026-09-08 while a phase agent shipped from a shared worktree. Assert
   * that directly here rather than importing the sibling's checker (importing
   * a test module re-executes its suite).
   */
  it('control: a whole-file presence check — the ace#2001 shape — stays green here', () => {
    const stripped = stripPhaseRegion(readFileSync(join(REPO, ORCH), 'utf8'), false);
    expect(norm(stripped)).toContain(FLAG); // the sibling's dispatch-site check
    expect(norm(stripped)).toContain(ANCHOR); // the sibling's citation check
    expect(
      checkPhaseDispatchIsolation({ ...phaseCorpus(), [ORCH]: stripped }).length,
    ).toBeGreaterThan(0);
  });
});
