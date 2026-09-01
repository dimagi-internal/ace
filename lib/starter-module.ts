/**
 * Nova's canonical STARTER MODULE, and the identity check that can see it
 * (dimagi-internal/ace#1787).
 *
 * ## The defect
 *
 * `create_app` seeds every new Nova app with a placeholder module — a
 * top-level menu "Survey" holding one form "Survey" holding one text field
 * `question_1` labelled "Question 1". Nothing in ACE told the architect to
 * remove it, so removal depended on whether the architect happened to notice.
 * On `bednet-check-2-visit/20260828-0629` the Deliver app shipped carrying it
 * while the Learn app, briefed from the same template in the same phase, did
 * not.
 *
 * On a Deliver app this is worse than cosmetic: an FLW tapping that menu lands
 * in a dead form that writes nothing and is not a payable unit.
 *
 * ## Why the existing gate could not catch it
 *
 * `app-release-qa` Step 4 compares released-CCZ form COUNT against Nova
 * blueprint form COUNT. The starter module is present in BOTH sides of that
 * comparison, so the totals agree and the check passes on a dirty app — by
 * construction, not by bad luck. **Form-count equality is structurally blind to
 * an extra module: an extra module that is equal on both sides is exactly the
 * case a count can never distinguish.** The Connect-marker checks are keyed on
 * forms that DECLARE `connect.*` blocks and the starter form declares none, so
 * it is invisible there too.
 *
 * The only check that can see it is a NAME/IDENTITY comparison. That is what
 * this module is.
 *
 * ## Why the signature is the field, not the name
 *
 * The obvious check is "no module named Survey". It is the wrong one: an
 * architect that renames the seeded module without emptying it defeats it, and
 * a PDD that legitimately specifies a module called "Survey" false-fails it.
 *
 * The durable signature is the seeded FIELD. `question_1` / "Question 1" is a
 * Nova placeholder; no PDD-derived brief produces a field named for its own
 * ordinal. So the BLOCKER tier keys on the placeholder field and ignores names
 * entirely, and the name-only match is reported as a non-blocking `suspect`
 * for a human to look at.
 *
 * Pure and dependency-free so it can be unit-tested and called from a skill via
 * `npx tsx`, in the shape `lib/app-release-drift.ts` established.
 */

import { checked, unable, type CheckOutcome } from './check-outcome.js';

export interface StarterModuleField {
  name?: string;
  label?: string;
  type?: string;
}

export interface StarterModuleForm {
  name?: string;
  fields?: StarterModuleField[];
  /** True when the form's blueprint declares any `connect.*` block. */
  declaresConnectMarker?: boolean;
}

export interface StarterModuleCandidate {
  name?: string;
  forms?: StarterModuleForm[];
}

export type ModuleFindingTier =
  /** Halts the phase: the seeded placeholder field survived, or the brief never asked for it. */
  | 'blocker'
  /** Reported, does not halt: named like the seed but the content drifted. */
  | 'suspect';

export interface ModuleFinding {
  kind: 'starter-module' | 'undeclared-module';
  tier: ModuleFindingTier;
  module: string;
  form?: string;
  reason: string;
}

export interface ModuleAuditExtra {
  /** Whether a declared-module list was supplied at all. */
  declared_structure: 'compared' | 'unavailable';
  notes: string[];
}

/**
 * `CheckOutcome`, not a bespoke verdict object (the rail in
 * `test/skills/negative-control-ratchet.test.ts`, argued at length in
 * `lib/check-outcome.ts`). The distinction it enforces is exactly the one this
 * check needs: "I inspected the modules and they are clean" must not be
 * confusable with "I never got a module list", which is precisely how the
 * ace#1787 class survives a gate.
 */
export type ReleasedModuleAudit = CheckOutcome<ModuleFinding, ModuleAuditExtra>;

/** Normalise a name for comparison: trim, collapse whitespace, casefold. */
function norm(s: string | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Is this the field Nova seeds?
 *
 * Matches the seeded NAME (`question_1`, `question1`) or the seeded LABEL
 * ("Question 1"). Either alone is enough — an architect that relabels the
 * placeholder without deleting it has still shipped the placeholder.
 */
export function isPlaceholderField(field: StarterModuleField): boolean {
  return /^question_?1$/i.test((field.name ?? '').trim()) ||
    /^question\s*1$/i.test((field.label ?? '').trim());
}

/**
 * A module is the canonical starter when it holds exactly one form holding
 * exactly one field, and that field is Nova's placeholder.
 *
 * Deliberately name-agnostic — see the header. The cardinality conditions are
 * what keep it from firing on a real module that happens to contain a field
 * called `question_1` among others.
 */
export function isCanonicalStarterModule(module: StarterModuleCandidate): boolean {
  const forms = module.forms ?? [];
  if (forms.length !== 1) return false;
  const fields = forms[0].fields ?? [];
  if (fields.length !== 1) return false;
  return isPlaceholderField(fields[0]);
}

/**
 * Audit the modules of a released app against the structure the brief declared.
 *
 * An EMPTY `released` list is `unable`, never a pass: a released CommCare app
 * has modules, so an empty list means the module list could not be built — and
 * "found no starter module" read off a check that inspected nothing is the
 * blind-gate class this repo has paid for four times (ace#1332 → #1634).
 *
 * `declared` is the list of module names the build summary says the app should
 * contain. When it is absent or empty the undeclared-module half is SKIPPED
 * rather than firing on everything — a missing input must not manufacture a
 * BLOCKER, and the signature check stands on its own. That is recorded in
 * `declared_structure` so a clean result cannot hide a comparison that never
 * ran.
 */
export function auditReleasedModules(args: {
  released: StarterModuleCandidate[];
  declared?: string[];
}): ReleasedModuleAudit {
  if (args.released.length === 0) {
    return unable(
      'No released modules were supplied, so nothing was inspected. A released CommCare ' +
        'app always has modules — an empty list means the module list could not be built ' +
        'from suite.xml / the Nova blueprint, which is a bug in the caller, not a clean app.',
    );
  }

  const findings: ModuleFinding[] = [];
  const notes: string[] = [];

  for (const module of args.released) {
    const moduleName = module.name ?? '(unnamed module)';
    const forms = module.forms ?? [];

    if (isCanonicalStarterModule(module)) {
      const form = forms[0];
      const field = (form.fields ?? [])[0];
      findings.push({
        kind: 'starter-module',
        tier: 'blocker',
        module: moduleName,
        form: form.name ?? '(unnamed form)',
        reason:
          `Nova's canonical starter module survived to release: one form, one field ` +
          `(${field.name ?? field.label ?? 'unnamed'}). No brief-specified module has ` +
          `this shape. Remove it in Nova and re-release.`,
      });
      continue;
    }

    // Named like the seed, but the content drifted — could be a real module a
    // PDD called "Survey", could be a half-edited seed. A human looks; the
    // phase does not halt.
    if (norm(moduleName) === 'survey' && forms.length === 1 && norm(forms[0].name) === 'survey') {
      findings.push({
        kind: 'starter-module',
        tier: 'suspect',
        module: moduleName,
        form: forms[0].name ?? '(unnamed form)',
        reason:
          `Module "Survey" holding a single form "Survey" — Nova's seeded naming, but ` +
          `the placeholder field is gone. Either a real PDD-specified survey module or a ` +
          `half-edited starter. Confirm against the brief.`,
      });
    }
  }

  const declared = (args.declared ?? []).map(norm).filter((s) => s.length > 0);
  if (declared.length === 0) {
    notes.push(
      'No declared module list was supplied, so released modules were not compared ' +
        'against the brief. The starter-module signature check still ran.',
    );
  } else {
    // A module already reported as the starter seed is not ALSO reported as
    // undeclared. Both are true, but they are one defect with one remedy, and
    // an operator reading two findings per module starts skimming.
    const alreadyFlagged = new Set(
      findings.filter((f) => f.tier === 'blocker').map((f) => norm(f.module)),
    );
    for (const module of args.released) {
      const moduleName = module.name ?? '(unnamed module)';
      if (alreadyFlagged.has(norm(moduleName))) continue;
      if (!declared.includes(norm(moduleName))) {
        findings.push({
          kind: 'undeclared-module',
          tier: 'blocker',
          module: moduleName,
          reason:
            `Released app carries a module the build summary never declared. Declared: ` +
            `${args.declared!.join(', ')}.`,
        });
      }
    }
  }

  return {
    ...checked<ModuleFinding>(findings.length === 0, findings),
    declared_structure: declared.length === 0 ? 'unavailable' : 'compared',
    notes,
  };
}
