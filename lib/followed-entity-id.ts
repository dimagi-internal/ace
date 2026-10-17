/**
 * Does every paid Deliver form record the id of the entity it serves? (ace#2889)
 *
 * The second finding of ace#2883. On smallholder-seasonal/20261012-1549
 * (released Deliver app HQ 6137de98 v23) the paid "Harvest visit" form
 * (`modules-12/forms-0.xml`) carries two case operations — `update_crop_cycle`
 * on the harvest-cycle case, and `create_noncrop_cycle`, whose `index/parent`
 * exists only for non-crop cycles. A crop-cycle harvest visit therefore
 * records nothing that names the WOMAN the programme follows, and no reporting
 * layer can attach the visit to her. `semantic-registry-author-qa`'s
 * `entity-key` check (lib/layer1-path-check.ts) sees this at Phase 7; the build
 * shipped it.
 *
 * A form-local static check cannot tell a case id that names the woman from
 * one that names her crop cycle — both are `@case_id`. So the contract is
 * DECLARED, not inferred (operator decision 2026-10-16):
 *
 *  1. The PDD declares the followed entity's case type in § Program Parameters
 *     (`| followed_entity_case_type | participant |`).
 *  2. `pdd-to-deliver-app` records that entity's id in a hidden field at the
 *     form root of EVERY paid form, named `<case_type>_case_id`
 *     (`followedEntityIdField`) — the session case's own id on a form that
 *     runs on the followed case, the parent's id on a child-case form.
 *  3. `app-release-qa § Step 4.9` runs `checkFollowedEntityId` over the
 *     released CCZ: every form carrying a Connect `<deliver>` block must carry
 *     that field, with a value DERIVED from the case/session (a `calculate`
 *     or `setvalue` reading casedb, the session, or a case block's
 *     `@case_id`) — never a worker-entered field or a literal.
 *
 * One fixed field name per app also gives the semantic registry a key path
 * every paid form writes (`form.<case_type>_case_id`).
 *
 * Pure: no I/O. Callers pass the unzipped CCZ's `modules-N/forms-M.xml` texts.
 */
import {
  formSubmissionPaths,
  formTitle,
  gatingCondition,
  isDeliverForm,
  type ReleasedForm,
} from './layer1-path-check';

/** A CommCare case type identifier, as ACE builds them. */
const CASE_TYPE = /^[a-z][a-z0-9_-]*$/;

export interface ParsedFollowedEntity {
  /** False when the row is absent, unfilled, or malformed. */
  declared: boolean;
  /** The followed entity's case type, verbatim. Null when declared `none`. */
  caseType: string | null;
  /**
   * An explicit `none (<reason>)` — a design with no followed entity. Only a
   * `multi-stage` PDD may say this (a `longitudinal-visits` design follows an
   * entity by definition); the QA check enforces that.
   */
  none: boolean;
  reason: string | null;
  problems: string[];
}

const ABSENT = new Set(['', 'n/a', 'na', 'tbd', 'unknown', '-', '—']);

/**
 * Parse `program_parameters.followed_entity_case_type`.
 *
 * Grammar: `<case_type>` (e.g. `participant`), optionally followed by prose in
 * parentheses; or `none (<reason>)`.
 */
export function parseFollowedEntityCaseType(raw: string | null | undefined): ParsedFollowedEntity {
  const text = (raw ?? '').trim();
  const problems: string[] = [];
  if (ABSENT.has(text.toLowerCase()) || /^\[.*\]$/.test(text)) {
    return { declared: false, caseType: null, none: false, reason: null, problems };
  }
  const none = /^none\b\s*(?:\((.*)\)|[:—–-]\s*(.*))?$/i.exec(text);
  if (none) {
    const reason = (none[1] ?? none[2] ?? '').trim();
    if (!reason) {
      problems.push('`none` must say why the design follows no entity: `none (<reason>)`');
      return { declared: false, caseType: null, none: true, reason: null, problems };
    }
    return { declared: true, caseType: null, none: true, reason, problems };
  }
  const head = text.replace(/`/g, '').split(/[\s(]/)[0];
  if (!CASE_TYPE.test(head)) {
    problems.push(
      `"${text}" does not start with a case type identifier (lower-case letters, digits, _ or -)`,
    );
    return { declared: false, caseType: null, none: false, reason: null, problems };
  }
  return { declared: true, caseType: head, none: false, reason: null, problems };
}

/** The hidden form-root field every paid form records the followed entity's id in. */
export function followedEntityIdField(caseType: string): string {
  return `${caseType.replace(/-/g, '_')}_case_id`;
}

export interface FollowedEntityFinding {
  severity: 'fail' | 'warn';
  form: string;
  detail: string;
}

export interface FollowedEntityReport {
  ok: boolean;
  field: string;
  /** The paid forms checked (those carrying a Connect `<deliver>` block). */
  paidForms: string[];
  findings: FollowedEntityFinding[];
  exempted: string[];
}

export interface FollowedEntityCheckInput {
  caseType: string;
  forms: readonly ReleasedForm[];
  /** In-zip form path → why this paid form legitimately serves no followed entity. */
  exempt?: Readonly<Record<string, string>>;
}

const decode = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The expression that gives `/data/<field>` its value: a bind `calculate` or a `setvalue`. */
function valueSource(xml: string, ref: string): string | null {
  for (const m of xml.matchAll(/<bind\b[^>]*>/g)) {
    const ns = /\snodeset\s*=\s*"([^"]+)"/.exec(m[0]);
    if (ns?.[1].trim() !== ref) continue;
    const calc = /\scalculate\s*=\s*"([^"]+)"/.exec(m[0]);
    if (calc) return decode(calc[1]);
  }
  for (const m of xml.matchAll(/<(?:[\w-]+:)?setvalue\b[^>]*>/g)) {
    const r = /\sref\s*=\s*"([^"]+)"/.exec(m[0]);
    if (r?.[1].trim() !== ref) continue;
    const val = /\svalue\s*=\s*"([^"]+)"/.exec(m[0]);
    if (val) return decode(val[1]);
  }
  return null;
}

/** Derived from the case model: reads casedb, the session, or a case block's id. */
function isCaseDerived(expr: string): boolean {
  return (
    /instance\(\s*'(?:casedb|commcaresession)'\s*\)/.test(expr) ||
    /\/data\/[^\s'"]*\/case\/@case_id/.test(expr)
  );
}

export function checkFollowedEntityId(input: FollowedEntityCheckInput): FollowedEntityReport {
  const field = followedEntityIdField(input.caseType);
  const ref = `/data/${field}`;
  const formPath = `form.${field}`;
  const findings: FollowedEntityFinding[] = [];
  const paidForms: string[] = [];
  const exempted: string[] = [];

  for (const f of input.forms) {
    if (!isDeliverForm(f.xml)) continue;
    paidForms.push(f.path);
    if (input.exempt?.[f.path]) {
      exempted.push(f.path);
      continue;
    }
    const label = `${formTitle(f.xml) ?? 'form'} (${f.path})`;
    const { paths, relevant } = formSubmissionPaths(f.xml);
    if (!paths.has(formPath)) {
      const caseIds = [...paths].filter(
        (p) => /\.case\.@case_id$/.test(p) || /\.case\.index\.[^.]+$/.test(p),
      );
      findings.push({
        severity: 'fail',
        form: f.path,
        detail:
          `${label} is a paid form but records no \`${field}\` — nothing in its submission names the ` +
          `followed \`${input.caseType}\` it serves, so no reporting layer can attach the visit to it. ` +
          (caseIds.length
            ? `Case paths it does write: ${caseIds.map((p) => `\`${p}\``).join(', ')} — none is declared to be the followed entity. `
            : 'It writes no case id at all. ') +
          `Add a hidden \`${field}\` at the form root whose calculate reads the followed case's id ` +
          '(the session case on a form that runs on it; its parent via casedb `index/parent` on a child-case form).',
      });
      continue;
    }
    const src = valueSource(f.xml, ref);
    if (src === null || !isCaseDerived(src)) {
      findings.push({
        severity: 'fail',
        form: f.path,
        detail:
          `${label} carries \`${field}\` but its value is ${src === null ? 'not computed (a worker-entered or empty field)' : `\`${src}\`, which reads neither casedb, the session, nor a case block`} — ` +
          'the followed entity id must be DERIVED from the case model, never typed or hard-coded.',
      });
      continue;
    }
    const gate = gatingCondition(formPath, relevant);
    if (gate) {
      findings.push({
        severity: 'warn',
        form: f.path,
        detail:
          `${label} writes \`${field}\` only when \`${gate.node}\` is relevant (\`${gate.relevant}\`) — ` +
          'visits where it is not record no followed entity.',
      });
    }
  }

  return {
    ok: !findings.some((x) => x.severity === 'fail'),
    field,
    paidForms,
    findings,
    exempted,
  };
}
