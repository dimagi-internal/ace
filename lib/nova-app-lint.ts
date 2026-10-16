/**
 * `nova-app-lint` — the deterministic Phase 3 gate that runs right after a Nova
 * build and after EVERY repair edit, before any LLM eval is dispatched.
 *
 * ## Why this exists (evidence, 2026-10-15/16 runs)
 *
 * Every rule here used to be found by something slower and later:
 *
 * | rule | found by, before | cost |
 * |---|---|---|
 * | `terminology` ("module" in 7 lookup rows) | `pdd-to-deliver-app-eval` prose, 3 passes | ~42 min, smallholder-seasonal/20261015-1402 |
 * | `lookup-binds` whitespace (ace#2984) | Nova `upload_app_to_hq` preflight | full build → upload round-trip, kaduna-graduation/20261015-1411 |
 * | `lookup-binds` blank labels / wiped rows (ace#2978) | Deliver eval at 7.88 + a form that would not submit | a repair round, smallholder |
 * | `case-list-label-fidelity` | `app-release-qa` Step 2.8, after deploy + settings + release | the whole redo chain, kaduna |
 * | `learn-display-gating` (ace#3036) | a device + Connect at Phase 6 | Learn unlaunchable for every role, kaduna |
 *
 * None of them needs judgment. A rule that lives in LLM eval prose is applied
 * when the judge remembers it, costs a full eval dispatch to apply, and tells
 * you at the end of a ~15-minute grade what a function tells you in
 * milliseconds. So the rules live HERE, once, and the evals cite this lint's
 * result instead of re-deriving it (see `skills/pdd-to-*-app-eval § 5b`).
 *
 * ## What it is NOT
 *
 * - Not the release backstop. `app-release-qa` (Step 2.8) still reads the
 *   released CCZ — the compiled artifact is the authority on what ships, and
 *   this lint reads the blueprint that produces it. They overlap on purpose.
 * - Not role-aware Connect coverage. Which form is payable is a PDD reading;
 *   `app-connect-coverage` owns that. This lint checks the structural floor
 *   (markers present, well-formed, cardinality) that needs no PDD.
 *
 * ## Contract
 *
 * Every rule reports a `RuleCheck`: `checked` (ran, N findings) or `unable`
 * (did not run, with a reason). `unable` is never a pass — a rule whose input
 * could not be read makes the verdict `incomplete`, which blocks the gate the
 * same as a blocker does (`lib/check-outcome.ts`, ace#1634).
 *
 * Verdict: any `blocker` → `fail`; else any `unable` → `incomplete`; else any
 * `warn` → `warn`; else `pass`. **`pass` and `warn` both open the gate.** A warn
 * never justifies a repair round on its own (`agents/commcare-setup.md §
 * Step 1.4`), which is what the 8.09→8.22 Learn repair on kaduna spent.
 */

import type { NovaAppBundle, BoundTable } from './nova-app-bundle.js';
import {
  auditLookupBinds,
  findPartiallyBlankRows,
  type LookupBindSite,
} from './option-register.js';
import { checkCaseListEnumDrift, checkMarkdownEatenLabels, type ChoiceLabel } from './choice-label-integrity.js';
import { enumerateCalculateLiterals } from './ccz-enum-fidelity.js';
import { auditReleasedModules } from './starter-module.js';

export type AppType = 'learn' | 'deliver';
export type LintSeverity = 'blocker' | 'warn';

export type LintRule =
  | 'read'
  | 'app-name'
  | 'connect-type'
  | 'terminology'
  | 'lookup-binds'
  | 'lookup-wiped-rows'
  | 'case-list-label-fidelity'
  | 'markdown-labels'
  | 'casedb-prefill'
  | 'learn-display-gating'
  | 'learn-form-navigation'
  | 'connect-markers'
  | 'starter-module';

/** Every rule, in report order. A rule missing from a result is a bug. */
export const LINT_RULES: readonly LintRule[] = [
  'read',
  'app-name',
  'connect-type',
  'terminology',
  'lookup-binds',
  'lookup-wiped-rows',
  'case-list-label-fidelity',
  'markdown-labels',
  'casedb-prefill',
  'learn-display-gating',
  'learn-form-navigation',
  'connect-markers',
  'starter-module',
];

/**
 * Which Nova edit surfaces each rule reads. A repair round that touched ONLY
 * surfaces in this map's union is fully re-verified by re-linting, so the LLM
 * eval need not re-run (`agents/commcare-setup.md § Step 1.4`).
 */
export const LINT_COVERED_SURFACES = [
  'app-name',
  'module-name',
  'form-name',
  'field-label',
  'field-hint',
  'validate-message',
  'choice-label',
  'lookup-rows',
  'options-source',
  'case-list-column',
  'connect-block',
  'display-condition',
  'post-submit',
  'preload',
] as const;
export type LintSurface = (typeof LINT_COVERED_SURFACES)[number];

export interface LintFinding {
  rule: LintRule;
  severity: LintSeverity;
  /** Human address: `form "X" › field a/b`, `module "Y" case list › Status`. */
  location: string;
  message: string;
}

export type RuleCheck =
  | { rule: LintRule; status: 'checked'; findings: number; note?: string }
  | { rule: LintRule; status: 'unable'; reason: string };

export type LintVerdict = 'pass' | 'warn' | 'fail' | 'incomplete';

export interface NovaAppLintResult {
  appId: string;
  appName: string;
  appType: AppType | null;
  verdict: LintVerdict;
  /** True iff the LLM evals may be dispatched: `pass` or `warn`. */
  gateOpen: boolean;
  blockers: number;
  warns: number;
  findings: LintFinding[];
  checks: RuleCheck[];
}

export interface LintOptions {
  /** The app type the caller built. Defaults to the blueprint's own `connect`. */
  appType?: AppType;
  /** Field ids or `#form/…` paths the brief consciously preloads from the case. */
  allowPreload?: readonly string[];
  /** Module names the build summary declares, for the undeclared-module half. */
  declaredModules?: readonly string[];
}

// ─── field walking ──────────────────────────────────────────────────────────

/* The bundle mirrors Nova's JSON; keep accessors loose and total. */
type Json = Record<string, any>;

interface FieldSite {
  formName: string;
  formId: string;
  moduleUuid: string;
  field: Json;
  /** `#form/a/b` — groups included, as Nova expressions address it. */
  path: string;
}

const NON_ANSWER_KINDS = new Set(['hidden', 'label', 'group', 'repeat']);
const SELECT_KINDS = new Set(['single_select', 'multi_select']);

function walkFields(fields: Json[] | undefined, prefix: string): Array<[Json, string]> {
  const acc: Array<[Json, string]> = [];
  for (const f of fields ?? []) {
    const path = `${prefix}/${f?.id}`;
    acc.push([f, path]);
    acc.push(...walkFields(f?.children, path));
  }
  return acc;
}

function fieldSites(bundle: NovaAppBundle): FieldSite[] {
  const out: FieldSite[] = [];
  for (const fr of bundle.forms) {
    const form = fr?.form ?? {};
    for (const [field, path] of walkFields(form.fields, '#form')) {
      out.push({ formName: form.name ?? form.id ?? '?', formId: form.id ?? '?', moduleUuid: fr?.moduleUuid, field, path });
    }
  }
  return out;
}

function where(site: FieldSite): string {
  return `form "${site.formName}" › ${site.path.replace(/^#form\//, '')}`;
}

/** `{{…}}` interpolations are references, not displayed words. */
function displayText(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\{\{[\s\S]*?\}\}/g, ' ') : '';
}

function cellValue(row: Json, columnId: string | undefined): string {
  if (!columnId) return '';
  const c = (row?.cells ?? []).find((x: Json) => x?.columnId === columnId);
  return typeof c?.value === 'string' ? c.value : '';
}

/** value → label for a select field, inline or lookup-backed. `null` when unreadable. */
function choiceMap(field: Json, tables: Record<string, BoundTable>): Record<string, string> | null {
  const src = field?.optionsSource;
  if (src?.kind === 'inline' || (!src && Array.isArray(field?.options))) {
    const opts: Json[] = src?.options ?? field.options ?? [];
    return Object.fromEntries(opts.map((o) => [String(o.value), String(o.label ?? '')]));
  }
  if (src?.kind === 'lookup') {
    const t = tables[src.tableId];
    if (!t || !t.complete) return null;
    return Object.fromEntries(t.rows.map((r) => [cellValue(r, src.valueColumnId), cellValue(r, src.labelColumnId)]));
  }
  return null;
}

// ─── rules ──────────────────────────────────────────────────────────────────

/**
 * `no-section-module-language` (`skills/_app-component-library.md`): the words
 * "section" and "module" must not appear in any user-facing Deliver string.
 * Deliver-only by the component's own scope — a Learn app's "module" is
 * Connect's own word for a unit of training.
 */
const BANNED_WORDS = /\b(sections?|modules?)\b/i;

function ruleTerminology(bundle: NovaAppBundle, sites: FieldSite[], findings: LintFinding[]): RuleCheck {
  let n = 0;
  const hit = (location: string, text: string, what: string) => {
    const m = BANNED_WORDS.exec(displayText(text));
    if (!m) return;
    n += 1;
    findings.push({
      rule: 'terminology',
      severity: 'blocker',
      location,
      message: `${what} uses the banned word "${m[1]}": "${text.slice(0, 120)}". Workers never see ` +
        `"section"/"module" in a Deliver app — use a plain task-oriented word.`,
    });
  };
  hit('app name', bundle.app?.name ?? '', 'app name');
  for (const m of bundle.app?.modules ?? []) {
    hit(`module "${m.name}"`, m.name ?? '', 'menu name');
    for (const f of m.forms ?? []) hit(`form "${f.name}"`, f.name ?? '', 'form name');
  }
  for (const mod of bundle.modules) {
    for (const col of mod?.case_list_config?.columns ?? []) {
      hit(`module "${mod.name}" case list › ${col.header}`, col.header ?? '', 'case-list header');
      for (const mp of col.mapping ?? []) hit(`module "${mod.name}" case list › ${col.header}`, mp.label ?? '', 'case-list label');
    }
  }
  const scannedTables = new Set<string>();
  for (const s of sites) {
    const f = s.field;
    if (f.kind !== 'hidden') {
      hit(where(s), f.label ?? '', 'label');
      hit(where(s), f.hint ?? '', 'hint');
      hit(where(s), f.help ?? '', 'help text');
    }
    hit(where(s), f.validate?.msg ?? '', 'validation message');
    const src = f.optionsSource;
    if (src?.kind === 'inline') for (const o of src.options ?? []) hit(where(s), o.label ?? '', `choice "${o.value}"`);
    if (src?.kind === 'lookup' && !scannedTables.has(`${src.tableId}:${src.labelColumnId}`)) {
      scannedTables.add(`${src.tableId}:${src.labelColumnId}`);
      const t = bundle.tables[src.tableId];
      for (const r of t?.rows ?? []) {
        hit(`lookup table "${t?.name ?? src.tableId}" (bound by ${where(s)})`, cellValue(r, src.labelColumnId), `row "${cellValue(r, src.valueColumnId)}" label`);
      }
    }
  }
  return { rule: 'terminology', status: 'checked', findings: n };
}

function ruleLookupBinds(bundle: NovaAppBundle, sites: FieldSite[], findings: LintFinding[]): RuleCheck {
  const bindSites: LookupBindSite[] = [];
  for (const s of sites) {
    const src = s.field.optionsSource;
    if (src?.kind !== 'lookup') continue;
    const t = bundle.tables[src.tableId];
    const req = { tableId: src.tableId, valueColumnId: src.valueColumnId, labelColumnId: src.labelColumnId };
    bindSites.push({
      field: `${s.formId}.${s.path.replace(/^#form\//, '')}`,
      requested: req,
      // The blueprint IS the saved read-back: `get_form` returns the persisted optionsSource.
      readBack: src,
      rows: t && !t.error ? { rows: t.rows, complete: t.complete } : null,
    });
  }
  const audit = auditLookupBinds(bindSites);
  for (const f of audit.failures) {
    findings.push({ rule: 'lookup-binds', severity: 'blocker', location: f.field, message: `[${f.code}] ${f.message}` });
  }
  return {
    rule: 'lookup-binds',
    status: 'checked',
    findings: audit.failures.length,
    note: `${bindSites.length} lookup-backed select(s) audited`,
  };
}

function ruleWipedRows(bundle: NovaAppBundle, findings: LintFinding[]): RuleCheck {
  let n = 0;
  const unreadable: string[] = [];
  for (const t of Object.values(bundle.tables)) {
    if (t.error || !t.complete) {
      unreadable.push(t.name ?? t.tableId);
      continue;
    }
    const cols = t.columns.map((c) => c.id);
    for (const r of findPartiallyBlankRows(t.rows, cols)) {
      n += 1;
      const names = r.blankColumns.map((id) => t.columns.find((c) => c.id === id)?.wireName ?? id);
      findings.push({
        rule: 'lookup-wiped-rows',
        severity: 'warn',
        location: `lookup table "${t.name ?? t.tableId}" row ${r.index + 1}`,
        message:
          `row is blank in ${names.join(', ')}, which every other row fills — the signature of an ` +
          'edit_lookup_rows `update` that sent only some cells (Nova replaces the row; ace#2978). ' +
          'Re-send the whole row.',
      });
    }
  }
  if (unreadable.length) return { rule: 'lookup-wiped-rows', status: 'unable', reason: `rows not fully read for ${unreadable.join(', ')}` };
  return { rule: 'lookup-wiped-rows', status: 'checked', findings: n };
}

/**
 * Case-list id-mapping labels vs the label the form offers for the same
 * stored value — `lib/choice-label-integrity.ts § checkCaseListEnumDrift`
 * through a blueprint adapter (the CCZ adapter is `lib/ccz-enum-fidelity.ts`).
 *
 * Pairing follows the chain Nova actually builds: a field (often a hidden
 * `_out` copy) declares `caseWrite {caseType, property}`; when its calculate
 * is a bare `#form/…` path to a select, that select's choices are the
 * authority; when it is an `if()` of literals, only the VALUE set is known.
 * `caseOperations[].writes` are read the same way.
 */
function ruleCaseListFidelity(bundle: NovaAppBundle, sites: FieldSite[], findings: LintFinding[]): RuleCheck {
  const byPath = new Map<string, FieldSite>();
  for (const s of sites) byPath.set(`${s.formId}:${s.path}`, s);

  // caseType.property → { labels from selects, literal values, opaque reasons }
  const writers = new Map<string, { choices: Record<string, string>; literals: Set<string>; opaque: string[]; forms: Set<string> }>();
  const get = (k: string) => {
    let w = writers.get(k);
    if (!w) writers.set(k, (w = { choices: {}, literals: new Set(), opaque: [], forms: new Set() }));
    return w;
  };
  const resolve = (formId: string, expr: string, key: string, formName: string, depth = 0): void => {
    const w = get(key);
    w.forms.add(formName);
    const e = (expr ?? '').trim().replace(/^\((.*)\)$/s, '$1').trim();
    if (/^#form\/[\w/-]+$/.test(e) && depth < 5) {
      const target = byPath.get(`${formId}:${e}`);
      if (!target) return void w.opaque.push(`${formName}: ${e} not found`);
      if (SELECT_KINDS.has(target.field.kind)) {
        const cm = choiceMap(target.field, bundle.tables);
        if (cm) Object.assign(w.choices, cm);
        else w.opaque.push(`${formName}: choices of ${e} unreadable`);
        return;
      }
      if (target.field.calculate) return resolve(formId, target.field.calculate, key, formName, depth + 1);
      return void w.opaque.push(`${formName}: ${e} is free text`);
    }
    const lit = enumerateCalculateLiterals(e);
    if ('values' in lit) lit.values.filter((v) => v !== '').forEach((v) => w.literals.add(v));
    else w.opaque.push(`${formName}: ${lit.reason}`);
  };

  for (const s of sites) {
    const cw = s.field.caseWrite;
    if (!cw?.property || !cw?.caseType) continue;
    const key = `${cw.caseType}.${cw.property}`;
    if (SELECT_KINDS.has(s.field.kind)) {
      const cm = choiceMap(s.field, bundle.tables);
      const w = get(key);
      w.forms.add(s.formName);
      if (cm) Object.assign(w.choices, cm);
    } else if (s.field.calculate) {
      resolve(s.formId, s.field.calculate, key, s.formName);
    }
  }
  for (const fr of bundle.forms) {
    const form = fr?.form ?? {};
    for (const op of form.caseOperations ?? []) {
      for (const wr of op.writes ?? []) {
        if (wr?.property && typeof wr.value === 'string') resolve(form.id, wr.value, `${op.caseType}.${wr.property}`, form.name);
      }
    }
  }

  let compared = 0;
  let n = 0;
  const unpaired: string[] = [];
  // The same property often renders in several modules' case lists; one drift
  // is one finding with every location, not N copies an operator skims past.
  const reported = new Map<string, LintFinding>();
  const report = (key: string, severity: LintSeverity, loc: string, message: string) => {
    const prior = reported.get(key);
    if (prior) {
      prior.location += `; ${loc}`;
      return;
    }
    const f: LintFinding = { rule: 'case-list-label-fidelity', severity, location: loc, message };
    reported.set(key, f);
    findings.push(f);
    n += 1;
  };
  for (const mod of bundle.modules) {
    const caseType = mod?.case_type;
    for (const col of mod?.case_list_config?.columns ?? []) {
      if (col.kind !== 'id-mapping' || !caseType) continue;
      const mapping: Record<string, string> = Object.fromEntries((col.mapping ?? []).map((m: Json) => [String(m.value), String(m.label ?? '')]));
      const w = writers.get(`${caseType}.${col.field}`);
      const loc = `module "${mod.name}" case list › ${col.header ?? col.field}`;
      if (!w || (Object.keys(w.choices).length === 0 && w.literals.size === 0)) {
        unpaired.push(`${caseType}.${col.field}`);
        continue;
      }
      compared += 1;
      if (Object.keys(w.choices).length > 0) {
        const outcome = checkCaseListEnumDrift({ property: col.field, caseListEnums: mapping, formChoices: w.choices });
        if (outcome.status === 'checked') {
          for (const f of outcome.findings) {
            // A value no enumerable writer stores is only provably stale when EVERY writer was enumerable.
            if (f.kind === 'missing-from-form' && (w.literals.has(f.value) || w.opaque.length > 0)) continue;
            report(`${caseType}.${col.field}|${f.value}|${f.caseListLabel}`, f.kind === 'label-mismatch' ? 'blocker' : 'warn', loc, f.remediation);
          }
        }
      } else {
        for (const v of Object.keys(mapping)) {
          if (w.literals.has(v) || w.opaque.length > 0) continue;
          report(
            `${caseType}.${col.field}|${v}|${mapping[v]}`,
            'warn',
            loc,
            `the case list labels "${v}" but no form writes that value to ${caseType}.${col.field} ` +
              `(writers store: ${[...w.literals].sort().join(', ')}) — a stale or invented enum entry.`,
          );
        }
      }
    }
  }
  return {
    rule: 'case-list-label-fidelity',
    status: 'checked',
    findings: n,
    note: `${compared} id-mapping column(s) compared${unpaired.length ? `; unpaired: ${unpaired.join(', ')}` : ''}`,
  };
}

function ruleMarkdownLabels(bundle: NovaAppBundle, sites: FieldSite[], findings: LintFinding[]): RuleCheck {
  const labels: ChoiceLabel[] = [];
  for (const s of sites) {
    if (!SELECT_KINDS.has(s.field.kind)) continue;
    const cm = choiceMap(s.field, bundle.tables);
    for (const [value, label] of Object.entries(cm ?? {})) labels.push({ value, label, location: where(s) });
  }
  if (labels.length === 0) return { rule: 'markdown-labels', status: 'checked', findings: 0, note: 'no choice labels in the app' };
  const outcome = checkMarkdownEatenLabels(labels);
  if (outcome.status === 'unable') return { rule: 'markdown-labels', status: 'unable', reason: outcome.reason };
  for (const f of outcome.findings) {
    findings.push({ rule: 'markdown-labels', severity: 'warn', location: f.location ?? '?', message: f.remediation });
  }
  return { rule: 'markdown-labels', status: 'checked', findings: outcome.findings.length };
}

/**
 * A visible question answered from the case before the worker arrives —
 * `lib/casedb-preload-audit.ts`'s rule (ace#2006), read from the blueprint's
 * own declaration (`answerWrites[].preloadedAnswers`, field uuids) instead of
 * the compiled CCZ, so it fires at build time rather than at Step 2.9.
 */
function ruleCasedbPrefill(bundle: NovaAppBundle, sites: FieldSite[], allow: readonly string[], findings: LintFinding[]): RuleCheck {
  const byUuid = new Map(sites.map((s) => [s.field.uuid, s]));
  const allowSet = new Set(allow);
  let n = 0;
  let declared = 0;
  for (const fr of bundle.forms) {
    for (const aw of fr?.answerWrites ?? []) {
      for (const uuid of aw?.preloadedAnswers ?? []) {
        declared += 1;
        const s = byUuid.get(uuid);
        if (!s || NON_ANSWER_KINDS.has(s.field.kind)) continue;
        if (allowSet.has(s.field.id) || allowSet.has(s.path)) continue;
        n += 1;
        findings.push({
          rule: 'casedb-prefill',
          severity: 'blocker',
          location: where(s),
          message: `visible ${s.field.kind} question is preloaded from the ${aw.caseType ?? ''} case — a returning ` +
            'worker meets the previous answer filled in and can re-file it by tapping Next (ace#2006). Carry ' +
            'context in a hidden field or the case list, or declare it in allowPreload if the brief wants it.',
        });
      }
    }
  }
  return { rule: 'casedb-prefill', status: 'checked', findings: n, note: `${declared} preloaded answer(s) declared` };
}

const USER_PROP = /user\(|#user\/|session\/user\/data/;

function ruleLearnDisplayGating(bundle: NovaAppBundle, findings: LintFinding[]): RuleCheck {
  const modCond = new Map<string, string | null>();
  for (const m of bundle.modules) modCond.set(m?.uuid, m?.display_condition ?? m?.displayCondition ?? null);
  let n = 0;
  let markers = 0;
  for (const fr of bundle.forms) {
    const form = fr?.form ?? {};
    if (!form.connect?.learn_module) continue;
    markers += 1;
    const gates = [modCond.get(fr.moduleUuid), form.displayCondition ?? form.display_condition].filter(
      (g): g is string => typeof g === 'string' && g.trim() !== '',
    );
    if (!gates.length) continue;
    const user = gates.some((g) => USER_PROP.test(g));
    n += 1;
    findings.push({
      rule: 'learn-display-gating',
      severity: user ? 'blocker' : 'warn',
      location: `form "${form.name}"`,
      message: user
        ? `learn_module form is display-gated on a user property (${gates.join(' / ')}). Connect counts EVERY ` +
          'learn_module toward completion, so no single role can reach 100% and Deliver never unlocks (ace#3036). ' +
          'Remove the gate; teach role differences inside the content.'
        : `learn_module form has a display condition (${gates.join(' / ')}); confirm every worker can reach it (ace#3036).`,
    });
  }
  return { rule: 'learn-display-gating', status: 'checked', findings: n, note: `${markers} learn_module form(s)` };
}

function ruleLearnNavigation(bundle: NovaAppBundle, findings: LintFinding[]): RuleCheck {
  let n = 0;
  for (const fr of bundle.forms) {
    const form = fr?.form ?? {};
    const post = form.postSubmit ?? fr?.navigation?.afterSubmit?.fallback?.screen ?? null;
    // `postSubmit: "previous"` is the authored setting; the derived navigation
    // block has no "previous" spelling, so only the authored field is binding.
    if (form.postSubmit === undefined) continue;
    if (post !== 'previous') {
      n += 1;
      findings.push({
        rule: 'learn-form-navigation',
        severity: 'blocker',
        location: `form "${form.name}"`,
        message: `post-submit navigation is "${post}", not "previous" — the standing Learn instruction (form_navigation).`,
      });
    }
  }
  return { rule: 'learn-form-navigation', status: 'checked', findings: n };
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined;
}

function ruleConnectMarkers(bundle: NovaAppBundle, appType: AppType, findings: LintFinding[]): RuleCheck {
  let n = 0;
  const push = (severity: LintSeverity, location: string, message: string) => {
    n += 1;
    findings.push({ rule: 'connect-markers', severity, location, message });
  };
  const forms = bundle.forms.map((fr) => fr?.form ?? {});
  if (appType === 'learn') {
    const lm = forms.filter((f) => f.connect?.learn_module);
    const as = forms.filter((f) => f.connect?.assessment);
    if (lm.length === 0) push('blocker', 'app', 'no form carries connect.learn_module — Connect would see zero Learn modules.');
    for (const f of lm) {
      const b = f.connect.learn_module;
      if (!nonEmpty(b.name) || !nonEmpty(b.time_estimate ?? b.timeEstimate)) {
        push('blocker', `form "${f.name}"`, 'connect.learn_module is missing its name or time_estimate.');
      }
    }
    if (as.length !== 1) {
      push('blocker', 'app', `${as.length} forms carry connect.assessment (${as.map((f) => f.name).join(', ') || 'none'}); ` +
        'exactly one — the gating post-test — may (ace#1131/#1205: any-passed semantics make a pre-test a Deliver-unlock gate).');
    }
    for (const f of as) {
      if (!nonEmpty(f.connect.assessment.user_score)) push('blocker', `form "${f.name}"`, 'connect.assessment has no user_score expression.');
    }
  } else {
    const du = forms.filter((f) => f.connect?.deliver_unit);
    if (du.length === 0) push('blocker', 'app', 'no form carries connect.deliver_unit — Connect sync would yield zero deliver units.');
    const ids = new Map<string, string[]>();
    for (const f of du) {
      const b = f.connect.deliver_unit;
      ids.set(b.id ?? '', [...(ids.get(b.id ?? '') ?? []), f.name]);
      if (!nonEmpty(b.entity_id) || !nonEmpty(b.entity_name)) {
        push('blocker', `form "${f.name}"`, 'connect.deliver_unit has an empty entity_id or entity_name expression — CCHQ refuses the build.');
      }
    }
    for (const [id, names] of ids) {
      if (names.length > 1) push('blocker', 'app', `deliver unit id "${id}" is declared by ${names.length} forms (${names.join(', ')}).`);
    }
  }
  return { rule: 'connect-markers', status: 'checked', findings: n, note: 'structural floor only; role-aware coverage is app-connect-coverage' };
}

function ruleStarterModule(bundle: NovaAppBundle, declared: readonly string[] | undefined, findings: LintFinding[]): RuleCheck {
  const formsByModule = new Map<string, Json[]>();
  for (const fr of bundle.forms) formsByModule.set(fr.moduleUuid, [...(formsByModule.get(fr.moduleUuid) ?? []), fr.form ?? {}]);
  const released = (bundle.app?.modules ?? []).map((m: Json) => ({
    name: m.name,
    forms: (formsByModule.get(m.uuid) ?? []).map((f) => ({
      name: f.name,
      fields: walkFields(f.fields, '#form').map(([x]) => ({ name: x.id, label: x.label, type: x.kind })),
    })),
  }));
  const outcome = auditReleasedModules({ released, declared: declared ? [...declared] : undefined });
  if (outcome.status === 'unable') return { rule: 'starter-module', status: 'unable', reason: outcome.reason };
  for (const f of outcome.findings) {
    findings.push({ rule: 'starter-module', severity: f.tier === 'blocker' ? 'blocker' : 'warn', location: `module "${f.module}"`, message: f.reason });
  }
  return { rule: 'starter-module', status: 'checked', findings: outcome.findings.length };
}

// ─── entry point ────────────────────────────────────────────────────────────

/** Pure. Lint a bundle read by `fetchNovaAppBundle`. */
export function lintNovaApp(bundle: NovaAppBundle, opts: LintOptions = {}): NovaAppLintResult {
  const findings: LintFinding[] = [];
  const checks: RuleCheck[] = [];
  const blueprintType: AppType | null =
    bundle.app?.connect === 'learn' || bundle.app?.connect === 'deliver' ? bundle.app.connect : null;
  const appType: AppType | null = opts.appType ?? blueprintType;
  const appName: string = bundle.app?.name ?? '';

  checks.push(
    bundle.readErrors.length
      ? { rule: 'read', status: 'unable', reason: bundle.readErrors.join('; ') }
      : { rule: 'read', status: 'checked', findings: 0, note: `${bundle.forms.length} form(s), ${Object.keys(bundle.tables).length} bound table(s)` },
  );

  if (!appType) {
    checks.push({ rule: 'app-name', status: 'unable', reason: 'app type unknown: the blueprint declares no connect type and none was passed (--type)' });
  } else {
    const want = appType === 'learn' ? 'Learn app' : 'Deliver app';
    const ok = appName.toLowerCase().includes(want.toLowerCase());
    if (!ok) findings.push({ rule: 'app-name', severity: 'blocker', location: 'app name', message: `app name "${appName}" must contain "${want}" (naming_convention).` });
    checks.push({ rule: 'app-name', status: 'checked', findings: ok ? 0 : 1 });
  }

  if (appType) {
    const ok = blueprintType === appType;
    if (!ok) {
      findings.push({
        rule: 'connect-type',
        severity: 'blocker',
        location: 'app',
        message: `blueprint connect type is "${bundle.app?.connect ?? 'absent'}", expected "${appType}" — Connect would not read this app's markers.`,
      });
    }
    checks.push({ rule: 'connect-type', status: 'checked', findings: ok ? 0 : 1 });
  } else {
    checks.push({ rule: 'connect-type', status: 'unable', reason: 'app type unknown' });
  }

  const sites = fieldSites(bundle);

  checks.push(
    appType === 'deliver'
      ? ruleTerminology(bundle, sites, findings)
      : { rule: 'terminology', status: 'checked', findings: 0, note: 'Deliver-only rule (no-section-module-language); skipped for Learn' },
  );
  checks.push(ruleLookupBinds(bundle, sites, findings));
  checks.push(ruleWipedRows(bundle, findings));
  checks.push(ruleCaseListFidelity(bundle, sites, findings));
  checks.push(ruleMarkdownLabels(bundle, sites, findings));
  checks.push(ruleCasedbPrefill(bundle, sites, opts.allowPreload ?? [], findings));
  if (appType === 'learn') {
    checks.push(ruleLearnDisplayGating(bundle, findings));
    checks.push(ruleLearnNavigation(bundle, findings));
  } else {
    checks.push({ rule: 'learn-display-gating', status: 'checked', findings: 0, note: 'Learn-only' });
    checks.push({ rule: 'learn-form-navigation', status: 'checked', findings: 0, note: 'Learn-only' });
  }
  checks.push(appType ? ruleConnectMarkers(bundle, appType, findings) : { rule: 'connect-markers', status: 'unable', reason: 'app type unknown' });
  checks.push(ruleStarterModule(bundle, opts.declaredModules, findings));

  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  const warns = findings.length - blockers;
  const anyUnable = checks.some((c) => c.status === 'unable');
  const verdict: LintVerdict = blockers > 0 ? 'fail' : anyUnable ? 'incomplete' : warns > 0 ? 'warn' : 'pass';
  return {
    appId: bundle.appId,
    appName,
    appType,
    verdict,
    gateOpen: verdict === 'pass' || verdict === 'warn',
    blockers,
    warns,
    findings,
    checks,
  };
}

/**
 * Should a repair round run at all? Only on a blocker (lint or eval). A `warn`
 * is reported and carried, never repaired-for: the kaduna Learn repair round
 * on a warn moved 8.09 → 8.22 for a full rebuild-and-regrade cycle.
 */
export function repairWarranted(input: { lintVerdict: LintVerdict; evalVerdict?: 'pass' | 'warn' | 'fail' | null }): boolean {
  return input.lintVerdict === 'fail' || input.lintVerdict === 'incomplete' || input.evalVerdict === 'fail';
}

/**
 * After a repair round: re-lint only, or re-run the LLM eval too?
 *
 * Re-lint suffices when every surface the repair touched is one this lint
 * fully re-verifies AND the eval's blockers were all lint-rule blockers. Any
 * other surface (a new field, a reworded teaching passage, logic) changes what
 * the eval judges, so the eval re-runs.
 */
export function evalRerunNeeded(input: { touchedSurfaces: readonly string[]; evalBlockersOutsideLint?: number }): boolean {
  if ((input.evalBlockersOutsideLint ?? 0) > 0) return true;
  if (input.touchedSurfaces.length === 0) return false;
  const covered = new Set<string>(LINT_COVERED_SURFACES);
  return input.touchedSurfaces.some((s) => !covered.has(s));
}

/** Human-readable report: blockers first, then warns, then the rule table. */
export function formatNovaAppLint(r: NovaAppLintResult): string {
  const lines: string[] = [];
  lines.push(`nova-app-lint ${r.appType ?? '?'} "${r.appName}" (${r.appId}): ${r.verdict.toUpperCase()} — ${r.blockers} blocker(s), ${r.warns} warn(s); gate ${r.gateOpen ? 'OPEN' : 'CLOSED'}`);
  for (const sev of ['blocker', 'warn'] as const) {
    for (const f of r.findings.filter((x) => x.severity === sev)) {
      lines.push(`  [${sev.toUpperCase()}] ${f.rule} @ ${f.location}: ${f.message}`);
    }
  }
  lines.push('  rules:');
  for (const c of r.checks) {
    lines.push(
      c.status === 'checked'
        ? `    ${c.rule}: checked, ${c.findings} finding(s)${c.note ? ` — ${c.note}` : ''}`
        : `    ${c.rule}: UNABLE TO CHECK — ${c.reason} (NOT a pass)`,
    );
  }
  return lines.join('\n');
}
