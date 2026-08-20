/**
 * How much of the durable, opp-root `open-questions.md` Phase 1 may inline —
 * and when it must not be inlined at all.
 *
 * dimagi-internal/ace#1201 gave the durable open-questions ledger its missing
 * READ half: the orchestrator inlines `<opp>/open-questions.md` at Phase 1 so
 * a run can declare, per pre-existing question, whether it **resolves /
 * carries forward / contradicts** it. That read is correct and stays.
 *
 * dimagi-internal/ace#1487 is what nobody bounded around it. Two properties
 * compounded:
 *
 *  1. **Append-only with no garbage collection.** Every run appends its
 *     reconciliation, so the ledger only grows. `bednet-check-2-visit`'s
 *     reached 26,577 chars across three runs, and `idea-to-pdd/SKILL.md`
 *     mandates a read-back statement for EVERY pre-existing question — so the
 *     cost of Phase 1 grows linearly with the ledger, forever.
 *  2. **No opp-class scoping.** `bednet-check-2-visit` is the `/ace:iterate`
 *     fixture, whose brief says in as many words that domain detail beyond
 *     what is written must not be invented. Inlining 26KB of accumulated run
 *     history contradicts the brief, and nothing arbitrated — the run's PDD
 *     came out 43,003 chars from a 15,449-char brief, the excess inherited
 *     rather than derived.
 *
 * That is the same hazard ace#1325 closed (ACE reading its own prior output as
 * Phase 1 source evidence) arriving through the sanctioned inline-handoff path
 * instead of the migration path. A fixture opp that cannot hold its baseline
 * still stops measuring "can ACE build what the brief specifies" and starts
 * measuring "can ACE re-litigate its own back-catalogue".
 *
 * So the inline is now CLASSIFIED, not unconditional. This module is the
 * classifier: pure, no I/O, so the orchestrator prose and the tests bind to
 * one rule rather than two prose copies that drift.
 *
 * The fixture signal is NOT a new `opp.yaml` field (the issue's suggestion) —
 * it already exists at the opp root as `iterate-state.yaml`, registered in
 * `lib/opp-root-files.ts`. This module imports that registry rather than
 * re-enumerating it, because enumerating ACE-owned opp-root names per
 * incident IS the defect #1282/#1325 closed.
 *
 * The companion bound is a SHAPE, not just a size: `skills/idea-to-pdd`
 * now writes the durable doc with exactly two sections, `## Open` and
 * `## Archive`, and a resolved question MOVES to `## Archive` (carrying
 * `resolved_at` / `resolved_by` / `resolution_note`) instead of being
 * annotated in place — the same convention `run_state.yaml`'s
 * `open_questions:` list already follows
 * (`agents/orchestrator-reference.md § Cruft management`). `## Archive` is
 * never read back and never inlined, so the live list stops carrying the
 * audit trail's weight.
 */

import { classifyOppRootEntry } from './opp-root-files.js';

/**
 * Above this many characters, the orchestrator passes the `file_id` plus the
 * most recent open rows rather than the whole `## Open` section, and names the
 * truncation at the Phase 1→2 pause.
 *
 * 8,000 chars is roughly a third of the ledger that triggered #1487 and comfortably
 * holds a healthy opp's live question list; a doc past it is carrying history the
 * `## Archive` move should already have absorbed, so tripping this bound is itself
 * a signal the ledger needs pruning.
 */
export const OPEN_QUESTIONS_INLINE_CAP_CHARS = 8000;

export type OpenQuestionsInlineMode =
  /** Do not pass the durable ledger at all — the brief is the whole intended input. */
  | 'skip-fixture'
  /** Pass the `## Open` section only, truncated to the most recent rows + the file_id. */
  | 'inline-open-section-only'
  /** Pass the `## Open` section in full. */
  | 'inline-full';

export interface OpenQuestionsInlineInput {
  /** Size of the durable doc as read, in characters. */
  charCount: number;
  /** Direct children of `ACE/<opp>/`, by name (files and folders alike). */
  oppRootNames: string[];
}

export interface OpenQuestionsInlineDecision {
  mode: OpenQuestionsInlineMode;
  /** One sentence the orchestrator can paste into the Phase 1→2 pause summary. */
  reason: string;
  capChars: number;
}

/** True when the opp root carries `/ace:iterate` campaign state — i.e. it is a fixture opp. */
function isIterateFixture(oppRootNames: string[]): boolean {
  return oppRootNames.some(
    (name) => classifyOppRootEntry(name)?.label === 'iterate-state.yaml',
  );
}

/**
 * Decide how much of the durable `open-questions.md` Phase 1 may inline.
 *
 * Rules, in order:
 *   (a) fixture opp (an `iterate-state.yaml` at the opp root) → `skip-fixture`,
 *       at ANY size;
 *   (b) over `OPEN_QUESTIONS_INLINE_CAP_CHARS` → `inline-open-section-only`;
 *   (c) otherwise → `inline-full`.
 */
export function classifyOpenQuestionsInline(
  input: OpenQuestionsInlineInput,
): OpenQuestionsInlineDecision {
  const { charCount, oppRootNames } = input;

  if (isIterateFixture(oppRootNames)) {
    return {
      mode: 'skip-fixture',
      reason:
        'Fixture opp (iterate-state.yaml at the opp root): the durable open-questions ledger ' +
        'is NOT inlined at Phase 1 — the brief is the whole intended input, and a regression ' +
        'baseline must not absorb accumulated run history (dimagi-internal/ace#1487).',
      capChars: OPEN_QUESTIONS_INLINE_CAP_CHARS,
    };
  }

  if (charCount > OPEN_QUESTIONS_INLINE_CAP_CHARS) {
    return {
      mode: 'inline-open-section-only',
      reason:
        `Durable open-questions ledger is ${charCount} chars, over the ` +
        `${OPEN_QUESTIONS_INLINE_CAP_CHARS}-char inline cap: pass the file_id plus the most ` +
        'recent rows of ## Open only (## Archive is never inlined), and name the truncation ' +
        'at the Phase 1→2 pause (dimagi-internal/ace#1487).',
      capChars: OPEN_QUESTIONS_INLINE_CAP_CHARS,
    };
  }

  return {
    mode: 'inline-full',
    reason:
      `Durable open-questions ledger is ${charCount} chars, within the ` +
      `${OPEN_QUESTIONS_INLINE_CAP_CHARS}-char inline cap: pass its ## Open section in full ` +
      '(## Archive is never inlined).',
    capChars: OPEN_QUESTIONS_INLINE_CAP_CHARS,
  };
}
