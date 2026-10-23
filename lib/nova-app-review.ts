/**
 * Phase 3 post-build app review: the checks of hal's `commcare-app-review`
 * (§§2-5 and the §9 catalog) that can be decided in code, run against the
 * same Nova app snapshot the rest of the pass reads (ace#3132, P12 / T71).
 *
 * ## Why this exists next to the evals
 *
 * The `pdd-to-*-app-eval` skills ask "was the brief built?". This asks "is the
 * result a good CommCare app?", as a field worker meets it and as an app
 * builder would read it. An app can pass every eval and still ship a case type
 * nothing ever opens, or a select with a hand-built "other" twin.
 *
 * ## What is here and what is not
 *
 * Here: structural facts a function can decide with no false negatives on the
 * shape it checks (case types created vs opened, search inputs, label length,
 * catalog signatures). Not here: the judgment passes, i.e. reading order, dead
 * ends, doorstep arithmetic, whether an assessment tests behaviour. Those stay
 * in `skills/app-review/SKILL.md`, which reads forms from the same snapshot.
 *
 * ## Routing is the output
 *
 * Every finding names the layer that can fix it (§5): `builder` (Nova: the
 * blueprint cannot express the right app), `brief` (ACE: Nova could express
 * it and the brief did not ask) or `platform` (CommCare/Connect: real and
 * correct to work around). A `builder` finding that is already tracked carries
 * `knownIssue` and is never refiled. One that is not tracked is NOT filed by
 * ACE: hal verifies it against Nova and CommCare source first (§6/6b/6c),
 * because 3 of the first 5 Nova issues filed without that check were wrong.
 *
 * Report-only. Nothing here gates the build.
 */
import type { NovaAppBundle } from './nova-app-bundle.js';

export type Layer = 'builder' | 'brief' | 'platform';
export type AppKind = 'learn' | 'deliver';

export interface ReviewFinding {
  /** Stable id of the check that fired. */
  check: string;
  /** commcare-app-review section the check comes from. */
  section: string;
  layer: Layer;
  /** §5b, builder findings only: does Classic do it (parity) or neither (sugar)? */
  category?: 'parity' | 'sugar';
  /** An open tracker for this exact workaround. Present ⇒ do not refile. */
  knownIssue?: string;
  app: AppKind;
  appId: string;
  module?: string;
  form?: string;
  fields?: string[];
  message: string;
}

export interface AppShape {
  app: AppKind;
  appId: string;
  name: string;
  modules: number;
  forms: number;
  fields: number;
  hidden: number;
  caseTypes: string[];
  languages: string[];
}

export interface AppReview {
  shapes: AppShape[];
  findings: ReviewFinding[];
  /** builder findings with no known issue: hal verifies these before anything is filed. */
  forVerification: ReviewFinding[];
}

const NOVA = 'https://github.com/voidcraft-labs/commcare-nova/issues';

/** Question labels past this length are a paragraph, not a question (§2). */
export const LONG_LABEL = 250;
/** Hidden score/points fields at or above this count are a hand-rolled scorer (§9-C). */
export const SCORING_FIELDS = 5;
/** A Learn form with this many teaching labels and at most one question is a scroll (§4). */
export const SCROLL_LABELS = 12;

const QUESTION_KINDS = new Set(['text', 'int', 'decimal', 'date', 'time', 'datetime', 'single_select',
  'multi_select', 'geopoint', 'image', 'audio', 'video', 'signature', 'barcode', 'phone']);

interface Leaf { field: any; path: string }

function leaves(fields: any[] | undefined, prefix = ''): Leaf[] {
  const out: Leaf[] = [];
  for (const f of fields ?? []) {
    const path = prefix ? `${prefix}/${f?.id}` : String(f?.id);
    out.push({ field: f, path });
    out.push(...leaves(f?.children, path));
  }
  return out;
}

interface FormView { module: any; meta: any; form: any; fields: Leaf[] }

function formViews(b: NovaAppBundle): FormView[] {
  const out: FormView[] = [];
  for (const m of b.app?.modules ?? []) {
    for (const f of m.forms ?? []) {
      const fr = b.forms.find((x: any) => x?.formUuid === f.uuid);
      out.push({ module: m, meta: f, form: fr?.form ?? {}, fields: leaves(fr?.form?.fields) });
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Two or more inlined language blocks in one label: `**EN.** … **Chichewa.** …`. */
const LANG_MARK = /\*\*\s*[A-Z][A-Za-z]{1,15}\s*[.:]\s*\*\*/g;

export function shapeOf(b: NovaAppBundle, app: AppKind): AppShape {
  const views = formViews(b);
  const all = views.flatMap((v) => v.fields);
  const caseTypes = new Set<string>();
  for (const m of b.app?.modules ?? []) if (m.caseType) caseTypes.add(m.caseType);
  for (const v of views) for (const op of v.form.caseOperations ?? []) if (op?.caseType) caseTypes.add(op.caseType);
  const langs = (b.app?.languages?.available ?? []).map((l: any) => String(l?.language ?? l)).filter(Boolean);
  return {
    app,
    appId: b.appId,
    name: str(b.app?.name),
    modules: (b.app?.modules ?? []).length,
    forms: views.length,
    fields: all.length,
    hidden: all.filter((l) => l.field?.kind === 'hidden').length,
    caseTypes: [...caseTypes].sort(),
    languages: langs,
  };
}

/** Pure. The code-decidable part of the review for ONE app. */
export function reviewApp(b: NovaAppBundle, app: AppKind): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const base = { app, appId: b.appId };
  const views = formViews(b);
  const modules: any[] = b.app?.modules ?? [];
  const getModule = (uuid: string) => b.modules.find((m: any) => m?.uuid === uuid);

  // §3 / §9-G: every case type is written AND read.
  const opened = new Set<string>();
  for (const m of modules) {
    if (m.caseType && (m.forms ?? []).some((f: any) => f?.type === 'followup')) opened.add(m.caseType);
  }
  // A child type a later form updates or closes by expression (Smallholder's
  // `membership`, updated per roster row) is acted on, just not from a case list.
  const actedOn = new Set(opened);
  for (const v of views) {
    for (const op of v.form.caseOperations ?? []) if (op?.action !== 'create' && op?.caseType) actedOn.add(op.caseType);
  }
  const created = new Map<string, string[]>();
  for (const v of views) {
    const add = (t: string) => created.set(t, [...(created.get(t) ?? []), v.meta.name]);
    if (v.meta.type === 'registration' && v.module.caseType) add(v.module.caseType);
    for (const op of v.form.caseOperations ?? []) if (op?.action === 'create' && op.caseType) add(op.caseType);
  }
  for (const [t, forms] of created) {
    if (actedOn.has(t)) continue;
    out.push({
      ...base, check: 'case-type-never-opened', section: '§3', layer: 'brief',
      form: [...new Set(forms)].join(', '),
      message: `Case type "${t}" is created (${[...new Set(forms)].join(', ')}) but nothing opens, updates or closes it, so a worker can never act on one. Correct only if a report or a later app reads it; the brief should say which.`,
    });
  }
  for (const t of opened) {
    if (created.has(t)) continue;
    out.push({
      ...base, check: 'case-type-never-created', section: '§3', layer: 'brief',
      module: modules.filter((m) => m.caseType === t).map((m) => m.name).join(', '),
      message: `Case type "${t}" is opened by follow-up forms but nothing in this app creates it. The cases must come from an import or another app; the brief should name the source, or the case list is empty on day one.`,
    });
  }

  // §3: a follow-up case list with no search inputs.
  const unsearchable = modules.filter((m) => {
    if (!m.caseType || !(m.forms ?? []).some((f: any) => f?.type === 'followup')) return false;
    const gm = getModule(m.uuid);
    const inputs = gm?.case_list_config?.searchInputs;
    return !(Array.isArray(inputs) && inputs.length) && !gm?.case_search_config;
  });
  if (unsearchable.length) {
    out.push({
      ...base, check: 'case-list-no-search', section: '§3', layer: 'brief',
      module: unsearchable.map((m) => m.name).join(', '),
      message: `${unsearchable.length} follow-up case list(s) have no search inputs. With more than a handful of cases per worker, they scroll or give up. Either the brief sizes the caseload as small, or it should ask for search.`,
    });
  }

  for (const v of views) {
    const where = { ...base, module: str(v.module.name), form: str(v.meta.name) };
    const questions = v.fields.filter((l) => QUESTION_KINDS.has(l.field?.kind));

    // §2: question length.
    const long = questions.filter((l) => str(l.field.label).length > LONG_LABEL);
    if (long.length) {
      out.push({
        ...where, check: 'long-question', section: '§2', layer: 'brief', fields: long.map((l) => l.field.id),
        message: `${long.length} question label(s) over ${LONG_LABEL} characters. A worker at a door will not read a paragraph; move the explanation to a hint or a preceding label.`,
      });
    }

    // §9-A: languages inlined into one label.
    const inlined = v.fields.filter((l) => (str(l.field?.label).match(LANG_MARK) ?? []).length >= 2);
    if (inlined.length) {
      out.push({
        ...where, check: 'inlined-languages', section: '§9-A', layer: 'brief', fields: inlined.map((l) => l.field.id),
        message: `${inlined.length} label(s) inline several languages. Nova now has a language layer (add_language / update_translations), so this is the brief not using it, not a missing primitive.`,
      });
    }

    // §9-B: GPS accuracy hand-built from the geopoint's 4th component.
    const geos = v.fields.filter((l) => l.field?.kind === 'geopoint');
    const acc = v.fields.filter((l) => l.field?.kind === 'hidden'
      && geos.some((g) => new RegExp(`selected-at\\(\\s*#form/${g.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,\\s*3\\s*\\)`).test(str(l.field.calculate))));
    if (acc.length) {
      out.push({
        ...where, check: 'hand-built-gps-accuracy', section: '§9-B', layer: 'builder', category: 'sugar',
        knownIssue: `${NOVA}/371`, fields: acc.map((l) => l.field.id),
        message: 'GPS accuracy is computed by hand from the geopoint. Classic has no per-question accuracy attribute either (category 2); the app-level need is §9-H.',
      });
    }

    // §9-C: scoring by hand-rolled hidden fields.
    const scoring = v.fields.filter((l) => l.field?.kind === 'hidden' && /(_score|_points|_pts)$|^score_/.test(str(l.field.id)));
    if (scoring.length >= SCORING_FIELDS) {
      out.push({
        ...where, check: 'hand-rolled-scoring', section: '§9-C', layer: 'builder', category: 'sugar',
        knownIssue: `${NOVA}/372`, fields: scoring.map((l) => l.field.id),
        message: `${scoring.length} hidden fields do scoring arithmetic. Classic hand-rolls the same XPath (Vellum's Assessment Score mug), so this is sugar, not a gap.`,
      });
    }

    // §9-E: "other" built as a select plus a conditional text twin.
    const others = v.fields.filter((l) => l.field?.kind === 'text' && /_other$/.test(str(l.field.id))
      && /'other'/.test(str(l.field.relevant)));
    if (others.length) {
      out.push({
        ...where, check: 'other-paired-text', section: '§9-E', layer: 'builder', category: 'sugar',
        knownIssue: `${NOVA}/374`, fields: others.map((l) => l.field.id),
        message: `${others.length} select(s) carry a hand-built "other, specify" text twin. Vellum has no allow_other concept either, so this is sugar.`,
      });
    }

    if (app !== 'learn') continue;

    // §4: self-attestation as a completion gate.
    const attest = questions.filter((l) => l.field.kind === 'single_select'
      && /^\s*(have|did) you (read|complete|finish|go through|understand)/i.test(str(l.field.label)));
    if (attest.length) {
      out.push({
        ...where, check: 'self-attestation', section: '§4', layer: 'brief', fields: attest.map((l) => l.field.id),
        message: 'A "have you read this?" question has one acceptable answer and gates nothing. Evidence completion with a question about the content instead.',
      });
    }

    // §4: module-as-scroll.
    const labels = v.fields.filter((l) => l.field?.kind === 'label').length;
    if (labels >= SCROLL_LABELS && questions.length <= 1) {
      out.push({
        ...where, check: 'module-as-scroll', section: '§4', layer: 'brief',
        message: `${labels} teaching labels and ${questions.length} question(s): a document, not a training. Check that the split into modules carries pedagogical load.`,
      });
    }
  }
  return out;
}

/** Pure. Review a Learn/Deliver pair (either may be absent). */
export function reviewApps(apps: { learn?: NovaAppBundle; deliver?: NovaAppBundle }): AppReview {
  const shapes: AppShape[] = [];
  const findings: ReviewFinding[] = [];
  for (const kind of ['learn', 'deliver'] as const) {
    const b = apps[kind];
    if (!b) continue;
    shapes.push(shapeOf(b, kind));
    findings.push(...reviewApp(b, kind));
  }
  return { shapes, findings, forVerification: findings.filter((f) => f.layer === 'builder' && !f.knownIssue) };
}

const LAYER_TITLE: Record<Layer, string> = {
  builder: 'Builder (Nova)',
  brief: 'Brief (ACE)',
  platform: 'Platform (CommCare/Connect)',
};

/** Pure. The deterministic half of `3-commcare/app-review.md`. */
export function renderReview(r: AppReview): string {
  const lines: string[] = ['## The apps', ''];
  lines.push('| App | Name | Modules | Forms | Fields | Hidden | Case types | Languages |', '|---|---|---|---|---|---|---|---|');
  for (const s of r.shapes) {
    lines.push(`| ${s.app} | ${s.name} | ${s.modules} | ${s.forms} | ${s.fields} | ${s.hidden} | ${s.caseTypes.join(', ') || '—'} | ${s.languages.join(', ') || '—'} |`);
  }
  lines.push('', `## Structural findings (${r.findings.length})`, '');
  if (!r.findings.length) lines.push('None of the code checks fired.');
  for (const layer of ['builder', 'brief', 'platform'] as const) {
    const fs = r.findings.filter((f) => f.layer === layer);
    if (!fs.length) continue;
    lines.push(`### ${LAYER_TITLE[layer]}`, '');
    for (const f of fs) {
      const where = [f.app, f.module, f.form].filter(Boolean).join(' › ');
      const tag = [f.section, f.category, f.knownIssue ? `known: ${f.knownIssue}` : layer === 'builder' ? 'needs hal §6 verification' : '']
        .filter(Boolean).join(' · ');
      lines.push(`- **${f.check}** (${tag}) — ${where}: ${f.message}${f.fields?.length ? ` Fields: \`${f.fields.join('`, `')}\`.` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
