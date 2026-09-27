//
// Fail a build whose count-bound repeat reads its count from a question the
// worker has not answered yet — a repeat that always renders ZERO rows.
//
// ── The defect (dimagi-internal/ace#2517) ───────────────────────────────────
//
// The released Deliver CCZ of `spark-facilitator/20260926-1413` (HQ app
// 3b7ec74d9883452a8747796e2f777262, build a556b0725f4d465cbe3377fa51d6e382,
// modules-1/forms-0.xml) carries, verbatim:
//
//   <repeat nodeset="/data/community_meeting_activities"
//           jr:count="/data/__nova_count_community_meeting_activities"
//           jr:noAddRemove="true()">
//   <bind nodeset="/data/__nova_count_community_meeting_activities" type="xsd:string"/>
//   <setvalue event="xforms-ready" ref="/data/__nova_count_community_meeting_activities"
//             value="string(/data/activities/activity_number)"/>
//   <input ref="/data/activities/activity_number">
//
// The count node has no `calculate`. Its only writer is a setvalue on
// `xforms-ready`, which fires ONCE, at form open — before the worker has
// answered `activity_number`. Nothing re-writes it (the form has zero
// `xforms-value-changed` events), so `jr:count` reads "" → 0 instances and
// CommCare skips the repeat entirely. Every count-bound repeat in that app had
// this shape, including Participant Feedback's `participants` — so the whole
// feedback round recorded no participants. Phase 6's device walk was the first
// thing to notice, because `commcare-cli play` exercises form init, not a
// repeat entered after an answer.
//
// ── This is Nova's DOCUMENTED semantics, not a Nova compiler slip ───────────
//
// Nova's own compiler notes (voidcraft-labs/commcare-nova
// `lib/commcare/CLAUDE.md` § repeat modes, read 2026-09-27): "Root counts
// initialize on `xforms-ready` … They do not later track answer changes." And
// the architect-facing tool schema for `count_bound`: "Count is fixed when the
// enclosing instance opens. Use user_controlled for rows added while
// answering." So the compiled XML is exactly what Nova promises; what is wrong
// is AUTHORING a root `count_bound` repeat whose count is a same-form answer —
// and Nova's validator accepts it without a word. The upstream ask is a
// validator refusal (voidcraft-labs/commcare-nova#692); the ACE-side
// preventer is this gate.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// A `<repeat jr:count="C">` is DEAD when all of:
//   1. C has no `calculate` bind (a calculate is recomputed — it tracks);
//   2. C is not itself a body control (Core rereads `jr:count` during entry
//      traversal, so a count that IS the question tracks — the Vellum shape);
//   3. C has at least one `<setvalue>` writer, and EVERY writer fires only on
//      `xforms-ready` (an `xforms-value-changed` or any other event re-writes
//      it; a `jr-insert` writer snapshots when a parent row is created, which
//      can legitimately happen after earlier answers, so it is not judged);
//   4. some writer's value reads a WORKER-ANSWERED node — a body control, an
//      ancestor group of one, or (transitively) a calculated node that depends
//      on one. At `xforms-ready` all of those are still empty.
//
// A snapshot of a case property, a session value or a constant is the
// legitimate use of `count_bound` and passes: nothing in it is worker-answered.
//
// ── Why a static CCZ check and not a device run ─────────────────────────────
//
// Same reasoning as `lib/casedb-preload-audit.ts`: the compiled form states
// what ALWAYS happens, the device shows what happened once. It runs at Phase 3
// (`app-release-qa` Step 4) instead of burning a Phase 6 walk.
//

const SETVALUE_NODE_RE = /<setvalue\b[^>]*\/?>/g;
const BIND_NODE_RE = /<bind\b[^>]*\/?>/g;
const REPEAT_NODE_RE = /<repeat\b[^>]*>/g;
/** Answerable body controls. `<trigger>` is display-only — no answer. */
const CONTROL_RE = /<(?:input|select1|select|upload|range)\b[^>]*\bref="([^"]+)"/g;
const ATTR_RE = (name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
/**
 * Absolute instance paths in an XPath expression. The lookbehind skips a
 * `/data/…` that continues a non-primary instance (`instance('x')/data/…`) or
 * a longer path step.
 */
const ABS_PATH_RE = /(?<![\w)\]/.-])\/data(?:\/[A-Za-z_][\w.-]*)*/g;

/** One count-bound repeat whose count can never see the worker's answer. */
export interface DeadRepeatCount {
  /** The repeat's nodeset, e.g. `/data/community_meeting_activities`. */
  repeat: string;
  /** The `jr:count` target, e.g. `/data/__nova_count_community_meeting_activities`. */
  countRef: string;
  /** Every setvalue writing the count node (all `xforms-ready`, by the rule). */
  writers: { event: string; value: string }[];
  /** Worker-answered nodes the snapshot reads, e.g. `/data/activities/activity_number`. */
  workerSources: string[];
}

export interface RepeatCountAuditResult {
  /** All `<repeat>` nodes in the form. */
  repeatsChecked: number;
  /** Repeats carrying `jr:count`. */
  countBound: number;
  /** Count-bound repeats that always render zero rows. */
  violations: DeadRepeatCount[];
}

function attr(node: string, name: string): string | undefined {
  return ATTR_RE(name).exec(node)?.[1];
}

function absPaths(expr: string): string[] {
  return expr.match(ABS_PATH_RE) ?? [];
}

/** True when `path` is `node` or an ancestor of it (reading a group reads its children). */
function reads(path: string, node: string): boolean {
  return node === path || node.startsWith(path + '/');
}

/**
 * Nodes whose value comes from the worker: every body control, closed over
 * `calculate` binds that reference one.
 */
export function workerAnsweredNodes(formXml: string): Set<string> {
  const answered = new Set<string>();
  for (const m of formXml.matchAll(CONTROL_RE)) answered.add(m[1]);

  const calcs: { nodeset: string; refs: string[] }[] = [];
  for (const node of formXml.match(BIND_NODE_RE) ?? []) {
    const nodeset = attr(node, 'nodeset');
    const calculate = attr(node, 'calculate');
    if (nodeset && calculate) calcs.push({ nodeset, refs: absPaths(calculate) });
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const c of calcs) {
      if (answered.has(c.nodeset)) continue;
      if (c.refs.some((r) => [...answered].some((a) => reads(r, a)))) {
        answered.add(c.nodeset);
        grew = true;
      }
    }
  }
  return answered;
}

/** Audit one compiled form for count-bound repeats that can never render a row. */
export function auditRepeatCounts(formXml: string): RepeatCountAuditResult {
  const repeats = formXml.match(REPEAT_NODE_RE) ?? [];
  const calculated = new Set<string>();
  for (const node of formXml.match(BIND_NODE_RE) ?? []) {
    const nodeset = attr(node, 'nodeset');
    if (nodeset && attr(node, 'calculate') !== undefined) calculated.add(nodeset);
  }
  const controls = new Set<string>();
  for (const m of formXml.matchAll(CONTROL_RE)) controls.add(m[1]);

  const setvalues = (formXml.match(SETVALUE_NODE_RE) ?? []).map((n) => ({
    ref: attr(n, 'ref'),
    event: attr(n, 'event') ?? '',
    value: attr(n, 'value') ?? '',
  }));

  let answered: Set<string> | null = null;
  let countBound = 0;
  const violations: DeadRepeatCount[] = [];

  for (const node of repeats) {
    const countRef = attr(node, 'jr:count')?.trim();
    if (!countRef) continue;
    countBound++;
    const repeat = attr(node, 'nodeset') ?? '<no nodeset>';

    if (calculated.has(countRef)) continue; // rule 1
    if (controls.has(countRef)) continue; // rule 2

    const writers = setvalues.filter((s) => s.ref === countRef);
    if (writers.length === 0) continue; // rule 3 — nothing to judge
    const onlyReady = writers.every((w) => {
      const events = w.event.split(/\s+/).filter(Boolean);
      return events.length > 0 && events.every((e) => e === 'xforms-ready');
    });
    if (!onlyReady) continue;

    answered ??= workerAnsweredNodes(formXml);
    const workerSources = new Set<string>();
    for (const w of writers) {
      for (const p of absPaths(w.value)) {
        for (const a of answered) if (reads(p, a)) workerSources.add(p);
      }
    }
    if (workerSources.size === 0) continue; // rule 4 — a legitimate snapshot

    violations.push({
      repeat,
      countRef,
      writers: writers.map((w) => ({ event: w.event, value: w.value })),
      workerSources: [...workerSources],
    });
  }

  return { repeatsChecked: repeats.length, countBound, violations };
}

/** Human-readable gate output for one form. */
export function formatRepeatCountAudit(result: RepeatCountAuditResult, formPath: string): string {
  if (result.violations.length === 0) {
    return (
      `[PASS] ${formPath}: ${result.countBound} count-bound repeat(s), ` +
      `none snapshots an unanswered question.`
    );
  }
  const lines = [
    `[BLOCKER] ${formPath}: ${result.violations.length} of ${result.countBound} ` +
      `count-bound repeat(s) always render ZERO rows.`,
    '',
    'The repeat count is snapshotted once on xforms-ready (form open), before the',
    'worker answers the question it reads, and nothing re-writes it. jr:count is',
    'empty, so CommCare skips the repeat and every submission carries no rows.',
    '',
  ];
  for (const v of result.violations) {
    lines.push(`  - ${v.repeat}  jr:count=${v.countRef}  <- ${v.workerSources.join(', ')}`);
  }
  lines.push(
    '',
    'Fix in the Nova blueprint (_app-component-library § repeat-count-source): a',
    'count_bound count must be known when the form opens (case property, session,',
    'constant). For "worker states N, then fills N rows" use a user_controlled',
    'repeat and derive N as count(<repeat>); any minimum goes on a gate question',
    'AFTER the repeat (ace#1560).',
  );
  return lines.join('\n');
}
