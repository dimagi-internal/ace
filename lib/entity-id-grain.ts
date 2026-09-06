/**
 * Does the released Deliver app key payment on the grain the PDD mandates?
 *
 * Why this exists (dimagi-internal/ace#1285). On
 * bednet-check-2-visit/20260814-0357 the released build keyed Connect's
 * `entity_id` on **(FLW username, visit date, consent answer)** while the PDD
 * mandated a **per-household business key**. The result is silent,
 * quantifiable UNDER-payment: an FLW who legitimately follows up 5 different
 * households on one day accrues **1** payable unit instead of 5.
 *
 * Nothing caught it. `app-release-qa` passed, `pdd-to-deliver-app-eval` scored
 * 9.2/pass, and the released-CCZ projection was clean with
 * `collision_count: 0` — of course it was: a key that collapses five units
 * into one produces no collisions. It surfaced only in
 * `connect-program-setup-eval`'s `delivery_unit_wiring`, the one rubric that
 * compares the composite against the PDD, and that runs AFTER Phase 4 has
 * wired a payment unit around the wrong grain. Phase 4 cannot repair it:
 * Connect consumes `entity_id` from the form and has no override.
 *
 * Three previously-closed fixes each MOVED `entity_id` and none restored the
 * mandated grain, because no gate compared the composite to the PDD. #969's in
 * particular reads as an over-correction — the payability predicate was moved
 * INTO the key, which fixes slot consumption and breaks the household grain.
 *
 * ## Two checks, one declared and one not
 *
 * The **declared** check needs the PDD's business-key nodes
 * (`program_parameters.entity_id_components`, or the nodes named in
 * § Deliver App Specification). Set comparison, no judgement.
 *
 * The **undeclared** heuristic still fires when nothing is declared: a key made
 * only of worker identity, a date, and answer fields is worker-and-day scoped
 * BY CONSTRUCTION, whatever the PDD says. That is the shape that collapsed
 * five households, and it is decidable from the composite alone.
 */

import { DOMParser } from '@xmldom/xmldom';
import { type CheckOutcome, checked, unable, formatUnable } from './check-outcome.js';

export interface EntityIdComponents {
  /** False when no `entity_id` bind exists, or its calculate cannot be read. */
  resolved: boolean;
  /** Each concat argument, in order. String literals (separators) are dropped. */
  components: string[];
  /** The raw calculate the components came from. */
  raw?: string;
}

function bindsOf(xml: string): Array<{ nodeset: string; calculate: string }> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const out: Array<{ nodeset: string; calculate: string }> = [];
  for (const b of Array.from(doc.getElementsByTagName('bind'))) {
    const nodeset = b.getAttribute('nodeset');
    const calculate = b.getAttribute('calculate');
    if (nodeset && calculate) out.push({ nodeset, calculate });
  }
  return out;
}

/** Split a `concat(...)` argument list at top level, ignoring nested parens. */
function splitConcatArgs(concat: string): string[] {
  const open = concat.indexOf('(');
  if (open === -1) return [];
  let depth = 0;
  const args: string[] = [];
  let cur = '';
  for (let i = open; i < concat.length; i++) {
    const ch = concat[i];
    if (ch === '(') { depth++; if (depth === 1) continue; }
    if (ch === ')') { depth--; if (depth === 0) { args.push(cur); break; } }
    if (ch === ',' && depth === 1) { args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  return args.map((a) => a.trim()).filter(Boolean);
}

/**
 * The nodes `entity_id` is actually keyed on, following one level of
 * indirection (`entity_id -> /data/entity_key -> concat(...)`), which is the
 * shape Nova emits.
 *
 * A `casedb` user lookup collapses to the literal `username` — its whole
 * function in a key is "the worker", and the surrounding XPath is noise.
 */
export function extractEntityIdComponents(xml: string): EntityIdComponents {
  const binds = bindsOf(xml);
  const entity = binds.find((b) => /\/entity_id$/.test(b.nodeset));
  if (!entity) return { resolved: false, components: [] };

  let calc = entity.calculate.trim();
  // One level of indirection: entity_id -> another node holding the concat.
  if (/^\/data\/[\w/-]+$/.test(calc)) {
    const target = binds.find((b) => b.nodeset === calc);
    if (!target) return { resolved: false, components: [], raw: entity.calculate };
    calc = target.calculate.trim();
  }
  if (!/^concat\s*\(/.test(calc)) {
    // A single-node key is legal; treat the node itself as the sole component.
    return { resolved: true, components: [calc], raw: calc };
  }
  const components = splitConcatArgs(calc)
    .filter((a) => !/^'[^']*'$/.test(a) && !/^"[^"]*"$/.test(a))
    .map((a) => (/casedb[\s\S]*\/username$/.test(a) ? 'username' : a));
  return { resolved: true, components, raw: calc };
}

/**
 * One `concat` argument, plus everything its own `calculate` chain reaches.
 *
 * ## Why this exists (dimagi-internal/ace#1810)
 *
 * A component the PDD declares need not appear LITERALLY in the `entity_id`
 * calculate. Whenever the key term needs arithmetic — and a per-entity cap
 * like `min(<meetings_on_current_step>, 3)` always does, because XForms has no
 * inline place to put it — Nova computes it in a named hidden node and puts
 * that NODE in the concat. Recorded verbatim from released Deliver build
 * `b08533bdf26a48a295a362ff204fb88d` (spark-facilitator/20260828-0703):
 *
 * ```xml
 * <bind nodeset="/data/record_a_community_meeting/deliver/entity_id"
 *       calculate="concat(…/@case_id, '-', /data/fcap_step/step, '-',
 *                         /data/meeting_summary/meeting_index, '-',
 *                         /data/meeting_type_screen/meeting_type)"/>
 * <bind nodeset="/data/meeting_summary/meeting_index"
 *       calculate="… min(… /meetings_on_current_step … + 1, 3) …"/>
 * ```
 *
 * The declared component `meetings_on_current_step` IS in the key — one node
 * away. Before this expansion the plain substring test read it as absent and
 * emitted `missing-declared-node`, a `[BLOCKER]` that hard-halts Phase 3 on a
 * CORRECT build. That is the expensive direction: #1441 and #1808 make a check
 * fail to run, this one made it refuse a build that obeyed the PDD.
 *
 * ## Expansion is ONLY for the declared-node test
 *
 * `ANSWER_LIKE` deliberately keeps running against the UNEXPANDED component
 * list. An answer buried one `calculate` deep is still an answer in the grain,
 * so expanding before that test would turn indirection into a laundering path
 * for exactly the #969 over-correction this gate was written to catch.
 */
export interface ExpandedComponent {
  /** The component exactly as it appears in the `concat`. */
  component: string;
  /** Intermediate nodes whose `calculate` was folded in, in expansion order. */
  via: string[];
  /** The component text plus every `calculate` it resolves through. */
  text: string;
}

/** A `/data/...` node path, as it appears inside a `calculate`. */
const DATA_PATH_RE = /\/data\/[A-Za-z_][\w-]*(?:\/[A-Za-z_][\w-]*)*/g;

/**
 * Bounded so a pathological blueprint cannot make the gate hang, and
 * cycle-guarded because XForms does not forbid a `calculate` cycle at the
 * text level even though the engine would reject it.
 */
const MAX_EXPANSION_DEPTH = 4;

/**
 * Fold each component's `calculate` chain into its text, so a declared node
 * reached through an intermediate node is found. See `ExpandedComponent`.
 */
export function expandEntityIdComponents(
  xml: string,
  components: string[],
): ExpandedComponent[] {
  const byNodeset = new Map(bindsOf(xml).map((b) => [b.nodeset, b.calculate]));
  return components.map((component) => {
    const via: string[] = [];
    const parts: string[] = [component];
    const seen = new Set<string>();
    const walk = (text: string, depth: number): void => {
      if (depth >= MAX_EXPANSION_DEPTH) return;
      for (const path of text.match(DATA_PATH_RE) ?? []) {
        if (seen.has(path)) continue;
        seen.add(path);
        const calc = byNodeset.get(path);
        if (calc === undefined) continue;
        via.push(path);
        parts.push(calc);
        walk(calc, depth + 1);
      }
    };
    walk(component, 0);
    return { component, via, text: parts.join(' ') };
  });
}

export type GrainFindingKind =
  /** A node the PDD declared as part of the key is absent from it. */
  | 'missing-declared-node'
  /** The key carries a worker-chosen ANSWER — a payability predicate in the grain. */
  | 'answer-in-grain'
  /** No declaration, and nothing in the key identifies the tracked entity. */
  | 'no-entity-component';

export interface GrainFinding {
  kind: GrainFindingKind;
  detail: string;
}

/**
 * `status: 'unable'` when there is no readable `entity_id` calculate. That is
 * NOT a pass and is no longer expressible as one — `lib/check-outcome.ts`.
 */
export type GrainReport = CheckOutcome<
  GrainFinding,
  {
    components: string[];
    /**
     * Declared nodes that are in the key only THROUGH an intermediate node
     * (ace#1810), as `<declared> via <node>[ -> <node>]`. Empty on a key whose
     * declared components all appear literally.
     *
     * Not a finding — the component is present, so the gate passes. It is
     * surfaced because presence is all this check can establish: an
     * intermediate node carrying `min(x, 3)` and one carrying an UNCLAMPED
     * running index produce a byte-identical composite. Phase 4's
     * `connect-opp-setup § Archetypes -> longitudinal-visits` is where the
     * clamp semantics get read off the intermediate node's own bind.
     */
    resolvedThroughIntermediate: string[];
    /** The operator-facing report line(s) for the `checked` branch. */
    detail: string;
  }
>;

/** Nodes that are worker identity or time, never entity identity. */
const NON_ENTITY = /^(username|\/data\/[\w/-]*(date|time|today|now)[\w/-]*)$/i;
/** Node names that are a worker's ANSWER — a predicate, not an identity. */
const ANSWER_LIKE = /(consent|confirm|eligib|payable|status|outcome|conducted|agree|yes_no)/i;

/**
 * True when `component` is the node `want` names — comparing the last path
 * segment, so a PDD saying `consent_confirmed` matches a released
 * `/data/consent_block/consent_confirmed`.
 */
function nodeTailMatches(component: string, want: string): boolean {
  const tail = (x: string) => x.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  return tail(component) === tail(want);
}

export interface GrainCheckOpts {
  /**
   * The field that discriminates payable from non-payable, when the PDD
   * declares a non-payable branch. Pass it and `hasNonPayableBranch` together.
   */
  payabilityDiscriminator?: string;
  /** True when the PDD marks a subset of submissions to this form non-payable. */
  hasNonPayableBranch?: boolean;
}

/**
 * ## The mandated shape and this gate disagreed (ace#1441)
 *
 * `_app-component-library § payability-scoped-key` requires the payability
 * discriminator INSIDE `entity_id` whenever a non-payable branch exists (#969),
 * and ace#1434 made that unconditional by ruling it wins over a PDD-pinned
 * identity-only grain. A discriminator is an ANSWER by construction — that is
 * what discriminates — so every build obeying the mandate tripped
 * `answer-in-grain`, and, with the residual key being worker + date, also
 * `no-entity-component`.
 *
 * This gate is halt-loud at Phase 3, so any opportunity declaring a non-payable
 * branch could not clear it: the component library told the builder to ship a
 * key the release gate refused. #1285's counter-evidence comment predicted
 * exactly this — "a gate hard-asserting either shape will false-fail the
 * other". The ruling shipped in 0.13.897 without reconciling the gate.
 *
 * The check could not even SEE the question: its only inputs were the form XML
 * and `declaredNodes`, so it had no way to know a non-payable branch existed.
 * It now takes the same inputs `resolveEntityIdGrain()` does and suppresses the
 * two findings for the ONE component that resolution mandates — never for any
 * other answer field, which is still exactly the #969 over-correction it was
 * written to catch.
 */
export function checkEntityIdGrain(
  xml: string,
  declaredNodes: string[] = [],
  opts: GrainCheckOpts = {},
): GrainReport {
  const { resolved, components } = extractEntityIdComponents(xml);
  if (!resolved) {
    return unable(
      'no readable entity_id calculate was found in the form XML, so the dedup grain could not be ' +
        'inspected at all. If the form DOES set entity_id, extractEntityIdComponents is the bug',
    );
  }

  const findings: GrainFinding[] = [];
  const flat = components.join(' ');

  // ace#1810: a declared component may reach the key through an intermediate
  // node. Expansion applies to THIS test only — see `ExpandedComponent`.
  const expanded = declaredNodes.length > 0 ? expandEntityIdComponents(xml, components) : [];
  const resolvedThroughIntermediate: string[] = [];

  for (const want of declaredNodes) {
    if (flat.includes(want)) continue;
    const hop = expanded.find((e) => e.via.length > 0 && e.text.includes(want));
    if (hop) {
      resolvedThroughIntermediate.push(`${want} via ${hop.via.join(' -> ')}`);
      continue;
    }
    findings.push({
      kind: 'missing-declared-node',
      detail:
        `the PDD's business key names ${want}, which the released entity_id does not reference — ` +
        'neither literally nor through the calculate of any node it concatenates',
    });
  }

  // The one component the ruling mandates, if any. Matched on the node's tail
  // so a declared `consent_confirmed` matches the released
  // `/data/consent_block/consent_confirmed`.
  const mandated =
    opts.hasNonPayableBranch === true && opts.payabilityDiscriminator
      ? components.find((c) => nodeTailMatches(c, opts.payabilityDiscriminator!))
      : undefined;

  for (const c of components) {
    if (c === mandated) continue; // required by payability-scoped-key (ace#1434/#1441)
    if (ANSWER_LIKE.test(c)) {
      findings.push({
        kind: 'answer-in-grain',
        detail:
          `${c} is a worker-chosen ANSWER, not entity identity — a payability predicate inside the ` +
          'dedup grain changes which submissions are the "same" unit. This is the ace#969 ' +
          'over-correction: moving the predicate INTO the key fixes slot consumption and breaks the grain',
      });
    }
  }

  // Fires with no declaration at all: a key of worker + time + answers is
  // worker-and-day scoped by construction, whatever the PDD says.
  // The mandated discriminator is excluded here too: it is not an entity
  // component and was never claimed to be. Suppress the finding only when the
  // RESIDUAL key — everything except the mandated discriminator — is exactly
  // what the PDD declared, i.e. the build kept the pinned grain and added the
  // one component it was told to. A key that is worker + day + answer with NO
  // declared grain behind it is still the real defect.
  const residual = components.filter((c) => c !== mandated);
  const residualIsDeclared =
    declaredNodes.length > 0 &&
    declaredNodes.every((want) => residual.some((c) => c.includes(want)));
  const hasEntityNode = residual.some((c) => !NON_ENTITY.test(c) && !ANSWER_LIKE.test(c));
  if (!hasEntityNode && !(mandated !== undefined && residualIsDeclared)) {
    findings.push({
      kind: 'no-entity-component',
      detail:
        `no component identifies the tracked entity — the key is ${components.join(' + ')}, which is ` +
        'worker-and-day scoped by construction',
    });
  }

  // Named on both branches: the operator must see that a declared component is
  // present only by indirection, whether or not something else failed.
  const indirection = resolvedThroughIntermediate.map(
    (r) =>
      `  [resolved-through-intermediate] ${r} — presence is established, the ` +
      "intermediate node's SEMANTICS are not (ace#1810)",
  );

  if (findings.length === 0) {
    return {
      ...checked(true, findings),
      components,
      resolvedThroughIntermediate,
      detail: [`entity-id-grain: clean — keyed on ${components.join(' + ')}`, ...indirection].join(
        '\n',
      ),
    };
  }

  return {
    ...checked(false, findings),
    components,
    resolvedThroughIntermediate,
    detail: [
      `entity-id-grain: the released key is ${components.join(' + ')}, which is NOT the mandated grain.`,
      'Every legitimate same-day submission past the first collapses into one payable unit, so the',
      'programme silently UNDER-pays and the CCZ projection still reports collision_count: 0.',
      'Phase 4 cannot repair this — Connect consumes entity_id from the form and has no override',
      '(dimagi-internal/ace#1285).',
      ...findings.map((f) => `  [${f.kind}] ${f.detail}`),
      ...indirection,
    ].join('\n'),
  };
}

/**
 * The operator-facing render. `unable` never renders as a pass — see
 * `formatUnable`. Use this rather than reading `.detail` directly, which is
 * only reachable on the `checked` branch by construction.
 */
export function formatGrainReport(report: GrainReport): string {
  if (report.status === 'unable') return formatUnable('entity-id-grain', report.reason);
  return report.detail;
}
