//
// Pure static check: does a form derive values from a subtree it never visited?
//
// The defect (dimagi-internal/ace#1823). A Deliver form gates the household
// roster on consent — `relevant="/data/consent_screen/consent = 'yes'"` — and
// then computes thirteen derived values at form ROOT, where no `relevant`
// applies. On a vacant / refused / no-eligible-respondent visit the roster is
// skipped, `count()` over the empty nodeset returns **0**, and the form submits
// a complete, confident, wrong record:
//
//     member_count = 0
//     hh_size_band = 'le3'      <- the 31-point band
//     size_points  = 31
//
// One node in that chain WAS guarded — `ppi_score` carries
// `if(/data/visit_outcome = 'completed', <sum>, '')` inline — so the score is
// correctly blank and nothing looks wrong at the score level. The corruption is
// one layer down, in the band, and the band is the field a band-boundary fraud
// control groups on. On hh-poverty-targeting/20260828-0702 that is **1,072 of
// 3,794 records** (28%) landing in the 31-point band by construction. A worker
// with more vacant doors looks like a worker clustering at the boundary: the
// signal and the artefact are indistinguishable.
//
// Every gate was blind to it. `validate_app` checks structure; the eval grades
// against a narrative PDD; `app-release-qa` checks counts and install-time
// behaviour. A `calculate` over an empty nodeset is perfectly valid XForm, so
// the app compiles, installs, plays and submits.
//
// Why a parser and not a rubric line: the class is fully mechanical, so it
// belongs with `lib/screen-shape.ts`, `lib/constraint-locality.ts` and
// `lib/taught-vs-collectable.ts` rather than in a judge's prose.
//
// What counts as GUARDED — deliberately two shapes, because the app that
// motivated this used the second:
//
//   1. the field carries its own `relevant`, or
//   2. its `calculate` is a conditional whose CONDITION reads a field outside
//      the gated subtree — the `ppi_score` shape. A conditional whose condition
//      reads only tainted fields is not a guard, it is the corruption wearing
//      an `if()`: `hh_size_band = if(member_count <= 3, 'le3', …)` looks
//      defensive and faithfully converts a phantom 0 into a phantom band.
//
// Taint therefore PROPAGATES. Guarding only the leaf that reads the roster is
// not enough and guarding only the final score is not enough; every node
// between the gated subtree and the submitted record has to be able to say why
// its value means something on a visit that never happened.
//
// This does NOT claim a zero over an empty nodeset is always wrong. Sometimes
// it is exactly right ("units delivered on a refused visit: 0"). It claims the
// form has to SAY so — the finding is cleared by a guard or by a recorded
// justification, not by silence.
//

/** One field as read from Nova `get_form` / `get_app`. */
export interface DerivedField {
  id: string;
  /** Nova field kind (`group`, `repeat`, `hidden`, `single_select`, …). */
  kind: string;
  /** The field's `relevant` expression, when it has one. */
  relevant?: string;
  /** The field's `calculate` expression, when it has one. */
  calculate?: string;
  /** Children of a `group` / `repeat`. */
  children?: DerivedField[];
}

export interface DerivedChainFinding {
  /** The unguarded derived field. */
  fieldId: string;
  /** Its `calculate`, verbatim. */
  calculate: string;
  /**
   * The gated field this value ultimately reads from, and the `relevant` that
   * gates it — the two facts a human needs to judge the finding.
   */
  gatedSourceId: string;
  gate: string;
  /** True when the taint arrived through another derived field, not directly. */
  transitive: boolean;
  detail: string;
}

export interface DerivedChainReport {
  /** Root-level fields carrying a `calculate` that were examined. */
  derivedChecked: number;
  /** Fields found inside at least one `relevant`-gated container. */
  gatedSources: string[];
  findings: DerivedChainFinding[];
}

interface Flat {
  field: DerivedField;
  /** The nearest enclosing `relevant`, inherited from any ancestor. */
  inheritedGate?: string;
  /** The id of the ancestor that carries `inheritedGate`. */
  gateOwner?: string;
}

/**
 * Flatten the tree, carrying each field's inherited `relevant` down to it.
 *
 * A field's own `relevant` gates its children too, so a value read from deep
 * inside a gated group is just as absent as one read from the group's first
 * child.
 */
function flatten(
  fields: DerivedField[],
  inheritedGate: string | undefined,
  gateOwner: string | undefined,
  out: Flat[],
): void {
  for (const f of fields) {
    const own = f.relevant?.trim();
    const gate = own ? own : inheritedGate;
    const owner = own ? f.id : gateOwner;
    out.push({ field: f, inheritedGate, gateOwner });
    if (f.children?.length) flatten(f.children, gate, owner, out);
  }
}

/**
 * Field ids an expression reads.
 *
 * Matches both the absolute `/data/foo` form Nova emits and a bare `foo`, then
 * keeps only tokens that name a real field on this form — which is what stops
 * XPath function names (`count`, `if`, `coalesce`) and string literals from
 * being read as references.
 */
export function referencedFields(expr: string, known: Set<string>): string[] {
  if (!expr) return [];
  // Strip string literals first: 'le3' must never resolve to a field named le3.
  const bare = expr.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const hits = new Set<string>();
  for (const m of bare.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    for (const seg of m[0].split('/')) {
      if (known.has(seg)) hits.add(seg);
    }
  }
  return [...hits];
}

/**
 * The CONDITION of a leading conditional, or null when the expression is not
 * one.
 *
 * `if(a = 'x', b, c)` -> `a = 'x'`. Depth-aware so a nested call in the
 * condition (`if(count(r) > 0, …)`) does not terminate it early.
 */
export function conditionalTest(expr: string): string | null {
  const trimmed = expr.trim();
  const m = /^if\s*\(/.exec(trimmed);
  if (!m) return null;
  let depth = 1;
  const start = m[0].length;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return null; // no comma before close: not a 3-arg if()
    } else if (ch === ',' && depth === 1) {
      return trimmed.slice(start, i);
    }
  }
  return null;
}

/**
 * Find root-level derived fields that read a `relevant`-gated subtree without
 * saying what their value means when that subtree was skipped.
 *
 * Iterates to a fixpoint so taint propagates along the whole derived chain —
 * guarding the final score while leaving the band unguarded is the exact shape
 * that shipped.
 */
export function checkDerivedChainGuards(fields: DerivedField[]): DerivedChainReport {
  const flat: Flat[] = [];
  flatten(fields, undefined, undefined, flat);

  const known = new Set(flat.map((f) => f.field.id));

  /** id -> the gate it sits under (own or inherited), when it sits under one. */
  const gateOf = new Map<string, { gate: string; owner: string }>();
  for (const f of flat) {
    const own = f.field.relevant?.trim();
    const gate = own ?? f.inheritedGate;
    const owner = own ? f.field.id : f.gateOwner;
    if (gate && owner) gateOf.set(f.field.id, { gate, owner });
  }

  // Root-level = not under any gate. Only those can silently produce a value on
  // a visit that skipped the subtree they read.
  const ungatedDerived = flat.filter(
    (f) => !gateOf.has(f.field.id) && (f.field.calculate ?? '').trim().length > 0,
  );

  const tainted = new Set<string>(gateOf.keys());
  const findings = new Map<string, DerivedChainFinding>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const f of ungatedDerived) {
      if (tainted.has(f.field.id)) continue;
      const calc = f.field.calculate!.trim();
      const refs = referencedFields(calc, known).filter((r) => r !== f.field.id);
      const taintedRefs = refs.filter((r) => tainted.has(r));
      if (taintedRefs.length === 0) continue;

      // Guard shape 2: a conditional whose TEST reads something outside the
      // tainted set. A test that reads only tainted fields is not a guard.
      const test = conditionalTest(calc);
      if (test) {
        const testRefs = referencedFields(test, known).filter((r) => r !== f.field.id);
        if (testRefs.some((r) => !tainted.has(r))) continue;
      }

      // Report against the ORIGINAL gated node where we can, so the finding
      // names the `relevant` a human has to reason about.
      // Prefer the node that OWNS the gate — `roster`, not the leaf
      // `is_member` under it — because the owner is the `relevant` a human
      // has to reason about.
      const direct =
        taintedRefs.find((r) => gateOf.get(r)?.owner === r) ??
        taintedRefs.find((r) => gateOf.has(r));
      const via = direct ?? taintedRefs[0];
      const origin = gateOf.get(via) ?? gateOf.get(taintedRefs[0]);

      tainted.add(f.field.id);
      changed = true;
      findings.set(f.field.id, {
        fieldId: f.field.id,
        calculate: calc,
        gatedSourceId: via,
        gate: origin?.gate ?? '(inherited)',
        transitive: !direct,
        detail:
          `"${f.field.id}" is computed at form root with no guard, but reads ` +
          `"${via}"${direct ? '' : ' (transitively)'}, which is gated on ` +
          `\`${origin?.gate ?? '(inherited)'}\`. When that gate is false the ` +
          `subtree is skipped and this calculate still evaluates — over an ` +
          `empty nodeset — so the form submits a value for a visit that never ` +
          `collected one.`,
      });
    }
  }

  return {
    derivedChecked: ungatedDerived.length,
    gatedSources: [...gateOf.keys()].sort(),
    findings: [...findings.values()].sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
  };
}

/** Human-readable one-block report for the build memo. */
export function formatDerivedChainReport(r: DerivedChainReport): string {
  if (r.findings.length === 0) {
    return `derived-chain guards: OK — ${r.derivedChecked} root-level calculate(s) checked, 0 unguarded.`;
  }
  const lines = [
    `derived-chain guards: ${r.findings.length} UNGUARDED of ${r.derivedChecked} root-level calculate(s) checked.`,
  ];
  for (const f of r.findings) {
    lines.push(`  - ${f.fieldId}${f.transitive ? ' (transitive)' : ''}: ${f.detail}`);
    lines.push(`      calculate: ${f.calculate}`);
  }
  return lines.join('\n');
}
