/**
 * Re-release invariants for a Deliver app whose Connect opportunity already
 * exists (dimagi-internal/ace#2691).
 *
 * ## What Connect actually keys on
 *
 * Read from `dimagi/commcare-connect` @ `046c7fd7` (2026-10-05), not guessed:
 *
 * - A forwarded submission finds its opportunity by **HQ domain + HQ app id**
 *   (`form_receiver/processor.py:78` → `:624-631`). A Nova re-upload keeps the
 *   HQ app id (`hq_app_action: updated`).
 * - The Connect `<deliver id="…">` block's **`@id`** picks the DeliverUnit
 *   (`processor.py:605-613`, `get_or_create(app, slug=@id)`), and the payment
 *   unit comes from that DeliverUnit (`processor.py:428`).
 * - A submission carrying an `@id` Connect has not seen creates a NEW
 *   DeliverUnit lazily — with no payment unit — and the visit errors with
 *   `Payment unit is not configured` (`processor.py:429-433`).
 * - Form-field rules are keyed by **question path + deliver unit**
 *   (`opportunity/models.py:1275-1282`) and evaluated as JSONPath
 *   `$.{question_path}` over the forwarded form JSON (`processor.py:395-406`).
 *   A question the new build no longer has resolves to nothing, so the
 *   payability predicate Phase 4 configured stops matching.
 * - The **form xmlns is never used** by Connect.
 *
 * So the invariants a re-release must hold for an opportunity that is already
 * configured are exactly two, and both BLOCK:
 *
 *   1. every deliver `@id` the configured build carried is still present, and
 *      no new `@id` appears (a renamed id is both);
 *   2. every configured `form_field_rules[].question_path` still exists in a
 *      form that carries a deliver block.
 *
 * ## Why xmlns is a WARN, not a BLOCK
 *
 * Nova re-mints EVERY form's xmlns on every `upload_app_to_hq`, touched or not
 * (ace#2691: v9 `a81ff5d1…` → v16 `6fc2b08f…` → v23 `1583a130…` for the same
 * meeting form). Connect does not care — live, six visits across v9 and v16
 * landed under the same "Verified community meeting" unit. But consumers that
 * DO key on xmlns split at the re-release:
 *
 *   - HQ exports, reports and UCR data sources keyed on form xmlns;
 *   - connect-labs CCHQ-form pipelines, which resolve the xmlns from the
 *     CURRENT app by form name and fetch only that xmlns
 *     (`labs/analysis/backends/sql/cchq_fetcher.py:160-192`), so every
 *     submission made on an earlier build silently drops out.
 *
 * ACE cannot preserve the xmlns (that is an upstream Nova ask), so a BLOCK
 * would halt every re-release behind a remedy nobody can apply. A WARN keeps
 * the split legible to whoever owns those consumers.
 *
 * ## Class
 *
 * Static parsing of two released CCZs plus the rules Phase 4 recorded. Nothing
 * here is sent to or matched against a device; unit tests on real released
 * fixtures are complete evidence.
 */
import { DOMParser } from '@xmldom/xmldom';
import { type CheckOutcome, checked, formatUnable, unable } from './check-outcome.js';

/** One XForm out of a released CCZ (e.g. `modules-1/forms-0.xml`). */
export interface ReleasedForm {
  path: string;
  xml: string;
}

export interface ReleasedBuild {
  buildId: string;
  forms: ReleasedForm[];
}

/** A `form_field_rules[]` row as Phase 4 recorded it in run_state. */
export interface ConfiguredFormFieldRule {
  name?: string;
  question_path?: string;
  question_value?: string;
  deliver_unit_id?: string | number;
}

export interface DeliverRereleaseInput {
  /** The build the opportunity was configured on (else the previous release). */
  baseline: ReleasedBuild;
  /** The build being released now. */
  candidate: ReleasedBuild;
  /** `phases.connect-setup.products.connect.opportunity.verification.form_field_rules`. */
  rules: ConfiguredFormFieldRule[];
}

export type RereleaseFindingKind =
  | 'deliver-id-disappeared'
  | 'deliver-id-added'
  | 'rule-path-missing'
  | 'form-xmlns-changed';

export interface RereleaseFinding {
  kind: RereleaseFindingKind;
  severity: 'blocker' | 'warn';
  message: string;
}

export interface FormShape {
  path: string;
  /** The `name` attribute of the primary instance root (stable across Nova uploads). */
  formName: string | null;
  xmlns: string | null;
  deliverIds: string[];
  /** Connect `<module id>` (learn namespace) — the LearnModule slug (ace#2705). */
  learnModuleIds: string[];
  /** Connect `<assessment id>` (learn namespace). */
  assessmentIds: string[];
  /** Every element path in the primary instance, `/data/...`. */
  nodePaths: Set<string>;
}

export interface DeliverRereleaseReport {
  /** True when any finding is a blocker — halt the release. */
  blocking: boolean;
  baselineDeliverIds: string[];
  candidateDeliverIds: string[];
  rulePathsChecked: string[];
  xmlnsChanges: XmlnsChange[];
}

export type DeliverRereleaseOutcome = CheckOutcome<RereleaseFinding, DeliverRereleaseReport>;

const FORMDESIGNER_NS = 'http://openrosa.org/formdesigner/';
const CONNECT_NS = 'http://commcareconnect.com/data/v1/learn';

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

/** The primary instance root: the first `<instance>` with no `id`, first element child. */
function primaryInstanceRoot(doc: Document): Element | null {
  for (const inst of Array.from(doc.getElementsByTagName('instance'))) {
    if (inst.getAttribute('id')) continue;
    const kids = elementChildren(inst);
    if (kids.length > 0) return kids[0];
  }
  return null;
}

/** Parse one released XForm into the shape the invariants compare. Null when unreadable. */
export function readFormShape(form: ReleasedForm): FormShape | null {
  let doc: Document;
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(form.xml, 'text/xml') as unknown as Document;
  } catch {
    return null;
  }
  const root = primaryInstanceRoot(doc);
  if (!root) return null;
  const ns = root.namespaceURI ?? root.getAttribute('xmlns');
  const nodePaths = new Set<string>();
  const deliverIds: string[] = [];
  const learnModuleIds: string[] = [];
  const assessmentIds: string[] = [];
  const walk = (el: Element, prefix: string) => {
    const p = `${prefix}/${el.localName}`;
    nodePaths.add(p);
    if (el.namespaceURI === CONNECT_NS) {
      const id = el.getAttribute('id');
      if (id && el.localName === 'deliver') deliverIds.push(id);
      if (id && el.localName === 'module') learnModuleIds.push(id);
      if (id && el.localName === 'assessment') assessmentIds.push(id);
    }
    for (const c of elementChildren(el)) walk(c, p);
  };
  walk(root, '');
  return {
    path: form.path,
    formName: root.getAttribute('name') || null,
    xmlns: ns && ns.startsWith(FORMDESIGNER_NS) ? ns : null,
    deliverIds,
    learnModuleIds,
    assessmentIds,
    nodePaths,
  };
}

/**
 * Convert a recorded `question_path` to the XForm node path it names.
 * `form.meeting.meeting_conducted` / `$.form.…` → `/<root>/meeting/meeting_conducted`;
 * `/data/…` passes through. HQ nests the instance under `form` whatever the
 * root element is called (see `lib/connect-question-path.ts`).
 */
export function ruleToNodePath(questionPath: string, rootName = 'data'): string | null {
  const t = questionPath.trim();
  if (!t) return null;
  if (t.startsWith('/')) return t.replace(/\/+$/, '');
  const segs = t.replace(/^\$\./, '').split('.').filter(Boolean);
  if (segs.length < 2 || segs[0] !== 'form') return null;
  return `/${rootName}/${segs.slice(1).join('/')}`;
}

export function shapes(build: ReleasedBuild): { ok: FormShape[]; unreadable: string[] } {
  const ok: FormShape[] = [];
  const unreadable: string[] = [];
  for (const f of build.forms) {
    const s = readFormShape(f);
    if (s) ok.push(s);
    else unreadable.push(f.path);
  }
  return { ok, unreadable };
}

export const uniq = (xs: string[]) => [...new Set(xs)].sort();

export interface XmlnsChange {
  form: string;
  from: string;
  to: string;
}

/** Forms (matched by instance `name`, else by CCZ path) whose xmlns differs between two builds. */
export function formXmlnsChanges(base: FormShape[], cand: FormShape[]): XmlnsChange[] {
  const out: XmlnsChange[] = [];
  for (const b of base) {
    const c = (b.formName && cand.find((s) => s.formName === b.formName)) || cand.find((s) => s.path === b.path);
    if (!c || !b.xmlns || !c.xmlns || b.xmlns === c.xmlns) continue;
    out.push({ form: b.formName ?? b.path, from: b.xmlns, to: c.xmlns });
  }
  return out;
}

export function checkDeliverRerelease(input: DeliverRereleaseInput): DeliverRereleaseOutcome {
  const base = shapes(input.baseline);
  const cand = shapes(input.candidate);
  if (base.ok.length === 0) {
    return unable(
      `no readable form in the baseline build ${input.baseline.buildId}` +
        (base.unreadable.length ? ` (unreadable: ${base.unreadable.join(', ')})` : ''),
    );
  }
  if (cand.ok.length === 0) {
    return unable(
      `no readable form in the candidate build ${input.candidate.buildId}` +
        (cand.unreadable.length ? ` (unreadable: ${cand.unreadable.join(', ')})` : ''),
    );
  }
  const baseIds = uniq(base.ok.flatMap((s) => s.deliverIds));
  if (baseIds.length === 0) {
    return unable(
      `baseline build ${input.baseline.buildId} carries no Connect <deliver> block — ` +
        `it is not the Deliver build the opportunity was configured on`,
    );
  }
  const candIds = uniq(cand.ok.flatMap((s) => s.deliverIds));
  const findings: RereleaseFinding[] = [];

  for (const id of baseIds.filter((x) => !candIds.includes(x))) {
    findings.push({
      kind: 'deliver-id-disappeared',
      severity: 'blocker',
      message:
        `deliver @id "${id}" (configured in ${input.baseline.buildId}) is absent from ${input.candidate.buildId}. ` +
        `Connect picks the DeliverUnit — and so the payment unit — by this @id (commcare-connect ` +
        `form_receiver/processor.py:605-613, :428); visits on the new build would not count toward it. ` +
        `Restore the @id in the Deliver app (Nova Connect config) and re-release.`,
    });
  }
  for (const id of candIds.filter((x) => !baseIds.includes(x))) {
    findings.push({
      kind: 'deliver-id-added',
      severity: 'blocker',
      message:
        `deliver @id "${id}" is new in ${input.candidate.buildId}. Connect would create its DeliverUnit lazily ` +
        `with NO payment unit, and every such visit errors "Payment unit is not configured" ` +
        `(commcare-connect form_receiver/processor.py:429-433). Restore the configured @id ` +
        `(${baseIds.join(', ')}), or configure a payment unit for "${id}" in Connect before releasing.`,
    });
  }

  const deliverForms = cand.ok.filter((s) => s.deliverIds.length > 0);
  const rulePathsChecked: string[] = [];
  for (const r of input.rules) {
    const raw = (r.question_path ?? '').trim();
    const label = r.name ? `rule "${r.name}"` : 'form_field_rule';
    const present = deliverForms.some((s) => {
      const root = [...s.nodePaths][0]?.split('/')[1] ?? 'data';
      const node = ruleToNodePath(raw, root);
      return node !== null && s.nodePaths.has(node);
    });
    rulePathsChecked.push(raw);
    if (!present) {
      findings.push({
        kind: 'rule-path-missing',
        severity: 'blocker',
        message:
          `${label} question_path "${raw || '(empty)'}" names no question in any deliver form of ` +
          `${input.candidate.buildId}. Connect evaluates it as JSONPath $.{question_path} over the visit's form ` +
          `JSON (commcare-connect form_receiver/processor.py:395-406), so the Phase 4 payability predicate would ` +
          `stop matching. Keep the question at that path, or update the opportunity's form_field_rules before releasing.`,
      });
    }
  }

  const xmlnsChanges = formXmlnsChanges(base.ok, cand.ok);
  if (xmlnsChanges.length > 0) {
    findings.push({
      kind: 'form-xmlns-changed',
      severity: 'warn',
      message:
        `${xmlnsChanges.length} form xmlns changed between ${input.baseline.buildId} and ${input.candidate.buildId} ` +
        `(${xmlnsChanges.map((x) => `${x.form}: …${x.from.slice(-8)} → …${x.to.slice(-8)}`).join('; ')}). ` +
        `Connect payment is unaffected — it never reads form xmlns. But HQ exports/reports/UCR keyed on xmlns ` +
        `split at this release, and connect-labs CCHQ-form pipelines (cchq_fetcher.py:160-192 fetches only the ` +
        `CURRENT app's xmlns) silently drop every submission made on earlier builds. Nova re-mints xmlns on every ` +
        `upload, so ACE cannot prevent it; tell the owner of any such consumer.`,
    });
  }

  const blocking = findings.some((f) => f.severity === 'blocker');
  return {
    ...checked(findings.length === 0, findings),
    blocking,
    baselineDeliverIds: baseIds,
    candidateDeliverIds: candIds,
    rulePathsChecked,
    xmlnsChanges,
  };
}

/** Operator-facing rendering; `[BLOCKER]` / `[WARN]` lines, never green on `unable`. */
export function formatDeliverRerelease(outcome: DeliverRereleaseOutcome): string {
  const label = 'deliver-rerelease-invariants';
  if (outcome.status === 'unable') return formatUnable(label, outcome.reason);
  if (outcome.findings.length === 0) {
    return (
      `${label}: deliver @id(s) ${outcome.candidateDeliverIds.join(', ')} unchanged; ` +
      `${outcome.rulePathsChecked.length} form_field_rule path(s) present; form xmlns unchanged.`
    );
  }
  return outcome.findings
    .map((f) => `[${f.severity === 'blocker' ? 'BLOCKER' : 'WARN'}] ${f.kind}: ${f.message}`)
    .join('\n');
}
