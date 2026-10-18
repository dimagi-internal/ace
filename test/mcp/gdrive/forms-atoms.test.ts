/**
 * Tests for the Forms write atoms: forms_create_from_spec,
 * forms_set_publish_settings, forms_list_responses.
 *
 * What this verifies:
 *   - each item kind maps to the right Forms API Item body, and bad specs are
 *     refused before anything is written;
 *   - create refuses a My Drive parent and a same-named form, and otherwise
 *     creates via drive.files.create (never forms.create) then batchUpdate;
 *   - publish sends publishState, and responder access is the Drive
 *     published-view permission (live-verified: publishing alone leaves the
 *     responder link 401 for anonymous visitors);
 *   - responses are paged and answers keyed by question id.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSharedDriveProbeCacheForTests,
  formItemFromSpec,
  handleFormsCreateFromSpec,
  handleFormsListResponses,
  handleFormsSetPublishSettings,
} from '../../../mcp/google-drive-server.js';

beforeEach(() => __resetSharedDriveProbeCacheForTests());

describe('formItemFromSpec', () => {
  it('maps text kinds', () => {
    expect(formItemFromSpec({ title: 'Org', kind: 'short_answer', required: true }, 0)).toEqual({
      title: 'Org',
      questionItem: { question: { required: true, textQuestion: { paragraph: false } } },
    });
    expect(formItemFromSpec({ title: 'Why', kind: 'paragraph' }, 0).questionItem.question.textQuestion).toEqual({
      paragraph: true,
    });
  });

  it('maps choice kinds with options', () => {
    const r = formItemFromSpec({ title: 'C', kind: 'checkbox', options: ['Uganda', 'Malawi'] }, 0);
    expect(r.questionItem.question.choiceQuestion).toEqual({
      type: 'CHECKBOX',
      options: [{ value: 'Uganda' }, { value: 'Malawi' }],
    });
    expect(formItemFromSpec({ title: 'R', kind: 'radio', options: ['a'] }, 0).questionItem.question.choiceQuestion.type).toBe('RADIO');
    expect(formItemFromSpec({ title: 'D', kind: 'dropdown', options: ['a'] }, 0).questionItem.question.choiceQuestion.type).toBe(
      'DROP_DOWN',
    );
  });

  it('maps scale, date, section and info', () => {
    expect(formItemFromSpec({ title: 'S', kind: 'scale', low: 1, high: 5, lowLabel: 'no' }, 0).questionItem.question.scaleQuestion).toEqual({
      low: 1,
      high: 5,
      lowLabel: 'no',
    });
    expect(formItemFromSpec({ title: 'When', kind: 'date' }, 0).questionItem.question.dateQuestion).toEqual({ includeYear: true });
    expect(formItemFromSpec({ title: 'Part 2', kind: 'section', description: 'd' }, 0)).toEqual({
      title: 'Part 2',
      description: 'd',
      pageBreakItem: {},
    });
    expect(formItemFromSpec({ title: 'Banner', kind: 'info' }, 0)).toEqual({ title: 'Banner', textItem: {} });
  });

  it('refuses specs the API would reject', () => {
    expect(() => formItemFromSpec({ title: 'X', kind: 'radio' }, 2)).toThrow(/items\[2\].*options/);
    expect(() => formItemFromSpec({ title: 'X', kind: 'short_answer', options: ['a'] }, 0)).toThrow(/only valid/);
    expect(() => formItemFromSpec({ title: 'X', kind: 'scale', low: 3, high: 5 }, 0)).toThrow(/scale/);
    expect(() => formItemFromSpec({ title: 'X', kind: 'scale', high: 11 }, 0)).toThrow(/scale/);
  });
});

function fakeDrive(opts: { driveId?: string | null; existing?: any[] } = {}) {
  return {
    files: {
      get: vi.fn().mockResolvedValue({
        data: { id: 'parent', name: 'run', mimeType: 'application/vnd.google-apps.folder', driveId: opts.driveId === undefined ? 'shared-1' : opts.driveId },
      }),
      list: vi.fn().mockResolvedValue({ data: { files: opts.existing ?? [] } }),
      create: vi.fn().mockResolvedValue({ data: { id: 'form-1', name: 'Call form', webViewLink: 'https://docs.google.com/forms/d/form-1/edit' } }),
    },
    permissions: {
      list: vi.fn(),
      create: vi.fn().mockResolvedValue({ data: {} }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
    },
  } as any;
}

function fakeForms() {
  return {
    forms: {
      batchUpdate: vi.fn().mockResolvedValue({
        data: { replies: [{}, { createItem: { itemId: 'i1', questionId: ['q1'] } }, { createItem: { itemId: 'i2' } }] },
      }),
      get: vi.fn().mockResolvedValue({ data: { responderUri: 'https://docs.google.com/forms/d/e/xyz/viewform', items: [] } }),
      setPublishSettings: vi.fn().mockResolvedValue({
        data: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } } },
      }),
      responses: { list: vi.fn() },
    },
  } as any;
}

const SPEC = {
  parentFolderId: 'parent',
  title: 'Call form',
  description: 'Demonstration call; not a live call.',
  items: [
    { title: 'Organisation name', kind: 'short_answer' as const, required: true },
    { title: 'About this form', kind: 'info' as const },
  ],
};

describe('handleFormsCreateFromSpec', () => {
  it('creates via Drive in the Shared Drive folder, deletes the default blank question, fills it with one batchUpdate', async () => {
    const drive = fakeDrive();
    const forms = fakeForms();
    // Live-verified: a Drive-created form arrives with one "Untitled Question".
    forms.forms.get.mockResolvedValueOnce({ data: { items: [{ title: 'Untitled Question', questionItem: { question: {} } }] } });
    forms.forms.batchUpdate.mockResolvedValueOnce({
      data: { replies: [{}, {}, { createItem: { itemId: 'i1', questionId: ['q1'] } }, { createItem: { itemId: 'i2' } }] },
    });
    const r = await handleFormsCreateFromSpec(SPEC, forms, drive);
    expect(drive.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { name: 'Call form', mimeType: 'application/vnd.google-apps.form', parents: ['parent'] },
        supportsAllDrives: true,
      }),
    );
    const req = forms.forms.batchUpdate.mock.calls[0][0].requestBody.requests;
    expect(req[0]).toEqual({
      updateFormInfo: { info: { title: 'Call form', description: SPEC.description }, updateMask: 'title,description' },
    });
    expect(req[1]).toEqual({ deleteItem: { location: { index: 0 } } });
    expect(req[2].createItem.location).toEqual({ index: 0 });
    expect(req[3].createItem.item).toEqual({ title: 'About this form', textItem: {} });
    expect(r).toMatchObject({ form_id: 'form-1', published: false, responder_uri: expect.stringContaining('viewform') });
    expect(r.items).toEqual([
      { index: 0, title: 'Organisation name', kind: 'short_answer', item_id: 'i1', question_id: 'q1' },
      { index: 1, title: 'About this form', kind: 'info', item_id: 'i2', question_id: null },
    ]);
  });

  it('refuses a My Drive parent before writing', async () => {
    const drive = fakeDrive({ driveId: null });
    await expect(handleFormsCreateFromSpec(SPEC, fakeForms(), drive)).rejects.toThrow(/My Drive/);
    expect(drive.files.create).not.toHaveBeenCalled();
  });

  it('refuses a same-named form already in the folder', async () => {
    const drive = fakeDrive({ existing: [{ id: 'old-form', name: 'Call form' }] });
    await expect(handleFormsCreateFromSpec(SPEC, fakeForms(), drive)).rejects.toThrow(/old-form/);
    expect(drive.files.create).not.toHaveBeenCalled();
  });

  it('refuses a bad item before any Drive call', async () => {
    const drive = fakeDrive();
    await expect(
      handleFormsCreateFromSpec({ ...SPEC, items: [{ title: 'Pick', kind: 'radio' }] }, fakeForms(), drive),
    ).rejects.toThrow(/options/);
    expect(drive.files.get).not.toHaveBeenCalled();
  });
});

describe('handleFormsSetPublishSettings', () => {
  it('publishes and adds the published-view anyone permission once', async () => {
    const drive = fakeDrive();
    drive.permissions.list
      .mockResolvedValueOnce({ data: { permissions: [] } })
      .mockResolvedValueOnce({ data: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader', view: 'published' }] } });
    const forms = fakeForms();
    const r = await handleFormsSetPublishSettings(
      { formId: 'form-1', isPublished: true, isAcceptingResponses: true, anyoneWithLinkCanRespond: true },
      forms,
      drive,
    );
    expect(forms.forms.setPublishSettings).toHaveBeenCalledWith({
      formId: 'form-1',
      requestBody: {
        publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
        updateMask: 'publishState',
      },
    });
    expect(drive.permissions.create).toHaveBeenCalledWith({
      fileId: 'form-1',
      supportsAllDrives: true,
      requestBody: { type: 'anyone', role: 'reader', view: 'published' },
    });
    expect(drive.permissions.list).toHaveBeenCalledWith(expect.objectContaining({ includePermissionsForView: 'published' }));
    expect(r).toEqual({
      form_id: 'form-1',
      is_published: true,
      is_accepting_responses: true,
      anyone_with_link_can_respond: true,
      responder_uri: 'https://docs.google.com/forms/d/e/xyz/viewform',
    });
  });

  it('does not add the permission twice', async () => {
    const drive = fakeDrive();
    const has = { data: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader', view: 'published' }] } };
    drive.permissions.list.mockResolvedValue(has);
    await handleFormsSetPublishSettings(
      { formId: 'form-1', isPublished: true, isAcceptingResponses: true, anyoneWithLinkCanRespond: true },
      fakeForms(),
      drive,
    );
    expect(drive.permissions.create).not.toHaveBeenCalled();
  });

  it('removes responder access on false, leaves it alone when omitted', async () => {
    const drive = fakeDrive();
    const has = { data: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader', view: 'published' }] } };
    drive.permissions.list.mockResolvedValue(has);
    await handleFormsSetPublishSettings(
      { formId: 'form-1', isPublished: true, isAcceptingResponses: false, anyoneWithLinkCanRespond: false },
      fakeForms(),
      drive,
    );
    expect(drive.permissions.delete).toHaveBeenCalledWith({ fileId: 'form-1', permissionId: 'anyoneWithLink', supportsAllDrives: true });

    const drive2 = fakeDrive();
    drive2.permissions.list.mockResolvedValue(has);
    await handleFormsSetPublishSettings({ formId: 'form-1', isPublished: true, isAcceptingResponses: false }, fakeForms(), drive2);
    expect(drive2.permissions.create).not.toHaveBeenCalled();
    expect(drive2.permissions.delete).not.toHaveBeenCalled();
  });

  it('refuses accepting responses on an unpublished form', async () => {
    const forms = fakeForms();
    await expect(
      handleFormsSetPublishSettings({ formId: 'f', isPublished: false, isAcceptingResponses: true }, forms, fakeDrive()),
    ).rejects.toThrow(/requires isPublished/);
    expect(forms.forms.setPublishSettings).not.toHaveBeenCalled();
  });
});

describe('handleFormsListResponses', () => {
  it('walks every page and keys answers by question id', async () => {
    const forms = fakeForms();
    forms.forms.get.mockResolvedValue({
      data: { items: [{ title: 'Organisation name', questionItem: { question: { questionId: 'q1' } } }, { title: 'Banner', textItem: {} }] },
    });
    forms.forms.responses.list
      .mockResolvedValueOnce({
        data: {
          responses: [{ responseId: 'r1', createTime: 't1', lastSubmittedTime: 't1', answers: { q1: { textAnswers: { answers: [{ value: 'Acme' }] } } } }],
          nextPageToken: 'p2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          responses: [{ responseId: 'r2', respondentEmail: 'a@b.org', answers: { q2: { fileUploadAnswers: { answers: [{ fileId: 'f9' }] } } } }],
        },
      });
    const plainDrive = {
      files: { get: vi.fn().mockResolvedValue({ data: { mimeType: 'application/vnd.google-apps.form' } }) },
    } as any;
    const r = await handleFormsListResponses({ formId: 'form-1', since: '2026-10-01T00:00:00Z' }, forms, plainDrive);
    expect(r.shortcut_resolved).toBe(false);
    expect(forms.forms.responses.list).toHaveBeenNthCalledWith(1, { formId: 'form-1', filter: 'timestamp >= 2026-10-01T00:00:00Z', pageToken: undefined });
    expect(forms.forms.responses.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: 'p2' }));
    expect(r.questions).toEqual({ q1: 'Organisation name' });
    expect(r.responses).toEqual([
      { response_id: 'r1', create_time: 't1', last_submitted_time: 't1', respondent_email: null, answers: { q1: ['Acme'] } },
      { response_id: 'r2', create_time: null, last_submitted_time: null, respondent_email: 'a@b.org', answers: { q2: ['f9'] } },
    ]);
  });
});
