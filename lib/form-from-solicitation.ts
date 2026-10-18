/**
 * Mirror a labs solicitation into a Google Form, and map the form's responses
 * back into `create_response` payloads. Pure; no I/O.
 *
 * Used by `skills/solicitation-google-form` and its `-qa` partner (spec
 * `docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md` § E). The
 * `google_form` optional step is OFF by default; a form exists only on a run
 * that asked for one.
 *
 * Three things here must not be judgment:
 *
 *   - **The join key.** Every answerable item carries its solicitation question
 *     id in its description as a trailing `[ref: <id>]` line. The id is what
 *     labs keys responses on (`create_response.responses`), and Forms gives each
 *     item its own `question_id`, so the two are joined by the
 *     `question_map` this module builds from the create result and the spec.
 *   - **What the public sees.** The form is public (anyone with the link may
 *     respond), so every piece of respondent-facing text is checked against the
 *     opp's deny list (parties that must never appear in LLO-facing text) with
 *     the SAME matcher `solicitation-seed-responses` uses
 *     (`findDenyListHits`, lib/synthetic-responses.ts). A private call always
 *     carries the demonstration banner at the top of the form.
 *   - **Import is once per form response.** The form response id is the
 *     idempotency key; a response already in the record's `imported` list is
 *     skipped, never re-created.
 */

import { findDenyListHits } from './synthetic-responses.js';

/** The banner every form for a private (demonstration) call starts with. */
export const DEMONSTRATION_BANNER =
  '[Demonstration — not a live call.] Created by ACE to exercise the Labs workflow; responses are synthetic.';

/** Solicitation question ids reserved for the respondent's identity items. */
export const IDENTITY_REFS = {
  org_name: '__org_name',
  contact_name: '__contact_name',
  contact_email: '__contact_email',
} as const;

const RESERVED_PREFIX = '__';
const REF_LINE = /\[ref: ([^\]\s]+)\]\s*$/;
const ID_SHAPE = /^[^\]\s]+$/;

/** Form item kinds this module emits (a subset of the `forms_create_from_spec` kinds). */
export type MirroredItemKind = 'short_answer' | 'paragraph' | 'radio';

/** One item, in `forms_create_from_spec`'s `items[]` shape. */
export interface FormItem {
  title: string;
  description?: string;
  kind: MirroredItemKind;
  required?: boolean;
  options?: string[];
}

/** A labs solicitation question (`create_solicitation.questions[]`). */
export interface SolicitationFormQuestion {
  id: string;
  text: string;
  type: 'text' | 'textarea' | 'number' | 'multiple_choice' | string;
  required?: boolean;
  options?: string[];
  framing?: string;
}

export interface FormSpecInput {
  solicitation: {
    id: number;
    title: string;
    description?: string;
    application_deadline?: string;
    questions: SolicitationFormQuestion[];
  };
  /** `private` adds the demonstration banner. */
  visibility: 'public' | 'private';
  /** Parties that must never appear in LLO-facing text (per-opp data). */
  deny_list: string[];
}

export interface FormSpec {
  /** Drive file name. */
  name: string;
  title: string;
  description: string;
  items: FormItem[];
}

export interface FormSpecError {
  code:
    | 'EMPTY_QUESTIONS'
    | 'RESERVED_ID'
    | 'DUPLICATE_ID'
    | 'BAD_ID'
    | 'BAD_TYPE'
    | 'NO_OPTIONS'
    | 'DENY_LIST_HIT';
  where: string;
  message: string;
}

export class FormSpecValidationError extends Error {
  constructor(public readonly errors: FormSpecError[]) {
    super(`form spec refused: ${errors.map((e) => `${e.code}(${e.where}): ${e.message}`).join('; ')}`);
    this.name = 'FormSpecValidationError';
  }
}

/** The trailing ref line an item description carries. */
export function refLine(id: string): string {
  return `[ref: ${id}]`;
}

/** The solicitation question id an item description carries, or null. */
export function parseQuestionRef(description: string | undefined | null): string | null {
  if (!description) return null;
  const m = description.match(REF_LINE);
  return m ? m[1] : null;
}

/** Strip the markdown a Forms description would show literally. Light by design. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function withRef(text: string | undefined, id: string): string {
  return text && text.trim() ? `${text.trim()}\n\n${refLine(id)}` : refLine(id);
}

function identityItems(): FormItem[] {
  return [
    {
      title: 'Organisation name',
      description: withRef('The organisation applying. Write "Individual" if you are applying on your own.', IDENTITY_REFS.org_name),
      kind: 'short_answer',
      required: true,
    },
    {
      title: 'Your name',
      description: withRef('The person we should contact about this application.', IDENTITY_REFS.contact_name),
      kind: 'short_answer',
      required: true,
    },
    {
      title: 'Your email',
      description: withRef(undefined, IDENTITY_REFS.contact_email),
      kind: 'short_answer',
      required: true,
    },
  ];
}

function itemForQuestion(q: SolicitationFormQuestion, where: string, errors: FormSpecError[]): FormItem | null {
  const base = { title: q.text, required: !!q.required };
  switch (q.type) {
    case 'text':
      return { ...base, kind: 'short_answer', description: withRef(q.framing, q.id) };
    case 'textarea':
      return { ...base, kind: 'paragraph', description: withRef(q.framing, q.id) };
    case 'number': {
      const hint = [q.framing?.trim(), 'Enter a number.'].filter(Boolean).join(' ');
      return { ...base, kind: 'short_answer', description: withRef(hint, q.id) };
    }
    case 'multiple_choice': {
      const options = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (options.length === 0) {
        errors.push({ code: 'NO_OPTIONS', where, message: 'multiple_choice question has no options' });
        return null;
      }
      return { ...base, kind: 'radio', options, description: withRef(q.framing, q.id) };
    }
    default:
      errors.push({ code: 'BAD_TYPE', where, message: `unknown question type "${q.type}"` });
      return null;
  }
}

/**
 * Build the `forms_create_from_spec` arguments for a solicitation. Throws a
 * FormSpecValidationError listing every problem; never returns a partial spec.
 */
export function buildFormSpec(input: FormSpecInput): FormSpec {
  const errors: FormSpecError[] = [];
  const { solicitation } = input;
  if (!solicitation.questions || solicitation.questions.length === 0) {
    errors.push({ code: 'EMPTY_QUESTIONS', where: 'questions', message: 'the solicitation has no questions to mirror' });
  }

  const seen = new Set<string>();
  const questionItems: FormItem[] = [];
  (solicitation.questions ?? []).forEach((q, i) => {
    const where = `questions[${i}] (${q.id})`;
    if (!q.id || !ID_SHAPE.test(q.id)) {
      errors.push({ code: 'BAD_ID', where, message: 'question id must be non-empty with no spaces or "]"' });
      return;
    }
    if (q.id.startsWith(RESERVED_PREFIX)) {
      errors.push({ code: 'RESERVED_ID', where, message: `ids starting "${RESERVED_PREFIX}" are reserved for identity items` });
      return;
    }
    if (seen.has(q.id)) {
      errors.push({ code: 'DUPLICATE_ID', where, message: 'question id repeats' });
      return;
    }
    seen.add(q.id);
    const item = itemForQuestion(q, where, errors);
    if (item) questionItems.push(item);
  });

  const parts: string[] = [];
  if (input.visibility === 'private') parts.push(DEMONSTRATION_BANNER);
  if (solicitation.description) {
    const body = plainText(solicitation.description);
    // solicitation-create already puts the banner in a private call's description.
    const withoutBanner = body.startsWith(DEMONSTRATION_BANNER) ? body.slice(DEMONSTRATION_BANNER.length).trim() : body;
    if (withoutBanner) parts.push(withoutBanner);
  }
  if (solicitation.application_deadline) parts.push(`Applications close ${solicitation.application_deadline}.`);
  const spec: FormSpec = {
    name: `${solicitation.title} — application form (solicitation ${solicitation.id})`,
    title: solicitation.title,
    description: parts.join('\n\n'),
    items: [...identityItems(), ...questionItems],
  };

  for (const [where, text] of respondentFacingText(spec)) {
    const hits = findDenyListHits(text, input.deny_list);
    if (hits.length > 0) {
      errors.push({ code: 'DENY_LIST_HIT', where, message: `names ${hits.map((h) => `"${h}"`).join(', ')}` });
    }
  }

  if (errors.length > 0) throw new FormSpecValidationError(errors);
  return spec;
}

/** Every piece of text a respondent sees, labelled by where it sits. */
export function respondentFacingText(spec: FormSpec): [string, string][] {
  const out: [string, string][] = [
    ['name', spec.name],
    ['title', spec.title],
    ['description', spec.description],
  ];
  spec.items.forEach((it, i) => {
    out.push([`items[${i}].title`, it.title]);
    if (it.description) out.push([`items[${i}].description`, it.description]);
    (it.options ?? []).forEach((o, j) => out.push([`items[${i}].options[${j}]`, o]));
  });
  return out;
}

/** `forms_create_from_spec`'s per-item result. */
export interface CreatedFormItem {
  index: number;
  question_id: string | null;
}

/**
 * Form `question_id` → solicitation question id (or an identity ref), joined by
 * item position between the spec that was sent and the create result.
 */
export function buildQuestionMap(spec: FormSpec, created: CreatedFormItem[]): Record<string, string> {
  if (created.length !== spec.items.length) {
    throw new Error(`create result has ${created.length} items, spec has ${spec.items.length}`);
  }
  const map: Record<string, string> = {};
  for (const c of created) {
    const item = spec.items[c.index];
    if (!item) throw new Error(`create result names item ${c.index}, which the spec does not have`);
    const ref = parseQuestionRef(item.description);
    if (!ref) throw new Error(`spec item ${c.index} ("${item.title}") carries no [ref: …] line`);
    if (!c.question_id) throw new Error(`form item ${c.index} ("${item.title}") came back with no question_id`);
    map[c.question_id] = ref;
  }
  return map;
}

/** One response from `forms_list_responses`. */
export interface FormResponse {
  response_id: string;
  last_submitted_time?: string | null;
  create_time?: string | null;
  answers: Record<string, string[]>;
}

/** The `create_response` arguments for one imported form response. */
export interface ImportPayload {
  solicitation_id: number;
  org_name: string;
  responses: Record<string, string>;
  submitted_by_name: string;
  submitted_by_email: string;
  submission_date?: string;
  status: 'submitted';
}

export interface ImportProblem {
  form_response_id: string;
  code: 'UNMAPPED_QUESTION' | 'MISSING_IDENTITY' | 'MISSING_REQUIRED' | 'NOT_A_NUMBER';
  message: string;
}

export interface ImportPlan {
  /** In form order; `form_response_id` is what the record stores once created. */
  to_create: { form_response_id: string; payload: ImportPayload }[];
  /** Already in the record's `imported` list. */
  skipped: string[];
  /** Reported to the operator. A response with problems is still imported as given. */
  problems: ImportProblem[];
}

/**
 * Map form responses to `create_response` payloads. Answers are entered as the
 * respondent gave them (multi-value answers joined with ", "). A response whose
 * identity answers are missing cannot be attributed and is NOT imported.
 */
export function planImport(args: {
  solicitation_id: number;
  questions: SolicitationFormQuestion[];
  question_map: Record<string, string>;
  responses: FormResponse[];
  already_imported: string[];
}): ImportPlan {
  const done = new Set(args.already_imported);
  const byId = new Map(args.questions.map((q) => [q.id, q]));
  const plan: ImportPlan = { to_create: [], skipped: [], problems: [] };

  for (const r of args.responses) {
    if (done.has(r.response_id)) {
      plan.skipped.push(r.response_id);
      continue;
    }
    const answers: Record<string, string> = {};
    for (const [formQid, values] of Object.entries(r.answers ?? {})) {
      const ref = args.question_map[formQid];
      if (!ref) {
        plan.problems.push({
          form_response_id: r.response_id,
          code: 'UNMAPPED_QUESTION',
          message: `form question ${formQid} is not in the question map (was the form edited after creation?)`,
        });
        continue;
      }
      answers[ref] = (values ?? []).map((v) => v.trim()).filter(Boolean).join(', ');
    }

    const org = answers[IDENTITY_REFS.org_name];
    const name = answers[IDENTITY_REFS.contact_name];
    const email = answers[IDENTITY_REFS.contact_email];
    if (!org || !name || !email) {
      plan.problems.push({
        form_response_id: r.response_id,
        code: 'MISSING_IDENTITY',
        message: 'organisation, name or email is blank; not imported',
      });
      continue;
    }

    const responses: Record<string, string> = {};
    for (const q of args.questions) {
      const a = answers[q.id];
      if (a) {
        responses[q.id] = a;
        if (q.type === 'number' && !/^-?\d+(?:\.\d+)?$/.test(a.replace(/[\s,]/g, ''))) {
          plan.problems.push({ form_response_id: r.response_id, code: 'NOT_A_NUMBER', message: `${q.id}: "${a}"` });
        }
      } else if (q.required) {
        plan.problems.push({ form_response_id: r.response_id, code: 'MISSING_REQUIRED', message: q.id });
      }
    }
    for (const ref of Object.keys(answers)) {
      if (!ref.startsWith(RESERVED_PREFIX) && !byId.has(ref)) {
        plan.problems.push({
          form_response_id: r.response_id,
          code: 'UNMAPPED_QUESTION',
          message: `answer for ${ref}, which the solicitation no longer has`,
        });
      }
    }

    const submitted = r.last_submitted_time ?? r.create_time ?? undefined;
    plan.to_create.push({
      form_response_id: r.response_id,
      payload: {
        solicitation_id: args.solicitation_id,
        org_name: org,
        responses,
        submitted_by_name: name,
        submitted_by_email: email,
        ...(submitted ? { submission_date: submitted } : {}),
        status: 'submitted',
      },
    });
  }
  return plan;
}
