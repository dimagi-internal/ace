import { describe, it, expect, vi } from 'vitest';
import { makeDecisionsRenderDriveClient } from '../../../mcp/google-drive-server.js';

// Adapter unit tests for the render_decisions_log atom (jjackson/ace#574).
// makeDecisionsRenderDriveClient bridges runDecisionsRender's four-method
// interface to the live Drive + Docs clients; here we exercise it against
// mocked clients to lock the lookup-by-name, find-or-create, clear-body
// index math, and batch passthrough.

function makeDrive(opts: {
  list?: any;
  // for readFile -> handleReadFile (files.get metadata, then alt:media content)
  getMeta?: any;
  media?: any;
  create?: any;
} = {}) {
  const files = {
    list: vi.fn(async () => ({ data: { files: opts.list ?? [] } })),
    get: vi.fn(async (args: any) => {
      // handleReadFile calls files.get twice: metadata, then alt:media.
      if (args?.alt === 'media') return { data: opts.media ?? '' };
      return { data: opts.getMeta ?? { mimeType: 'text/plain', name: 'x', version: '1' } };
    }),
    create: vi.fn(async () => ({ data: opts.create ?? { id: 'new-doc-id' } })),
  };
  return { files } as any;
}

function makeDocs(opts: { bodyEndIndex?: number; replies?: any[] } = {}) {
  const documents = {
    get: vi.fn(async () => ({
      data: { body: { content: [{ endIndex: opts.bodyEndIndex ?? 1 }] } },
    })),
    batchUpdate: vi.fn(async () => ({ data: { replies: opts.replies ?? [] } })),
  };
  return { documents } as any;
}

describe('makeDecisionsRenderDriveClient', () => {
  describe('readFile', () => {
    it('finds the named file under the parent and returns its content', async () => {
      const drive = makeDrive({ list: [{ id: 'yaml-id', name: 'decisions.yaml' }], media: 'schema_version: 3' });
      const docs = makeDocs();
      const client = makeDecisionsRenderDriveClient(drive, docs);

      const r = await client.readFile({ parentFolderId: 'run-folder', name: 'decisions.yaml' });

      expect(r.content).toBe('schema_version: 3');
      // q scopes to the named file under the given parent, excluding folders + trashed.
      const q = drive.files.list.mock.calls[0][0].q as string;
      expect(q).toContain("name='decisions.yaml'");
      expect(q).toContain("'run-folder' in parents");
      expect(q).toContain('trashed=false');
    });

    it('throws an actionable error when the file is absent', async () => {
      const drive = makeDrive({ list: [] });
      const client = makeDecisionsRenderDriveClient(drive, makeDocs());
      await expect(
        client.readFile({ parentFolderId: 'run-folder', name: 'decisions.yaml' }),
      ).rejects.toThrow(/decisions\.yaml not found in folder run-folder/);
    });
  });

  describe('findOrCreateDoc', () => {
    it('reuses an existing doc (reused=true, no create call)', async () => {
      const drive = makeDrive({ list: [{ id: 'existing-doc', name: 'decisions.gdoc' }] });
      const client = makeDecisionsRenderDriveClient(drive, makeDocs());
      const r = await client.findOrCreateDoc({ parentFolderId: 'run-folder', name: 'decisions.gdoc' });
      expect(r).toEqual({ id: 'existing-doc', reused: true });
      expect(drive.files.create).not.toHaveBeenCalled();
    });

    it('creates a native Google Doc when none exists (reused=false)', async () => {
      const drive = makeDrive({ list: [], create: { id: 'fresh-doc' } });
      const client = makeDecisionsRenderDriveClient(drive, makeDocs());
      const r = await client.findOrCreateDoc({ parentFolderId: 'run-folder', name: 'decisions.gdoc' });
      expect(r).toEqual({ id: 'fresh-doc', reused: false });
      const body = drive.files.create.mock.calls[0][0].requestBody;
      expect(body.mimeType).toBe('application/vnd.google-apps.document');
      expect(body.parents).toEqual(['run-folder']);
    });
  });

  describe('clearDocBody', () => {
    it('deletes the populated range [1, endIndex-1] for a non-empty doc', async () => {
      const docs = makeDocs({ bodyEndIndex: 42 });
      const client = makeDecisionsRenderDriveClient(makeDrive(), docs);
      await client.clearDocBody('doc-1');
      expect(docs.documents.batchUpdate).toHaveBeenCalledTimes(1);
      const req = docs.documents.batchUpdate.mock.calls[0][0].requestBody.requests[0];
      expect(req).toEqual({ deleteContentRange: { range: { startIndex: 1, endIndex: 41 } } });
    });

    it('is a no-op for an empty doc (endIndex<=2 — final newline is undeletable)', async () => {
      const docs = makeDocs({ bodyEndIndex: 2 });
      const client = makeDecisionsRenderDriveClient(makeDrive(), docs);
      await client.clearDocBody('doc-1');
      expect(docs.documents.batchUpdate).not.toHaveBeenCalled();
    });
  });

  describe('batchUpdateDoc', () => {
    it('forwards requests and returns the API replies', async () => {
      const docs = makeDocs({ replies: [{ insertText: {} }] });
      const client = makeDecisionsRenderDriveClient(makeDrive(), docs);
      const reqs = [{ insertText: { location: { index: 1 }, text: 'hi' } }];
      const r = await client.batchUpdateDoc({ documentId: 'doc-1', requests: reqs });
      expect(r.replies).toEqual([{ insertText: {} }]);
      expect(docs.documents.batchUpdate.mock.calls[0][0]).toMatchObject({
        documentId: 'doc-1',
        requestBody: { requests: reqs },
      });
    });
  });
});
