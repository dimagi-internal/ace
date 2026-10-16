import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  handleDocsGet,
  handleGetGoogleFormDefinition,
  handleListComments,
  handleReplyToComment,
  handleSheetsBatchRead,
  handleSheetsInfo,
  handleSheetsListTabs,
  handleSheetsRead,
  handleSlidesGet,
  resolveShortcutTarget,
} from '../../../mcp/google-drive-server.js';

/**
 * ace#2375 — `drive_list_comments` / `drive_reply_to_comment` passed the
 * caller's `fileId` straight to Drive's `comments.list` / `replies.create`,
 * neither of which follows shortcuts. Their sibling `drive_read_file` HAS
 * resolved shortcuts since #106, so a caller who read a document through its
 * shortcut id naturally listed its comments through the same id and got
 * `File not found: <id>.` back — which reads as "the document is gone" or
 * "no comments", not "you passed a shortcut".
 *
 * Every componentized input under `ACE/<opp>/inputs/` is a shortcut, so this
 * was the normal case for the input-comment reading that ace#2372 opened up.
 *
 * Two layers are pinned here:
 *
 * 1. **Behaviour** — a shortcut id resolves to its target BEFORE the comments
 *    call, and the result echoes which document the threads actually live on
 *    (`file_id` = target, `requested_file_id` = what was passed).
 * 2. **The class** — a source scan asserting that EVERY `comments.*` /
 *    `replies.*` call in the server sits in a function that resolved the
 *    shortcut first. Patching the two named atoms leaves the next comment
 *    atom free to reintroduce the gap; this is the preventer
 *    (`CLAUDE.md § Conventions`, class-level preventers).
 */

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

const fakeDrive = {
  files: { get: vi.fn() },
  comments: { list: vi.fn() },
  replies: { create: vi.fn() },
};

/** Never actually wait — withTransientRetry's backoff is stubbed out. */
const opts = { sleep: async () => {} };

function metaShortcut(id: string, targetId?: string) {
  return {
    data: {
      id,
      mimeType: SHORTCUT_MIME,
      ...(targetId ? { shortcutDetails: { targetId } } : {}),
    },
  };
}

function metaDoc(id: string) {
  return { data: { id, mimeType: 'application/vnd.google-apps.document' } };
}

beforeEach(() => {
  fakeDrive.files.get.mockReset();
  fakeDrive.comments.list.mockReset();
  fakeDrive.replies.create.mockReset();
});

describe('resolveShortcutTarget', () => {
  it('returns the target id for a shortcut', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaShortcut('sc-1', 'target-1'));
    const r = await resolveShortcutTarget('sc-1', fakeDrive as any, opts);
    expect(r).toEqual({ fileId: 'target-1', requestedFileId: 'sc-1', wasShortcut: true });
  });

  it('passes a non-shortcut id through untouched', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaDoc('doc-1'));
    const r = await resolveShortcutTarget('doc-1', fakeDrive as any, opts);
    expect(r).toEqual({ fileId: 'doc-1', requestedFileId: 'doc-1', wasShortcut: false });
  });

  it('throws a typed error on a shortcut with no target', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaShortcut('sc-1'));
    await expect(resolveShortcutTarget('sc-1', fakeDrive as any, opts)).rejects.toThrow(
      /shortcut_without_target/,
    );
  });

  it('retries a transient 503 on the metadata lookup', async () => {
    const boom: any = new Error('Backend Error');
    boom.code = 503;
    fakeDrive.files.get.mockRejectedValueOnce(boom).mockResolvedValueOnce(metaDoc('doc-1'));
    const r = await resolveShortcutTarget('doc-1', fakeDrive as any, opts);
    expect(r.fileId).toBe('doc-1');
    expect(fakeDrive.files.get).toHaveBeenCalledTimes(2);
  });
});

describe('handleListComments resolves shortcuts (ace#2375)', () => {
  const oneThread = {
    data: {
      comments: [
        {
          id: 'c1',
          content: 'please cite the source',
          resolved: false,
          createdTime: '2026-09-11T10:00:00Z',
          author: { displayName: 'Reviewer' },
          quotedFileContent: { value: 'the targeting figure' },
          replies: [],
        },
      ],
    },
  };

  it('lists comments on the TARGET when handed a shortcut id', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaShortcut('sc-1', 'target-1'));
    fakeDrive.comments.list.mockResolvedValueOnce(oneThread);

    const r = await handleListComments({ fileId: 'sc-1' }, fakeDrive as any, opts);

    expect(fakeDrive.comments.list).toHaveBeenCalledTimes(1);
    expect(fakeDrive.comments.list.mock.calls[0][0].fileId).toBe('target-1');
    // The caller learns which document the threads actually live on.
    expect(r.file_id).toBe('target-1');
    expect(r.requested_file_id).toBe('sc-1');
    expect(r.shortcut_resolved).toBe(true);
    expect(r.total).toBe(1);
    expect(r.comments[0].quoted_text).toBe('the targeting figure');
  });

  it('leaves a plain file id alone', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaDoc('doc-1'));
    fakeDrive.comments.list.mockResolvedValueOnce(oneThread);

    const r = await handleListComments({ fileId: 'doc-1' }, fakeDrive as any, opts);

    expect(fakeDrive.comments.list.mock.calls[0][0].fileId).toBe('doc-1');
    expect(r.file_id).toBe('doc-1');
    expect(r.shortcut_resolved).toBe(false);
  });

  it('still filters resolved threads when includeResolved is false', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaDoc('doc-1'));
    fakeDrive.comments.list.mockResolvedValueOnce({
      data: {
        comments: [
          { id: 'c1', content: 'open', resolved: false, replies: [] },
          { id: 'c2', content: 'closed', resolved: true, replies: [] },
        ],
      },
    });

    const r = await handleListComments(
      { fileId: 'doc-1', includeResolved: false },
      fakeDrive as any,
      opts,
    );

    expect(r.total).toBe(1);
    expect(r.comments.map((c: any) => c.id)).toEqual(['c1']);
  });

  it('never calls comments.list when the shortcut has no target', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaShortcut('sc-1'));
    await expect(
      handleListComments({ fileId: 'sc-1' }, fakeDrive as any, opts),
    ).rejects.toThrow(/shortcut_without_target/);
    expect(fakeDrive.comments.list).not.toHaveBeenCalled();
  });
});

describe('handleReplyToComment resolves shortcuts (ace#2375)', () => {
  const reply = {
    data: {
      id: 'r1',
      content: 'landed in open-questions.md',
      action: 'resolve',
      createdTime: '2026-09-11T11:00:00Z',
      author: { displayName: 'ACE' },
    },
  };

  it('replies on the TARGET when handed a shortcut id', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaShortcut('sc-1', 'target-1'));
    fakeDrive.replies.create.mockResolvedValueOnce(reply);

    const r = await handleReplyToComment(
      { fileId: 'sc-1', commentId: 'c1', content: 'landed in open-questions.md', action: 'resolve' },
      fakeDrive as any,
      opts,
    );

    expect(fakeDrive.replies.create).toHaveBeenCalledTimes(1);
    const call = fakeDrive.replies.create.mock.calls[0][0];
    expect(call.fileId).toBe('target-1');
    expect(call.commentId).toBe('c1');
    expect(call.requestBody).toEqual({ content: 'landed in open-questions.md', action: 'resolve' });
    expect(r.file_id).toBe('target-1');
    expect(r.requested_file_id).toBe('sc-1');
    expect(r.shortcut_resolved).toBe(true);
    expect(r.reply_id).toBe('r1');
  });

  it('omits action when none is passed', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaDoc('doc-1'));
    fakeDrive.replies.create.mockResolvedValueOnce({ data: { id: 'r2', content: 'noted' } });

    const r = await handleReplyToComment(
      { fileId: 'doc-1', commentId: 'c1', content: 'noted' },
      fakeDrive as any,
      opts,
    );

    expect(fakeDrive.replies.create.mock.calls[0][0].requestBody).toEqual({ content: 'noted' });
    expect(r.shortcut_resolved).toBe(false);
    expect(r.action).toBeNull();
  });

  it('never calls replies.create when the shortcut has no target', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaShortcut('sc-1'));
    await expect(
      handleReplyToComment(
        { fileId: 'sc-1', commentId: 'c1', content: 'noted' },
        fakeDrive as any,
        opts,
      ),
    ).rejects.toThrow(/shortcut_without_target/);
    expect(fakeDrive.replies.create).not.toHaveBeenCalled();
  });
});

describe('the class: every comment/reply call resolves shortcuts first', () => {
  const SRC = readFileSync(
    join(__dirname, '..', '..', '..', 'mcp', 'google-drive-server.ts'),
    'utf8',
  );

  /**
   * Split the server into top-level declaration chunks — each `function` /
   * `async function` declaration and each `server.tool(` registration starts
   * a new one. Good enough to attribute an API call to the unit that makes
   * it, without parsing TypeScript.
   */
  function declarationChunks(src: string): string[] {
    return src.split(/\n(?=(?:export )?(?:async )?function |server\.tool\()/);
  }

  const CALL_RE = /\.(comments|replies)\.[a-zA-Z]+\(/;

  it('finds the comment API call sites at all (guards against a dead scan)', () => {
    const callers = declarationChunks(SRC).filter((c) => CALL_RE.test(c));
    expect(callers.length).toBeGreaterThanOrEqual(2);
  });

  it('every caller of comments.* / replies.* also calls resolveShortcutTarget', () => {
    const offenders = declarationChunks(SRC)
      .filter((c) => CALL_RE.test(c))
      .filter((c) => !c.includes('resolveShortcutTarget('))
      .map((c) => c.split('\n')[0].trim().slice(0, 90));

    expect(
      offenders,
      'a Drive comments/replies call that does not resolve shortcuts first — ' +
        'a shortcut id answers "File not found" (ace#2375)',
    ).toEqual([]);
  });

  it('both atoms advertise shortcut resolution in their descriptions', () => {
    for (const atom of ['drive_list_comments', 'drive_reply_to_comment']) {
      const start = SRC.indexOf(`'${atom}',`);
      expect(start, `${atom} registration not found`).toBeGreaterThan(-1);
      const body = SRC.slice(start, SRC.indexOf('server.tool(', start + 1));
      expect(body.toLowerCase(), `${atom} does not mention shortcuts`).toContain('shortcut');
    }
  });
});

/**
 * ace#2462 — the same gap on the OTHER API clients. Sheets, Docs, Slides and
 * Forms take a file id and hand it to an API that does not follow Drive
 * shortcuts, and `idea-to-pdd` routes Sheets / Forms inputs (all shortcuts
 * under `inputs/`) to exactly these atoms. Each read must resolve first.
 */
describe('read atoms on the Sheets/Docs/Slides/Forms clients resolve shortcuts (ace#2462)', () => {
  const sheetsApi = {
    spreadsheets: {
      get: vi.fn(),
      values: { get: vi.fn(), batchGet: vi.fn() },
    },
  };
  const docsApi = { documents: { get: vi.fn() } };
  const slidesApi = { presentations: { get: vi.fn() } };
  const formsApi = { forms: { get: vi.fn() } };

  beforeEach(() => {
    sheetsApi.spreadsheets.get.mockReset().mockResolvedValue({
      data: { properties: { title: 'T' }, sheets: [{ properties: { title: 'Tab1', sheetId: 0 } }] },
    });
    sheetsApi.spreadsheets.values.get.mockReset().mockResolvedValue({
      data: { range: 'Tab1!A1:B2', values: [['a']] },
    });
    sheetsApi.spreadsheets.values.batchGet.mockReset().mockResolvedValue({
      data: { valueRanges: [{ range: 'Tab1!A1', values: [['a']] }] },
    });
    docsApi.documents.get.mockReset().mockResolvedValue({
      data: { documentId: 'target-1', title: 'Doc' },
    });
    slidesApi.presentations.get.mockReset().mockResolvedValue({
      data: { presentationId: 'target-1', slides: [] },
    });
    formsApi.forms.get.mockReset().mockResolvedValue({ data: { info: { title: 'F' }, items: [] } });
  });

  const d = () => fakeDrive as any;
  const cases: Array<[string, () => Promise<any>, () => string]> = [
    [
      'sheets_list_tabs',
      () => handleSheetsListTabs({ spreadsheetId: 'sc-1' }, sheetsApi as any, d(), opts),
      () => sheetsApi.spreadsheets.get.mock.calls[0][0].spreadsheetId,
    ],
    [
      'sheets_read',
      () => handleSheetsRead({ spreadsheetId: 'sc-1', range: 'Tab1' }, sheetsApi as any, d(), opts),
      () => sheetsApi.spreadsheets.values.get.mock.calls[0][0].spreadsheetId,
    ],
    [
      'sheets_info',
      () => handleSheetsInfo({ spreadsheetId: 'sc-1' }, sheetsApi as any, d(), opts),
      () => sheetsApi.spreadsheets.get.mock.calls[0][0].spreadsheetId,
    ],
    [
      'sheets_batch_read',
      () => handleSheetsBatchRead({ spreadsheetId: 'sc-1', ranges: ['Tab1!A1'] }, sheetsApi as any, d(), opts),
      () => sheetsApi.spreadsheets.values.batchGet.mock.calls[0][0].spreadsheetId,
    ],
    [
      'docs_get',
      () => handleDocsGet({ documentId: 'sc-1' }, docsApi as any, d(), opts),
      () => docsApi.documents.get.mock.calls[0][0].documentId,
    ],
    [
      'slides_get',
      () => handleSlidesGet({ presentationId: 'sc-1' }, slidesApi as any, d(), opts),
      () => slidesApi.presentations.get.mock.calls[0][0].presentationId,
    ],
    [
      'get_google_form_definition',
      () => handleGetGoogleFormDefinition({ formId: 'sc-1' }, formsApi as any, d(), opts),
      () => formsApi.forms.get.mock.calls[0][0].formId,
    ],
  ];

  for (const [atom, call, calledWith] of cases) {
    it(`${atom} reads the TARGET when handed a shortcut id, and echoes it`, async () => {
      fakeDrive.files.get.mockResolvedValueOnce(metaShortcut('sc-1', 'target-1'));
      const r = await call();
      expect(calledWith()).toBe('target-1');
      expect(r.requested_file_id).toBe('sc-1');
      expect(r.shortcut_resolved).toBe(true);
    });

    it(`${atom} passes a plain id through`, async () => {
      fakeDrive.files.get.mockResolvedValueOnce(metaDoc('sc-1'));
      const r = await call();
      expect(calledWith()).toBe('sc-1');
      expect(r.shortcut_resolved).toBe(false);
    });
  }

  it('sheets_read keeps range + values in the result', async () => {
    fakeDrive.files.get.mockResolvedValueOnce(metaDoc('s'));
    const r = await handleSheetsRead({ spreadsheetId: 's', range: 'Tab1' }, sheetsApi as any, d(), opts);
    expect(r.range).toBe('Tab1!A1:B2');
    expect(r.values).toEqual([['a']]);
  });
});

describe('the class: every Sheets/Docs/Slides/Forms READ call resolves shortcuts first (ace#2462)', () => {
  const SRC = readFileSync(
    join(__dirname, '..', '..', '..', 'mcp', 'google-drive-server.ts'),
    'utf8',
  );
  const chunks = SRC.split(/\n(?=(?:export )?(?:async )?function |server\.tool\()/);
  // Read-only calls against the non-Drive clients, as made by the read ATOMS.
  // Writes (batchUpdate, values.update/append, create) are deliberately
  // excluded — following a shortcut on a mutation is a semantic decision
  // (ace#2462 § Scope).
  const READ_RE =
    /\b(?:sheets|sheetsClient)\.spreadsheets\.(?:get|values\.get|values\.batchGet)\(|\b(?:docs|docsClient)\.documents\.get\(|\b(?:slides|slidesClient)\.presentations\.get\(|\bformsClient\.forms\.get\(/;

  // A unit that also MUTATES (a write atom reading back before/after its edit,
  // e.g. docs_finalize_bullets) is out of scope by the same decision.
  const WRITE_RE = /\.(?:batchUpdate|update|append|create|copy)\(/;
  const readers = chunks.filter((c) => READ_RE.test(c) && !WRITE_RE.test(c));

  it('finds the read call sites at all (guards against a dead scan)', () => {
    expect(readers.length).toBeGreaterThanOrEqual(6);
  });

  it('every read caller also calls resolveShortcutTarget', () => {
    const offenders = readers
      .filter((c) => !c.includes('resolveShortcutTarget('))
      .map((c) => c.split('\n')[0].trim().slice(0, 90));
    expect(
      offenders,
      'a Sheets/Docs/Slides/Forms read that does not resolve Drive shortcuts first — ' +
        'a shortcut id answers "not found" (ace#2462)',
    ).toEqual([]);
  });
});
