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

export interface GrainReport {
  /** False when there is no readable `entity_id` — not applicable, not a pass. */
  checked: boolean;
  ok: boolean;
  components: string[];
  findings: GrainFinding[];
  detail: string;
}

/** Nodes that are worker identity or time, never entity identity. */
const NON_ENTITY = /^(username|\/data\/[\w/-]*(date|time|today|now)[\w/-]*)$/i;
/** Node names that are a worker's ANSWER — a predicate, not an identity. */
const ANSWER_LIKE = /(consent|confirm|eligib|payable|status|outcome|conducted|agree|yes_no)/i;

export function checkEntityIdGrain(xml: string, declaredNodes: string[] = []): GrainReport {
  const { resolved, components } = extractEntityIdComponents(xml);
  if (!resolved) {
    return {
      checked: false,
      ok: true,
      components: [],
      findings: [],
      detail: 'entity-id-grain: not applicable (no readable entity_id calculate)',
    };
  }

  const findings: GrainFinding[] = [];
  const flat = components.join(' ');

  for (const want of declaredNodes) {
    if (!flat.includes(want)) {
      findings.push({
        kind: 'missing-declared-node',
        detail: `the PDD's business key names ${want}, which the released entity_id does not reference`,
      });
    }
  }

  for (const c of components) {
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
  const hasEntityNode = components.some((c) => !NON_ENTITY.test(c) && !ANSWER_LIKE.test(c));
  if (!hasEntityNode) {
    findings.push({
      kind: 'no-entity-component',
      detail:
        `no component identifies the tracked entity — the key is ${components.join(' + ')}, which is ` +
        'worker-and-day scoped by construction',
    });
  }

  if (findings.length === 0) {
    return {
      checked: true,
      ok: true,
      components,
      findings,
      detail: `entity-id-grain: clean — keyed on ${components.join(' + ')}`,
    };
  }

  return {
    checked: true,
    ok: false,
    components,
    findings,
    detail: [
      `entity-id-grain: the released key is ${components.join(' + ')}, which is NOT the mandated grain.`,
      'Every legitimate same-day submission past the first collapses into one payable unit, so the',
      'programme silently UNDER-pays and the CCZ projection still reports collision_count: 0.',
      'Phase 4 cannot repair this — Connect consumes entity_id from the form and has no override',
      '(dimagi-internal/ace#1285).',
      ...findings.map((f) => `  [${f.kind}] ${f.detail}`),
    ].join('\n'),
  };
}
