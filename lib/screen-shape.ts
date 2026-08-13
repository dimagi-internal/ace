//
// Pure static check: does a built form put too much on ONE screen?
//
// Why this exists: a Nova `kind: group` compiles to a CommCare **field-list**,
// which renders every child — labels and questions alike — on ONE scrollable
// screen. That is good design when the questions belong together, and ACE
// deliberately does NOT require one question per screen. The failure mode is
// narrower and entirely mechanical: a group that has quietly become a wall.
//
// Nothing in ACE checked this before. `_app-component-library.md` had 23
// components; `observable-before-derived` governs question ORDER and
// `constraint-locality` governs CONSTRAINTS, but none governed screen
// composition. `pdd-to-deliver-app` Steps 4a-4f check field counts,
// one-form-per-module, case write-back, case-list columns, the deliver marker
// and option sources — none checked screen shape. And
// `pdd-to-deliver-app-eval` has ten dimensions, none of which looks at how
// many questions share a screen.
//
// So on hh-poverty-targeting/20260812-2034 the architect grouped by
// relevance-condition (a defensible choice on its own terms), which put all
// ten PPI indicators PLUS the household roster repeat on a single screen. The
// build passed every Phase 3 gate and `field_answerability` scored 9.5. It
// surfaced two steps later, while authoring the Phase 6 smoke recipe — after
// the app had already been uploaded to CommCare HQ, so fixing it cost a
// re-upload, a fresh HQ app id, and an orphan app to clean up. Had Phase 4 run
// first it would have cost a delete-and-recreate of the Connect opportunity,
// because `connect_create_opportunity` writes HQ app ids at create time and
// Connect's edit form does not expose them.
//
// Operator ruling that this module encodes (Jon, 2026-08-13): "It's actually
// fine app design practice to have multiple questions on a screen if that
// makes sense for the flow, not strictly requiring one question per screen, so
// it's fine that it is built that way and shouldn't be viewed as a problem. It
// shouldn't be a super long scroll."
//
// Hence: this is NOT a one-question-per-screen rule and must never become one.
// It flags three specific, mechanically-detectable shapes:
//
//   1. oversized-screen              — a field-list carrying more answerable
//                                      questions than a worker can hold in
//                                      view
//   2. repeat-in-field-list          — a repeat nested inside a group, which
//                                      does not render as its own repeat flow
//   3. long-passage-with-questions   — a long read-aloud passage sharing a
//                                      screen with unrelated questions, so the
//                                      passage scrolls out of view before the
//                                      answer it governs
//
// Same family as `lib/constraint-locality.ts` and
// `lib/date-default-validate.ts`: the class is fully detectable from the
// blueprint, so it is a parser, not a rubric line. The COHERENCE half of the
// rule ("these questions share a recall period / a rule / an answer source")
// is a judgement and stays in the component brief and the eval — the counts
// here are the mechanical backstop under it.
//

/** Nova field kinds that render nothing on screen. */
const NON_RENDERING_KINDS = new Set(['hidden']);

/** Nova field kinds that are containers rather than answerable questions. */
const CONTAINER_KINDS = new Set(['group', 'repeat']);

/**
 * More answerable questions than this on one screen is a WARN: justify the
 * grouping (a shared recall period, a shared rule, one answer source) or split
 * it. Chosen from the natural coherent sets a real instrument produces — the
 * four 7-day consumption items, the three working-condition asset items, a
 * five-field identification block. Sets larger than six are almost always two
 * ideas wearing one label.
 */
export const SCREEN_INPUT_WARN = 6;

/**
 * More answerable questions than this on one screen is a VIOLATION. Set below
 * the ten-indicator wall that motivated this module so the exact shape that
 * shipped is caught, and above every legitimate coherent set observed in ACE
 * builds to date.
 */
export const SCREEN_INPUT_MAX = 8;

/**
 * A label at or above this many characters is a read-aloud passage (a consent
 * script, a verbatim behaviour-change segment) rather than a caption. Sharing
 * a screen with unrelated questions pushes it out of view before the worker
 * reaches the answer it governs.
 */
export const LONG_PASSAGE_CHARS = 400;

/** One field as read from Nova `get_form`, with label text already flattened. */
export interface ScreenField {
  id: string;
  /** Nova field kind (`group`, `repeat`, `single_select`, `label`, `hidden`, …). */
  kind: string;
  /** Rendered label text, flattened from the structured `{parts: [...]}` shape. */
  label?: string;
  /** Children of a `group` / `repeat`. */
  children?: ScreenField[];
}

export type ScreenFindingKind =
  | 'oversized-screen'
  | 'repeat-in-field-list'
  | 'long-passage-with-questions';

export interface ScreenFinding {
  /** The group (screen) the finding is about. */
  groupId: string;
  groupLabel?: string;
  kind: ScreenFindingKind;
  severity: 'violation' | 'warn';
  /** Answerable questions rendered on this screen. */
  inputCount: number;
  detail: string;
}

export interface ScreenShapeReport {
  /** Groups (field-list screens) examined. */
  screensChecked: number;
  findings: ScreenFinding[];
}

export interface ScreenShapeOptions {
  warnAbove?: number;
  violationAbove?: number;
  longPassageChars?: number;
}

/** Is this field a question the user actually answers? */
function isAnswerable(f: ScreenField): boolean {
  return (
    !CONTAINER_KINDS.has(f.kind) &&
    !NON_RENDERING_KINDS.has(f.kind) &&
    f.kind !== 'label'
  );
}

/**
 * Count the answerable questions a group renders on its own screen.
 *
 * Recurses through nested groups (a group inside a field-list still renders on
 * the same screen) but STOPS at a repeat: a repeat gets its own screens, so
 * its inner questions are not part of this screen's scroll length.
 */
function countScreenInputs(children: ScreenField[]): number {
  let n = 0;
  for (const c of children) {
    if (c.kind === 'repeat') continue; // renders its own screens
    if (c.kind === 'group') {
      n += countScreenInputs(c.children ?? []);
      continue;
    }
    if (isAnswerable(c)) n++;
  }
  return n;
}

/** Direct-child repeats — the ones that will not render as their own flow. */
function directRepeats(children: ScreenField[]): ScreenField[] {
  return children.filter((c) => c.kind === 'repeat');
}

/** The longest label rendered directly on this screen. */
function longestLabelChars(children: ScreenField[]): number {
  let max = 0;
  for (const c of children) {
    if (c.kind === 'repeat') continue;
    if (c.kind === 'group') {
      max = Math.max(max, longestLabelChars(c.children ?? []));
      continue;
    }
    if (c.kind === 'label') max = Math.max(max, (c.label ?? '').length);
  }
  return max;
}

/**
 * Walk a form's field tree and flag screens that have become too long.
 *
 * Only GROUPS are screens: a field at the form root renders on its own screen,
 * so the root level is never flagged. Repeat bodies are walked too, since a
 * repeat's own children render together per row.
 */
export function checkScreenShape(
  fields: ScreenField[],
  opts: ScreenShapeOptions = {},
): ScreenShapeReport {
  const warnAbove = opts.warnAbove ?? SCREEN_INPUT_WARN;
  const violationAbove = opts.violationAbove ?? SCREEN_INPUT_MAX;
  const passageChars = opts.longPassageChars ?? LONG_PASSAGE_CHARS;

  const findings: ScreenFinding[] = [];
  let screensChecked = 0;

  const visit = (items: ScreenField[]): void => {
    for (const f of items) {
      if (f.kind === 'group') {
        const children = f.children ?? [];
        screensChecked++;
        const inputCount = countScreenInputs(children);

        if (inputCount > violationAbove) {
          findings.push({
            groupId: f.id,
            ...(f.label !== undefined ? { groupLabel: f.label } : {}),
            kind: 'oversized-screen',
            severity: 'violation',
            inputCount,
            detail:
              `${inputCount} answerable questions render on one screen ` +
              `(ceiling ${violationAbove}). Split into sets that share a rule ` +
              `— one recall period, one answer source, one instruction.`,
          });
        } else if (inputCount > warnAbove) {
          findings.push({
            groupId: f.id,
            ...(f.label !== undefined ? { groupLabel: f.label } : {}),
            kind: 'oversized-screen',
            severity: 'warn',
            inputCount,
            detail:
              `${inputCount} answerable questions render on one screen ` +
              `(comfortable limit ${warnAbove}). Keep it only if they are one ` +
              `coherent set; otherwise split.`,
          });
        }

        for (const r of directRepeats(children)) {
          findings.push({
            groupId: f.id,
            ...(f.label !== undefined ? { groupLabel: f.label } : {}),
            kind: 'repeat-in-field-list',
            severity: 'violation',
            inputCount,
            detail:
              `repeat \`${r.id}\` is nested inside this field-list, so it does ` +
              `not render as its own repeat flow. Move the repeat to the form ` +
              `root or into a group of its own.`,
          });
        }

        const passage = longestLabelChars(children);
        if (passage >= passageChars && inputCount >= 2) {
          findings.push({
            groupId: f.id,
            ...(f.label !== undefined ? { groupLabel: f.label } : {}),
            kind: 'long-passage-with-questions',
            severity: 'warn',
            inputCount,
            detail:
              `a ${passage}-character read-aloud passage shares this screen ` +
              `with ${inputCount} questions. Put the passage on the screen ` +
              `carrying the answer it governs, so it is still in view when the ` +
              `worker answers.`,
          });
        }

        visit(children);
        continue;
      }

      if (f.kind === 'repeat') {
        visit(f.children ?? []);
      }
    }
  };

  visit(fields);
  return { screensChecked, findings };
}

/** One-line-per-finding human summary for a build memo / QA gate. */
export function formatScreenShapeReport(report: ScreenShapeReport): string {
  if (report.findings.length === 0) {
    return (
      `screen-shape: PASS (${report.screensChecked} screen(s) checked; none ` +
      `exceeds the scroll ceiling, no repeat nested in a field-list)`
    );
  }
  const violations = report.findings.filter((f) => f.severity === 'violation');
  const warns = report.findings.filter((f) => f.severity === 'warn');
  const lines = report.findings.map((f) => {
    const tag = f.severity === 'violation' ? '[BLOCKER]' : '[WARN]';
    const name = f.groupLabel ? `${f.groupId} ("${f.groupLabel}")` : f.groupId;
    return `  ${tag} ${name}: ${f.detail}`;
  });
  const header =
    violations.length > 0
      ? `screen-shape: FAIL (${violations.length} violation(s)` +
        (warns.length > 0 ? `, ${warns.length} warning(s)` : '') +
        ` across ${report.screensChecked} screen(s))`
      : `screen-shape: WARN (${warns.length} warning(s) across ` +
        `${report.screensChecked} screen(s))`;
  return [header, ...lines].join('\n');
}
