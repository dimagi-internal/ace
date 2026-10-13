/**
 * Does every Layer-1 path a semantic registry reads exist in the RELEASED app? (ace#2883)
 *
 * A registry's Layer 1 is a visit-level pipeline: one field per form path
 * (`{name, path}` or `{name, paths: [...]}` — labs COALESCEs `paths` in order and
 * ignores `path` when `paths` is set). Labs validates the registry's grammar, and
 * `semantic-registry-author-qa` checked its PDD fidelity, but nothing compared a
 * Layer-1 path against the app that will submit the data. So a registry can read a
 * path no released form writes, compile, render on synthetic data, and go empty on
 * real data without a word.
 *
 * Measured on smallholder-seasonal/20261012-1549 (registry 8527): the entity key
 * read `form.case.@case_id`, the path the labs synthetic generator stamps on every
 * synthetic visit (connect-labs `synthetic/generator/fixtures/entities.py`,
 * `forced["form.case.@case_id"] = entity_id`). The released Nova Deliver app wrote
 * its case blocks under `form.__nova_operations.<op>.case` instead:
 *
 *   modules-10/forms-0.xml  /data/__nova_operations/update_participant_plan/case/@case_id
 *   modules-11/forms-0.xml  /data/__nova_operations/update_participant_grant/case/@case_id
 *   modules-12/forms-0.xml  /data/__nova_operations/update_crop_cycle/case/@case_id
 *
 * so the key was NULL on those forms' real visits, the compiled registry's
 * `WHERE <key> IS NOT NULL` dropped them, and four indicators would have read
 * empty while QA passed 12/12. Only the independent eval caught it.
 *
 * The released form XML is the authority: it states what every submission will
 * carry. This module reads the primary instance (and the binds) of each form,
 * turns them into Connect's JSON form paths (`/data/a/b/@c` → `form.a.b.@c`), and
 * checks:
 *
 *  - `layer1-paths` — every field with a `form.` path has at least one candidate
 *    some released form writes (fail), and a candidate no form writes is named
 *    (warn) unless it is a path the labs generator writes on synthetic visits;
 *  - `entity-key`   — the key field resolves in EVERY form that produces a visit
 *    (a form carrying a Connect `<deliver>` block; every form when none does), or
 *    that form's visits silently drop out of every indicator. A form may be
 *    exempted only by declaration, with its reason.
 *
 * Pure: no I/O. Callers pass the unzipped CCZ's `modules-N/forms-M.xml` texts.
 */

export interface Layer1Field {
  name: string;
  path?: string;
  paths?: string[];
  transform?: string;
}

export interface ReleasedForm {
  /** In-zip path, e.g. `modules-12/forms-0.xml`. */
  path: string;
  xml: string;
}

export interface Layer1Finding {
  check: 'layer1-paths' | 'entity-key';
  severity: 'fail' | 'warn';
  field?: string;
  form?: string;
  detail: string;
}

export interface Layer1Report {
  findings: Layer1Finding[];
  /** field name → the in-zip paths of the forms that write at least one of its candidates. */
  resolvedIn: Record<string, string[]>;
  /** The forms that produce a visit row (the key must resolve in each). */
  visitForms: string[];
}

export interface Layer1CheckInput {
  fields: readonly Layer1Field[];
  /** The registry's `properties_doc.entity.key` — a Layer-1 field NAME. */
  keyField?: string;
  forms: readonly ReleasedForm[];
  /** In-zip form path → why its visits legitimately carry no key. */
  keyExempt?: Readonly<Record<string, string>>;
}

/**
 * Paths the labs synthetic generator writes on every synthetic visit whatever the
 * app looks like (connect-labs `entities.py`). Kept as the LAST `paths` fallback so
 * the synthetic demo keys too, they are not "a path no form writes" — they are the
 * synthetic half of the coalesce.
 */
export const SYNTHETIC_GENERATOR_PATHS: ReadonlySet<string> = new Set([
  'form.case.@case_id',
  'form.subcase_0.case.@case_id',
  'form.@name',
]);

const CONNECT_DELIVER = /<(?:[\w-]+:)?deliver\b[^>]*commcareconnect\.com\/data\/v1\/learn/;
const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([^\s=>/]+)\s*=\s*(?:"[^"]*"|'[^']*')/g;

const local = (name: string) => name.replace(/^[\w.-]+:/, '');

/** True when the form carries a Connect `<deliver>` block, i.e. a submission is a visit. */
export function isDeliverForm(xml: string): boolean {
  return CONNECT_DELIVER.test(xml);
}

/** The form's `<h:title>`, for naming it in a finding. */
export function formTitle(xml: string): string | undefined {
  const m = /<(?:h:)?title>([^<]*)<\/(?:h:)?title>/.exec(xml);
  return m?.[1].trim() || undefined;
}

/**
 * Every path a submission of this form carries, in Connect's JSON form-path
 * spelling: elements as `form.<group>.<field>`, attributes as `….@<attr>`.
 * Read from the primary instance (the submission's shape) plus every bind
 * `nodeset`. The second map records which element paths carry attributes,
 * because such an element arrives as `{"#text": …, "@attr": …}`.
 */
export function formSubmissionPaths(xml: string): { paths: Set<string>; withAttributes: Set<string>; relevant: Map<string, string> } {
  const paths = new Set<string>();
  const withAttributes = new Set<string>();
  const relevant = new Map<string, string>();

  // Primary instance: the first <instance> with no id attribute.
  const inst = /<instance(\s[^>]*)?>/g;
  let start = -1;
  for (let m = inst.exec(xml); m; m = inst.exec(xml)) {
    if (!/\sid\s*=/.test(m[1] ?? '')) {
      start = m.index + m[0].length;
      break;
    }
  }
  if (start >= 0) {
    const stack: string[] = [];
    TAG.lastIndex = start;
    for (let m = TAG.exec(xml); m; m = TAG.exec(xml)) {
      if (!m[2]) continue; // comment / CDATA / PI
      const [, closing, rawName, attrs, selfClosing] = m;
      const name = local(rawName);
      if (closing) {
        if (stack.length === 0) break; // </instance>
        stack.pop();
        if (stack.length === 0) break; // the data root closed
        continue;
      }
      const path = stack.length === 0 ? 'form' : `${stack[stack.length - 1]}.${name}`;
      paths.add(path);
      let hasAttr = false;
      for (const a of (attrs ?? '').matchAll(ATTR)) {
        paths.add(`${path}.@${local(a[1])}`);
        hasAttr = true;
      }
      if (hasAttr && stack.length > 0) withAttributes.add(path);
      if (!selfClosing) stack.push(path);
      else if (stack.length === 0) break;
    }
  }

  // Binds: belt and braces for a node the instance walk could not see.
  for (const m of xml.matchAll(/<bind\b[^>]*>/g)) {
    const nodeset = /\snodeset\s*=\s*"([^"]+)"/.exec(m[0]);
    const p = nodeset ? xformRefToFormPath(nodeset[1]) : null;
    if (!p) continue;
    paths.add(p);
    const rel = /\srelevant\s*=\s*"([^"]+)"/.exec(m[0]);
    if (rel) relevant.set(p, decodeXmlAttr(rel[1]));
  }
  return { paths, withAttributes, relevant };
}

const decodeXmlAttr = (v: string) =>
  v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The `relevant` condition gating `path` in this form — on the node itself or the
 * nearest ancestor that has one (an irrelevant group drops everything under it
 * from the submission). Undefined when nothing gates it.
 */
export function gatingCondition(path: string, relevant: ReadonlyMap<string, string>): { node: string; relevant: string } | undefined {
  const segs = elementOf(path).split('.').filter((s) => !s.startsWith('@'));
  for (let i = segs.length; i > 1; i--) {
    const node = segs.slice(0, i).join('.');
    const r = relevant.get(node);
    if (r) return { node, relevant: r };
  }
  return undefined;
}

/** `/data/a/b/@c` → `form.a.b.@c`; null for anything outside `/data`. */
export function xformRefToFormPath(ref: string): string | null {
  const m = /^\/data((?:\/[^/\s]+)*)$/.exec(ref.trim());
  if (!m) return null;
  const segs = m[1].split('/').filter(Boolean).map(local);
  return ['form', ...segs].join('.');
}

/** A field's candidate paths, in labs' COALESCE order (`paths` wins over `path`). */
export function fieldCandidates(field: Layer1Field): string[] {
  if (Array.isArray(field.paths) && field.paths.length) return field.paths.map(String);
  return field.path ? [String(field.path)] : [];
}

/** Strip a trailing `.#text` — it addresses an element's text, so the element must exist. */
const elementOf = (p: string) => p.replace(/\.#text$/, '');

export function checkLayer1Paths(input: Layer1CheckInput): Layer1Report {
  const findings: Layer1Finding[] = [];
  const forms = input.forms.map((f) => ({ ...f, title: formTitle(f.xml), ...formSubmissionPaths(f.xml) }));
  const label = (f: (typeof forms)[number]) => (f.title ? `${f.path} ("${f.title}")` : f.path);
  const resolvedIn: Record<string, string[]> = {};

  if (forms.length === 0) {
    findings.push({ check: 'layer1-paths', severity: 'fail', detail: 'no released form XML was supplied, so no Layer-1 path could be resolved' });
    return { findings, resolvedIn, visitForms: [] };
  }

  for (const field of input.fields) {
    const cands = fieldCandidates(field);
    const formCands = cands.filter((c) => c.startsWith('form.'));
    if (formCands.length === 0) continue; // metadata.* / visit-level columns: not the app's to write
    const writers = new Set<string>();
    const unwritten: string[] = [];
    for (const c of formCands) {
      const hits = forms.filter((f) => f.paths.has(elementOf(c)));
      hits.forEach((f) => writers.add(f.path));
      if (hits.length === 0) unwritten.push(c);
      for (const f of hits) {
        if (!c.endsWith('.#text') && f.withAttributes.has(c)) {
          findings.push({
            check: 'layer1-paths',
            severity: 'warn',
            field: field.name,
            form: f.path,
            detail: `\`${c}\` is an element that carries attributes in ${label(f)}, so its value arrives as {"#text": …, "@…": …} — read \`${c}.#text\``,
          });
        }
      }
    }
    resolvedIn[field.name] = [...writers];
    if (writers.size === 0) {
      findings.push({
        check: 'layer1-paths',
        severity: 'fail',
        field: field.name,
        detail: `reads ${formCands.map((c) => `\`${c}\``).join(', ')}, which no released form writes — on real data this column is always NULL`,
      });
      continue;
    }
    for (const c of unwritten) {
      if (SYNTHETIC_GENERATOR_PATHS.has(c)) continue;
      findings.push({
        check: 'layer1-paths',
        severity: 'warn',
        field: field.name,
        detail: `candidate \`${c}\` is written by no released form — it only ever reads synthetic data`,
      });
    }
  }

  // ── The entity key: every visit-producing form must carry it ─────────────
  const deliver = forms.filter((f) => isDeliverForm(f.xml));
  const visitForms = deliver.length ? deliver : forms;
  if (input.keyField !== undefined) {
    const keyField = input.fields.find((f) => f.name === input.keyField);
    if (!keyField) {
      findings.push({
        check: 'entity-key',
        severity: 'fail',
        field: input.keyField,
        detail: `\`entity.key\` names \`${input.keyField}\`, which is not a Layer-1 field — declare it with the path(s) the released app writes`,
      });
    } else {
      const cands = fieldCandidates(keyField).filter((c) => c.startsWith('form.')).map(elementOf);
      for (const f of visitForms) {
        if (input.keyExempt?.[f.path]) continue;
        const hits = cands.filter((c) => f.paths.has(c));
        if (hits.length) {
          // Present, but maybe only on some submissions: a key every resolving
          // candidate of which sits under a `relevant` is NULL whenever that is false.
          const gates = hits.map((c) => gatingCondition(c, f.relevant));
          if (gates.every(Boolean)) {
            findings.push({
              check: 'entity-key',
              severity: 'warn',
              field: keyField.name,
              form: f.path,
              detail:
                `in ${label(f)} the key is only written when ${gates.map((g) => `\`${g!.node}\` is relevant (\`${g!.relevant}\`)`).join(' or ')} — ` +
                "visits where it is not carry a NULL key and drop out of every indicator; add a path the form always writes, or record the followed entity's id in a hidden field",
            });
          }
          continue;
        }
        const caseIds = [...f.paths].filter((p) => /\.case\.@case_id$/.test(p) || /\.case\.index\.[^.]+$/.test(p));
        findings.push({
          check: 'entity-key',
          severity: 'fail',
          field: keyField.name,
          form: f.path,
          detail:
            `${label(f)} writes none of the key's paths (${fieldCandidates(keyField).map((c) => `\`${c}\``).join(', ') || 'none'}), ` +
            `so every visit from it has a NULL key and the registry's \`WHERE ${keyField.name} IS NOT NULL\` drops it from every indicator. ` +
            (caseIds.length
              ? `Case paths this form does write: ${caseIds.map((p) => `\`${p}\``).join(', ')} — add the one that names the followed entity to the key's \`paths\`.`
              : 'This form writes no case id at all — it records nothing that names the followed entity (an app-build gap; see ace#2883).'),
        });
      }
    }
  }

  return { findings, resolvedIn, visitForms: visitForms.map((f) => f.path) };
}
