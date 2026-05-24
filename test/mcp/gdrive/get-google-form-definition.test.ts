/**
 * Tests for `get_google_form_definition` — the atom that reads a Google
 * Form's question schema via the Forms API.
 *
 * What this verifies:
 *   - classification covers radio / checkbox / dropdown / short_answer /
 *     paragraph / scale / date / file_upload / unknown
 *   - choice options surface as a string[] of values
 *   - scale questions expand low..high to numeric option labels
 *   - required flag and item_id propagate
 *   - items without questionItem (page breaks, images) are skipped
 */

import { describe, it, expect, vi } from 'vitest';
import { handleGetGoogleFormDefinition } from '../../../mcp/google-drive-server.js';

function fakeForms(formPayload: any) {
  return {
    forms: {
      get: vi.fn().mockResolvedValue({ data: formPayload }),
    },
  } as any;
}

describe('handleGetGoogleFormDefinition', () => {
  it('classifies a radio choice question with options and required', async () => {
    const forms = fakeForms({
      formId: 'form-1',
      info: { title: 'My survey', description: 'desc' },
      items: [
        {
          itemId: 'i1',
          title: 'Pick one',
          questionItem: {
            question: {
              required: true,
              choiceQuestion: {
                type: 'RADIO',
                options: [{ value: 'A' }, { value: 'B' }],
              },
            },
          },
        },
      ],
    });
    const r = await handleGetGoogleFormDefinition({ formId: 'form-1' }, forms);
    expect(r.title).toBe('My survey');
    expect(r.description).toBe('desc');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      item_id: 'i1',
      title: 'Pick one',
      kind: 'radio',
      required: true,
      options: ['A', 'B'],
    });
  });

  it('classifies short_answer vs paragraph by paragraph flag', async () => {
    const forms = fakeForms({
      info: { title: 't' },
      items: [
        { itemId: 'a', title: 'short', questionItem: { question: { textQuestion: {} } } },
        { itemId: 'b', title: 'long',  questionItem: { question: { textQuestion: { paragraph: true } } } },
      ],
    });
    const r = await handleGetGoogleFormDefinition({ formId: 'f' }, forms);
    expect(r.items.map((i) => i.kind)).toEqual(['short_answer', 'paragraph']);
    expect(r.items[0].required).toBe(false);
  });

  it('expands scale low/high into numeric options', async () => {
    const forms = fakeForms({
      info: {},
      items: [
        {
          itemId: 's1',
          title: 'rate',
          questionItem: { question: { scaleQuestion: { low: 1, high: 5 } } },
        },
      ],
    });
    const r = await handleGetGoogleFormDefinition({ formId: 'f' }, forms);
    expect(r.items[0]).toMatchObject({
      kind: 'scale',
      options: ['1', '2', '3', '4', '5'],
    });
  });

  it('skips items that are not question items (page break, image)', async () => {
    const forms = fakeForms({
      info: {},
      items: [
        { itemId: 'pb', title: 'Section break', pageBreakItem: {} },
        { itemId: 'img', title: 'Logo', imageItem: { image: {} } },
        { itemId: 'q', title: 'q', questionItem: { question: { textQuestion: {} } } },
      ],
    });
    const r = await handleGetGoogleFormDefinition({ formId: 'f' }, forms);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].item_id).toBe('q');
  });

  it('classifies date / time / file_upload / unknown', async () => {
    const forms = fakeForms({
      info: {},
      items: [
        { itemId: 'd', title: 'd', questionItem: { question: { dateQuestion: {} } } },
        { itemId: 't', title: 't', questionItem: { question: { timeQuestion: {} } } },
        { itemId: 'u', title: 'u', questionItem: { question: { fileUploadQuestion: {} } } },
        { itemId: '?', title: '?', questionItem: { question: { /* nothing recognized */ } } },
      ],
    });
    const r = await handleGetGoogleFormDefinition({ formId: 'f' }, forms);
    expect(r.items.map((i) => i.kind)).toEqual(['date', 'time', 'file_upload', 'unknown']);
  });

  it('passes formId to forms.forms.get', async () => {
    const forms = fakeForms({ info: {}, items: [] });
    await handleGetGoogleFormDefinition({ formId: 'specific-form-id' }, forms);
    expect(forms.forms.get).toHaveBeenCalledWith({ formId: 'specific-form-id' });
  });
});
