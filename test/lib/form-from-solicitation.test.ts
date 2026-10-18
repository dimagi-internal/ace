import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEMONSTRATION_BANNER,
  FormSpecValidationError,
  IDENTITY_REFS,
  buildFormSpec,
  buildQuestionMap,
  parseQuestionRef,
  planImport,
  respondentFacingText,
  type FormSpecInput,
  type SolicitationFormQuestion,
} from '../../lib/form-from-solicitation.js';

const FIX = join(__dirname, '../fixtures/forms');
/** Labs solicitation 1000001, read with get_solicitation 2026-10-18. */
const SOLICITATION = JSON.parse(readFileSync(join(FIX, 'solicitation-1000001-get-2026-10-18.json'), 'utf8'));
/** The live round trip on a form built from it: spec sent, create result, one anonymous submission read back. */
const ROUNDTRIP = JSON.parse(readFileSync(join(FIX, 'forms-roundtrip-live-2026-10-18.json'), 'utf8'));

describe('on the live round trip (2026-10-18)', () => {
  const liveInput = { solicitation: SOLICITATION, visibility: 'private' as const, deny_list: ['GiveDirectly', 'Give Directly', 'GD'] };

  it('rebuilds exactly the spec that was sent to Forms (all but the scratch file name)', () => {
    const { name: _n, ...rest } = buildFormSpec(liveInput);
    const { name: _s, ...sent } = ROUNDTRIP.spec;
    expect(rest).toEqual(sent);
  });

  it('refuses the real call text when the deny list names the party it mentions', () => {
    const err = refusal(() => buildFormSpec({ ...liveInput, deny_list: ['Noora Health'] }));
    expect(err.errors.map((e) => e.where)).toContain('description');
  });

  it('joins the real create result back to the solicitation ids', () => {
    const map = buildQuestionMap(ROUNDTRIP.spec, ROUNDTRIP.created.items);
    expect(map).toEqual(ROUNDTRIP.question_map);
    expect(Object.values(map).sort()).toEqual(
      [...SOLICITATION.questions.map((q: { id: string }) => q.id), ...Object.values(IDENTITY_REFS)].sort(),
    );
  });

  it('plans the real anonymous submission into a create_response payload with every answer', () => {
    const plan = planImport({
      solicitation_id: SOLICITATION.id,
      questions: SOLICITATION.questions,
      question_map: ROUNDTRIP.question_map,
      responses: ROUNDTRIP.listed.responses,
      already_imported: [],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.to_create).toHaveLength(1);
    const p = plan.to_create[0].payload;
    expect(p.org_name).toBe('ACE PR5b scratch respondent');
    expect(p.submitted_by_email).toBe('ace+pr5b-probe@dimagi-ai.com');
    expect(Object.keys(p.responses).sort()).toEqual(SOLICITATION.questions.map((q: { id: string }) => q.id).sort());
    expect(p.submission_date).toBe(ROUNDTRIP.listed.responses[0].last_submitted_time);
  });
});

const questions: SolicitationFormQuestion[] = [
  { id: 'q_exp', text: 'Describe your experience registering adults for national ID.', type: 'textarea', required: true },
  { id: 'q_flws', text: 'How many frontline workers could you deploy?', type: 'number', required: true },
  { id: 'q_area', text: 'Proposed pilot area', type: 'text', framing: 'District and sub-county.' },
  { id: 'q_phones', text: 'Have you distributed phones before?', type: 'multiple_choice', options: ['Yes', 'No'], required: true },
];

function input(over: Partial<FormSpecInput> = {}): FormSpecInput {
  return {
    solicitation: {
      id: 4242,
      title: 'Connect FI pilot partners',
      description: '## About\n\nWe are looking for **LLOs** in two districts.',
      application_deadline: '2026-11-15',
      questions,
    },
    visibility: 'private',
    deny_list: ['Give Directly', 'GD'],
    ...over,
  };
}

function refusal(fn: () => unknown): FormSpecValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FormSpecValidationError) return e;
    throw e;
  }
  throw new Error('expected a FormSpecValidationError');
}

describe('buildFormSpec', () => {
  it('mirrors every question after three identity items, each carrying its ref', () => {
    const spec = buildFormSpec(input());
    expect(spec.items.map((i) => parseQuestionRef(i.description))).toEqual([
      IDENTITY_REFS.org_name,
      IDENTITY_REFS.contact_name,
      IDENTITY_REFS.contact_email,
      'q_exp',
      'q_flws',
      'q_area',
      'q_phones',
    ]);
    expect(spec.items.slice(3).map((i) => i.kind)).toEqual(['paragraph', 'short_answer', 'short_answer', 'radio']);
    expect(spec.items[6].options).toEqual(['Yes', 'No']);
    expect(spec.items[4].description).toContain('Enter a number.');
    expect(spec.items[5].description).toMatch(/^District and sub-county\.\n\n\[ref: q_area\]$/);
    expect(spec.items.slice(0, 3).every((i) => i.required)).toBe(true);
  });

  it('a private call starts with the demonstration banner; a public one does not', () => {
    expect(buildFormSpec(input()).description.startsWith(DEMONSTRATION_BANNER)).toBe(true);
    expect(buildFormSpec(input({ visibility: 'public' })).description).not.toContain(DEMONSTRATION_BANNER);
  });

  it('does not repeat a banner the description already carries, and strips markdown', () => {
    const spec = buildFormSpec(
      input({
        solicitation: { ...input().solicitation, description: `> **${DEMONSTRATION_BANNER}**\n\nBody text.` },
      }),
    );
    expect(spec.description.split(DEMONSTRATION_BANNER).length - 1).toBe(1);
    expect(spec.description).toContain('Body text.');
    expect(buildFormSpec(input()).description).not.toMatch(/\*\*|^##/m);
  });

  it('refuses any respondent-facing text that names a deny-listed party', () => {
    const err = refusal(() =>
      buildFormSpec(
        input({
          solicitation: {
            ...input().solicitation,
            questions: [...questions, { id: 'q_x', text: 'Have you worked with GiveDirectly?', type: 'text' }],
          },
        }),
      ),
    );
    expect(err.errors.map((e) => e.code)).toEqual(['DENY_LIST_HIT']);
    expect(err.errors[0].where).toMatch(/^items\[7\]\.title$/);
  });

  it('catches a deny-listed name in an option and in the description', () => {
    const err = refusal(() =>
      buildFormSpec(
        input({
          solicitation: {
            ...input().solicitation,
            description: 'Funded with GD.',
            questions: [{ id: 'q_p', text: 'Partner', type: 'multiple_choice', options: ['Give-Directly', 'Other'] }],
          },
        }),
      ),
    );
    expect(err.errors.map((e) => e.where).sort()).toEqual(['description', 'items[3].options[0]']);
  });

  it('collects every structural problem at once', () => {
    const err = refusal(() =>
      buildFormSpec(
        input({
          solicitation: {
            ...input().solicitation,
            questions: [
              { id: '__org_name', text: 'x', type: 'text' },
              { id: 'dup', text: 'a', type: 'text' },
              { id: 'dup', text: 'b', type: 'text' },
              { id: 'has space', text: 'c', type: 'text' },
              { id: 'mc', text: 'd', type: 'multiple_choice' },
              { id: 'odd', text: 'e', type: 'file_upload' },
            ],
          },
        }),
      ),
    );
    expect(err.errors.map((e) => e.code)).toEqual(['RESERVED_ID', 'DUPLICATE_ID', 'BAD_ID', 'NO_OPTIONS', 'BAD_TYPE']);
  });

  it('refuses a solicitation with no questions', () => {
    const err = refusal(() => buildFormSpec(input({ solicitation: { ...input().solicitation, questions: [] } })));
    expect(err.errors.map((e) => e.code)).toEqual(['EMPTY_QUESTIONS']);
  });

  it('lists name, title, description, every item title, description and option', () => {
    const where = respondentFacingText(buildFormSpec(input())).map(([w]) => w);
    expect(where).toContain('name');
    expect(where).toContain('items[6].options[1]');
    expect(where.filter((w) => w.endsWith('.title'))).toHaveLength(7);
  });
});

describe('buildQuestionMap', () => {
  const spec = buildFormSpec(input());
  const created = spec.items.map((_, index) => ({ index, question_id: `fq${index}` }));

  it('joins by position', () => {
    expect(buildQuestionMap(spec, created)).toEqual({
      fq0: IDENTITY_REFS.org_name,
      fq1: IDENTITY_REFS.contact_name,
      fq2: IDENTITY_REFS.contact_email,
      fq3: 'q_exp',
      fq4: 'q_flws',
      fq5: 'q_area',
      fq6: 'q_phones',
    });
  });

  it('refuses a count mismatch and a missing question_id', () => {
    expect(() => buildQuestionMap(spec, created.slice(1))).toThrow(/7/);
    expect(() => buildQuestionMap(spec, created.map((c, i) => (i === 2 ? { ...c, question_id: null } : c)))).toThrow(
      /no question_id/,
    );
  });
});

describe('planImport', () => {
  const question_map = {
    fq0: IDENTITY_REFS.org_name,
    fq1: IDENTITY_REFS.contact_name,
    fq2: IDENTITY_REFS.contact_email,
    fq3: 'q_exp',
    fq4: 'q_flws',
    fq5: 'q_area',
    fq6: 'q_phones',
  };
  const full = {
    response_id: 'r1',
    last_submitted_time: '2026-10-20T09:00:00Z',
    answers: {
      fq0: ['Karamoja Health Link'],
      fq1: ['Grace A.'],
      fq2: ['grace@example.org'],
      fq3: ['Five years of ID drives.'],
      fq4: ['1,200'],
      fq6: ['Yes'],
    },
  };

  it('maps answers by id and enters the respondent as given', () => {
    const plan = planImport({ solicitation_id: 4242, questions, question_map, responses: [full], already_imported: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.to_create).toEqual([
      {
        form_response_id: 'r1',
        payload: {
          solicitation_id: 4242,
          org_name: 'Karamoja Health Link',
          responses: { q_exp: 'Five years of ID drives.', q_flws: '1,200', q_phones: 'Yes' },
          submitted_by_name: 'Grace A.',
          submitted_by_email: 'grace@example.org',
          submission_date: '2026-10-20T09:00:00Z',
          status: 'submitted',
        },
      },
    ]);
  });

  it('skips a form response already imported', () => {
    const plan = planImport({ solicitation_id: 4242, questions, question_map, responses: [full], already_imported: ['r1'] });
    expect(plan.to_create).toEqual([]);
    expect(plan.skipped).toEqual(['r1']);
  });

  it('does not import a response it cannot attribute', () => {
    const plan = planImport({
      solicitation_id: 4242,
      questions,
      question_map,
      responses: [{ ...full, response_id: 'r2', answers: { ...full.answers, fq2: [] } }],
      already_imported: [],
    });
    expect(plan.to_create).toEqual([]);
    expect(plan.problems.map((p) => p.code)).toEqual(['MISSING_IDENTITY']);
  });

  it('imports but reports a non-number, a missing required answer and an unmapped question', () => {
    const plan = planImport({
      solicitation_id: 4242,
      questions,
      question_map,
      responses: [
        {
          response_id: 'r3',
          answers: { fq0: ['Org'], fq1: ['N'], fq2: ['n@x.org'], fq4: ['about forty'], fq9: ['?'] },
        },
      ],
      already_imported: [],
    });
    expect(plan.to_create).toHaveLength(1);
    expect(plan.to_create[0].payload.submission_date).toBeUndefined();
    expect(plan.problems.map((p) => p.code).sort()).toEqual(
      ['MISSING_REQUIRED', 'MISSING_REQUIRED', 'NOT_A_NUMBER', 'UNMAPPED_QUESTION'].sort(),
    );
  });

  it('joins multi-value answers', () => {
    const plan = planImport({
      solicitation_id: 1,
      questions,
      question_map,
      responses: [{ ...full, answers: { ...full.answers, fq5: ['Moroto', ' Napak '] } }],
      already_imported: [],
    });
    expect(plan.to_create[0].payload.responses.q_area).toBe('Moroto, Napak');
  });
});
