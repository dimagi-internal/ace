//
// Pure XForm analysis: find `constraint` expressions that a user CANNOT
// satisfy on the screen where they fire.
//
// A constraint is LOCAL when every node it references is editable from the
// question the constraint is bound to — i.e. `.` (the question itself), a
// same-repeat sibling, or a node with no `<bind>` of its own (a hidden
// calculate derived from this question). A constraint is NON-LOCAL when it
// references some OTHER user-facing question: the form then blocks the user
// on a screen where the fix lives somewhere else, forcing them to navigate
// backward to a question that gave no indication of a problem.
//
// Why this exists: dimagi-internal/ace#980. Sophie Feintuch (domain expert)
// found two instances in one hh-poverty-targeting Deliver form:
//
//   gps_onsite_confirm  constraint="number(selected-at(/data/gps, 3)) <= 50"
//                       validate_msg="...recapture the location before continuing."
//   i1_zone             constraint="count(/data/roster) >= 1"
//                       validate_msg="Add at least one household member..."
//
// In the first, the FLW captures GPS (no complaint), answers "yes I was at
// the dwelling", then is blocked over the accuracy of the PREVIOUS screen's
// reading — and told to "recapture the location" on a screen with no
// location widget. In the second, the FLW is blocked on a zone question
// because of a roster several screens earlier.
//
// The class is 100% mechanically detectable, which is why it is a check and
// not a rubric criterion: `pdd-to-deliver-app-eval` graded that build 8.5/10
// and the LLM judge never walked the form as a user would.
//

import { DOMParser } from '@xmldom/xmldom';

/**
 * `blocker` — nothing the user can type on the firing screen satisfies the
 * rule, so they are stuck (the ace#980 class: "recapture the location" on a
 * screen with no location widget).
 *
 * `warn`  — the reference crosses a screen boundary, but the constraint also
 * references the node it is bound to, so changing the answer in front of the
 * user clears it. Annoying, not a dead end (ace#1019).
 */
export type ConstraintSeverity = 'blocker' | 'warn';

export interface ConstraintViolation {
  /** The question the constraint is bound to (its nodeset). */
  nodeset: string;
  /** Short field id — the last path segment of `nodeset`. */
  fieldId: string;
  /** The raw constraint expression. */
  constraint: string;
  /** The foreign nodes the constraint reaches out to. */
  foreignRefs: string[];
  /** The constraint's message, when the form carries one. */
  message?: string;
  /** How badly this traps the user. See `ConstraintSeverity`. */
  severity: ConstraintSeverity;
}

export interface ConstraintLocalityReport {
  /** Total binds carrying a `constraint` attribute. */
  constraintsChecked: number;
  violations: ConstraintViolation[];
}

/** Absolute path refs: `/data/foo`, `/data/roster/member_name`. */
const PATH_REF = /\/[A-Za-z_][\w.-]*(?:\/[A-Za-z_][\w.-]*)*/g;

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** `jr:itext('i1_zone-constraintMsg')` -> the itext id. */
const ITEXT_REF = /^\s*jr:itext\(\s*'([^']+)'\s*\)\s*$/;

/**
 * Build id -> localized string from the form's `<itext>`, preferring the
 * default translation. Real CommCare forms put constraint messages in itext,
 * so an unresolved `jr:itext(...)` in a QA report hides the very text that
 * makes the defect obvious ("recapture the location" on a screen with no
 * location widget).
 */
function buildItextMap(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  const translations = Array.from(doc.getElementsByTagName('translation'));
  // Default translation last so it wins on overwrite.
  const ordered = [
    ...translations.filter((t) => t.getAttribute('default') === null),
    ...translations.filter((t) => t.getAttribute('default') !== null),
  ];
  for (const tr of ordered) {
    for (const text of Array.from(tr.getElementsByTagName('text'))) {
      const id = text.getAttribute('id');
      if (!id) continue;
      const values = Array.from(text.getElementsByTagName('value'));
      // Skip form-specific variants (image/audio); take the plain value.
      const plain = values.find((v) => !v.getAttribute('form')) ?? values[0];
      const content = plain?.textContent?.trim();
      if (content) map.set(id, content);
    }
  }
  return map;
}

/** Drop the final segment: `/data/roster/member_name` -> `/data/roster`. */
function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 1 ? '' : '/' + parts.slice(0, -1).join('/');
}

/** Body elements that put a question in front of the user. */
const QUESTION_TAGS = new Set([
  'input',
  'select',
  'select1',
  'upload',
  'trigger',
  'range',
  'secret',
  'odkx:intent',
]);

/**
 * Map every body question to the id of the SCREEN it renders on.
 *
 * CommCare renders one question per screen — **except** inside a group
 * carrying `appearance="field-list"`, which renders all of its questions on
 * one scrollable screen. That is the standard idiom for "these belong
 * together", and it is what `skills/_app-component-library.md
 * § data-quality-constraints` implicitly assumes when it *mandates*
 * cross-field rules like `under_5 <= household_size`.
 *
 * Modelling screens from bind adjacency alone (which this checker used to do)
 * makes every such mandated constraint look non-local, so a correctly-authored
 * app could not clear `app-release-qa` Step 2.8 — dimagi-internal/ace#1019.
 *
 * Only questions inside a field-list group get an entry; everything else is
 * its own screen and is left unmapped.
 *
 * A nested `<repeat>` is NOT merged into its parent's screen: a repeat drives
 * its own screens regardless of the enclosing group's appearance. Nested
 * plain `<group>`s ARE merged — inside a field-list they render as labelled
 * sections of the same screen.
 */
function buildScreenMap(doc: Document): Map<string, string> {
  const screens = new Map<string, string>();
  const body =
    doc.getElementsByTagName('h:body')[0] ?? doc.getElementsByTagName('body')[0];
  if (!body) return screens;

  let screenSeq = 0;

  const collect = (el: Element, screenId: string): void => {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 1) continue;
      const e = child as Element;
      const tag = (e.tagName || '').toLowerCase();
      // A repeat renders its own screens even inside a field-list parent.
      if (tag === 'repeat') continue;
      if (QUESTION_TAGS.has(tag)) {
        const ref = e.getAttribute('ref') ?? e.getAttribute('nodeset');
        if (ref) screens.set(ref, screenId);
        continue;
      }
      // group / label / anything else: keep descending on the same screen.
      collect(e, screenId);
    }
  };

  const walk = (el: Element): void => {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 1) continue;
      const e = child as Element;
      const tag = (e.tagName || '').toLowerCase();
      if (tag === 'group' && isFieldList(e)) {
        collect(e, `screen-${screenSeq++}`);
        // Descend anyway so repeats nested inside keep their own screens.
        for (const r of Array.from(e.getElementsByTagName('repeat'))) walk(r);
        continue;
      }
      walk(e);
    }
  };

  walk(body as unknown as Element);
  return screens;
}

function isFieldList(el: Element): boolean {
  const appearance = el.getAttribute('appearance') ?? '';
  return appearance.split(/\s+/).includes('field-list');
}

/**
 * True when the constraint expression references the node it is bound to —
 * as `.`, as its absolute path, or as one of its descendants.
 *
 * This is what separates "annoying" from "trapped". `male_leader_attendence`
 * with `. <= /data/attendance/male_attendance` fires on the number the FLW
 * just typed and is cleared by lowering it. `gps_onsite_confirm` with
 * `number(selected-at(/data/gps, 3)) <= 50` never mentions its own node, so
 * no answer to that question can ever clear it — the user is stuck.
 *
 * Structural on purpose: the alternative is scanning `validate_msg` for
 * phrases like "Lower this number", which is English-only and would silently
 * mis-grade every localized form. (The real spark-facilitator messages are
 * trilingual.)
 */
function referencesOwnNode(constraint: string, nodeset: string): boolean {
  // A bare `.` step: not part of a decimal (`0.5`), not part of `..`.
  if (/(?<![\w.])\.(?![\w.])/.test(constraint)) return true;
  if (constraint.includes(nodeset)) return true;
  return false;
}

/**
 * Analyze every `<bind>` in a CommCare XForm and report constraints that
 * reference a node the user cannot edit from that question's screen.
 *
 * A reference is **user-facing** when it names something the user answers on
 * a screen: a `<bind>` WITHOUT a `calculate` (a real question), or a repeat
 * group. A `calculate` is NOT user-facing — but it is transparent: the check
 * resolves it to the refs inside its own expression, so wrapping a foreign
 * question in a hidden calculate cannot evade the rule.
 *
 * Local (NOT reported):
 *  - `.` / `selected-at(., 3)` — the question itself.
 *  - the question's own descendants (a repeat constraining its children).
 *  - a same-repeat sibling, or the enclosing repeat itself (the user is
 *    inside that repeat and can add/edit rows from there).
 *  - a calculate over constants, or over questions that are themselves local.
 *
 * Non-local (reported): any reference — direct or via a calculate — to a
 * question or repeat outside the constraint's own editable scope.
 */
export function checkConstraintLocality(xml: string): ConstraintLocalityReport {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const binds = Array.from(doc.getElementsByTagName('bind'));
  const itext = buildItextMap(doc as unknown as Document);
  // Which questions share a rendered screen (`appearance="field-list"`).
  const screens = buildScreenMap(doc as unknown as Document);

  /** nodeset -> calculate expression, for transparent resolution. */
  const calculates = new Map<string, string>();
  /** Nodesets the user actually answers on a screen. */
  const questionNodesets = new Set<string>();
  /** Nodesets that are repeat groups, so we can scope "same-repeat". */
  const repeatNodesets = new Set<string>();

  for (const b of binds) {
    const ns = b.getAttribute('nodeset');
    if (!ns) continue;
    const calc = b.getAttribute('calculate');
    if (calc) calculates.set(ns, calc);
    else questionNodesets.add(ns);
  }
  for (const r of Array.from(doc.getElementsByTagName('repeat'))) {
    const ns = r.getAttribute('nodeset');
    if (ns) repeatNodesets.add(ns);
  }

  /** The innermost repeat containing `path`, or '' when not in a repeat. */
  const enclosingRepeat = (path: string): string => {
    let best = '';
    for (const r of repeatNodesets) {
      if (path.startsWith(r + '/') && r.length > best.length) best = r;
    }
    return best;
  };

  // Document order of binds, to reason about screen adjacency.
  const bindOrder = new Map<string, number>();
  binds.forEach((b, i) => {
    const ns = b.getAttribute('nodeset');
    if (ns && !bindOrder.has(ns)) bindOrder.set(ns, i);
  });

  /** Last bind index belonging to `repeat` or any of its descendants. */
  const repeatEndIndex = (repeat: string): number => {
    let last = bindOrder.get(repeat) ?? -1;
    for (const [ns, i] of bindOrder) {
      if (ns.startsWith(repeat + '/') && i > last) last = i;
    }
    return last;
  };

  /**
   * A "min-rows" gate placed IMMEDIATELY after a repeat is the sanctioned
   * remediation for a repeat-cardinality rule: the message fires one screen
   * on, and a single Back tap reaches the roster the user just filled. That
   * is materially different from being blocked six screens later on an
   * unrelated question (the ace#980 `i1_zone` defect), so adjacency — not
   * mere reference — is the line.
   */
  const isAdjacentRepeatGate = (nodeset: string, repeat: string): boolean => {
    const idx = bindOrder.get(nodeset);
    if (idx === undefined) return false;
    return idx === repeatEndIndex(repeat) + 1;
  };

  /**
   * Expand an expression's path refs, replacing each calculate with the refs
   * of its own expression (depth-limited, cycle-safe).
   */
  const resolveRefs = (expr: string): Set<string> => {
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (e: string, depth: number): void => {
      if (depth > 8) return;
      for (const ref of e.match(PATH_REF) ?? []) {
        const calc = calculates.get(ref);
        if (calc !== undefined) {
          if (seen.has(ref)) continue;
          seen.add(ref);
          walk(calc, depth + 1);
        } else {
          out.add(ref);
        }
      }
    };
    walk(expr, 0);
    return out;
  };

  const violations: ConstraintViolation[] = [];
  let constraintsChecked = 0;

  for (const b of binds) {
    const nodeset = b.getAttribute('nodeset');
    const constraint = b.getAttribute('constraint');
    if (!nodeset || !constraint) continue;
    constraintsChecked++;

    const ownRepeat = enclosingRepeat(nodeset);
    const ownScreen = screens.get(nodeset);
    const foreign = new Set<string>();

    for (const ref of resolveRefs(constraint)) {
      if (ref === nodeset) continue; // itself, spelled absolutely
      if (ref.startsWith(nodeset + '/')) continue; // own descendant
      if (ownRepeat && ref === ownRepeat) continue; // our own repeat
      if (ownRepeat && ref.startsWith(ownRepeat + '/')) continue; // sibling
      // Same rendered screen — a `field-list` group. The user scrolls up and
      // fixes it in place, so this is local (ace#1019).
      if (ownScreen !== undefined && screens.get(ref) === ownScreen) continue;
      // A cardinality gate sitting directly after the repeat it guards.
      if (repeatNodesets.has(ref) && isAdjacentRepeatGate(nodeset, ref)) continue;
      // A repeat group the user is NOT inside is a different screen; so is
      // any other real question. Anything else (an unbound path, a constant
      // path) is not something the user edits — ignore it.
      const isUserFacing =
        repeatNodesets.has(ref) ||
        questionNodesets.has(ref) ||
        repeatNodesets.has(parentPath(ref));
      if (isUserFacing) foreign.add(ref);
    }

    if (foreign.size > 0) {
      const raw =
        b.getAttribute('jr:constraintMsg') ??
        b.getAttribute('constraintMsg') ??
        undefined;
      // Resolve `jr:itext('...')` so the report quotes the real instruction.
      let msg = raw ?? undefined;
      const itextId = raw?.match(ITEXT_REF)?.[1];
      if (itextId) msg = itext.get(itextId) ?? raw ?? undefined;
      violations.push({
        nodeset,
        fieldId: lastSegment(nodeset),
        constraint,
        foreignRefs: Array.from(foreign),
        message: msg,
        severity: referencesOwnNode(constraint, nodeset) ? 'warn' : 'blocker',
      });
    }
  }

  return { constraintsChecked, violations };
}

/** One-line-per-violation human summary for a QA verdict. */
export function formatConstraintLocalityReport(
  report: ConstraintLocalityReport,
): string {
  if (report.violations.length === 0) {
    return `constraint-locality: PASS (${report.constraintsChecked} constraint(s) checked, all local)`;
  }
  const blockers = report.violations.filter((v) => v.severity === 'blocker');
  const warnings = report.violations.filter((v) => v.severity === 'warn');
  const lines = report.violations.map(
    (v) =>
      `  [${v.severity.toUpperCase()}] ${v.fieldId}: constraint references ` +
      `${v.foreignRefs.join(', ')} — ` +
      (v.severity === 'blocker'
        ? 'not editable on this screen'
        : 'on another screen, but satisfiable by changing this answer') +
      `${v.message ? ` (msg: "${v.message}")` : ''}`,
  );
  const header =
    blockers.length > 0
      ? `constraint-locality: FAIL (${blockers.length} of ${report.constraintsChecked} constraint(s) non-local` +
        (warnings.length > 0 ? `; ${warnings.length} cross-screen warning(s)` : '') +
        ')'
      : `constraint-locality: WARN (${warnings.length} of ${report.constraintsChecked} constraint(s) cross a screen boundary but are fixable in place)`;
  return [header, ...lines].join('\n');
}

//
// ---------------------------------------------------------------------------
// Relevance reachability — the TEMPORAL sibling of constraint locality.
// ---------------------------------------------------------------------------
//
// Constraint locality asks "can the user fix this WHERE it fires?".
// Relevance reachability asks "can the form KNOW this by the time it's passed?".
//
// A `relevant` clause that references a field ordered strictly LATER can never
// be true at the moment the form walks past the gated field: CommCare only
// advances to the next relevant question after the current index, so the field
// is skipped and — if a later branch then ends the form — never revisited.
//
// Why this exists: dimagi-internal/ace#996. On hh-poverty-targeting/20260727-1406
// the Deliver form's `outcome_note` sat on the dwelling-status screen with
//
//   relevant = dwelling_status != 'occupied_eligible'
//           or respondent_eligible = 'neither'
//           or consent = 'no'
//
// The first clause resolves on that screen and works. The other two are answered
// a screen LATER, so refusals and no-eligible-respondent visits walked straight
// past the note and submitted empty — exactly the two outcomes an operator most
// wants a free-text explanation for.
//
// Same family as ace#979 (observable-before-derived) and ace#980 (constraint
// locality): all three come from authoring a form as a data model rather than as
// a walk. All three are mechanically detectable from field order plus expression
// references, which is why they are parsers and not rubric prose.
//

export interface RelevanceViolation {
  nodeset: string;
  fieldId: string;
  relevant: string;
  /** Referenced nodes that are answered later than this field. */
  laterRefs: string[];
  /**
   * True when EVERY reference is later — the field is unreachable outright.
   * False when only some are (the clause is partially decidable, e.g. an `or`
   * whose first term resolves in time), which is the subtler and more common
   * shape.
   */
  whollyUnreachable: boolean;
}

export interface RelevanceReachabilityReport {
  relevancesChecked: number;
  violations: RelevanceViolation[];
}

/**
 * Flag `relevant` expressions that reference a field the user has not reached
 * yet. Resolves calculates transitively (same as the constraint check), so a
 * hidden calculate over a later answer is still caught — it inherits the
 * position of the latest real question it depends on.
 */
export function checkRelevanceReachability(
  xml: string,
): RelevanceReachabilityReport {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const binds = Array.from(doc.getElementsByTagName('bind'));

  const calculates = new Map<string, string>();
  const questionNodesets = new Set<string>();
  const bindOrder = new Map<string, number>();

  binds.forEach((b, i) => {
    const ns = b.getAttribute('nodeset');
    if (!ns) return;
    if (!bindOrder.has(ns)) bindOrder.set(ns, i);
    const calc = b.getAttribute('calculate');
    if (calc) calculates.set(ns, calc);
    else questionNodesets.add(ns);
  });

  /**
   * Effective position of a reference. A calculate has no screen of its own, so
   * it resolves to the LATEST question it transitively depends on — that is when
   * its value actually becomes known.
   */
  const effectivePosition = (ref: string, depth = 0): number => {
    if (depth > 8) return -1;
    const calc = calculates.get(ref);
    if (calc === undefined) return bindOrder.get(ref) ?? -1;
    let latest = -1;
    for (const inner of calc.match(PATH_REF) ?? []) {
      if (inner === ref) continue;
      latest = Math.max(latest, effectivePosition(inner, depth + 1));
    }
    return latest;
  };

  const violations: RelevanceViolation[] = [];
  let relevancesChecked = 0;

  for (const b of binds) {
    const nodeset = b.getAttribute('nodeset');
    const relevant = b.getAttribute('relevant');
    if (!nodeset || !relevant) continue;
    relevancesChecked++;

    const ownIdx = bindOrder.get(nodeset);
    if (ownIdx === undefined) continue;

    const refs = new Set(relevant.match(PATH_REF) ?? []);
    const later: string[] = [];
    let resolvable = 0;

    for (const ref of refs) {
      if (ref === nodeset) continue;
      // Only real questions establish a "when is this answered" position.
      const pos = effectivePosition(ref);
      if (pos < 0) continue;
      const isQuestionish =
        questionNodesets.has(ref) || calculates.has(ref);
      if (!isQuestionish) continue;
      if (pos > ownIdx) later.push(ref);
      else resolvable++;
    }

    if (later.length > 0) {
      violations.push({
        nodeset,
        fieldId: lastSegment(nodeset),
        relevant,
        laterRefs: later,
        whollyUnreachable: resolvable === 0,
      });
    }
  }

  return { relevancesChecked, violations };
}

/** One-line-per-violation human summary for a QA verdict. */
export function formatRelevanceReachabilityReport(
  report: RelevanceReachabilityReport,
): string {
  if (report.violations.length === 0) {
    return `relevance-reachability: PASS (${report.relevancesChecked} relevance expression(s) checked, all decidable in order)`;
  }
  const lines = report.violations.map(
    (v) =>
      `  ${v.fieldId}: relevance references ${v.laterRefs.join(', ')} — ` +
      (v.whollyUnreachable
        ? 'answered later, so this field can NEVER show'
        : 'answered later, so those clauses can never contribute'),
  );
  return [
    `relevance-reachability: FAIL (${report.violations.length} of ${report.relevancesChecked} relevance expression(s) reference later answers)`,
    ...lines,
  ].join('\n');
}
