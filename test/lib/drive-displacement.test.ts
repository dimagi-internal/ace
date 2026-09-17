import { describe, it, expect } from 'vitest';
import {
  DISPLACEMENT_FILE_FIELDS,
  assertExpectedAbsent,
  describeDisplaced,
} from '../../lib/drive-displacement.js';

// ace#2338 — the pure half of "a find-or-update reuse must say what it
// displaced". The Drive-facing half lives in
// test/mcp/gdrive/create-file-displacement.test.ts.

describe('DISPLACEMENT_FILE_FIELDS', () => {
  it('requests every field describeDisplaced can report', () => {
    // The lookup and the describer must not drift: a field dropped from the
    // query silently empties the corresponding key in the report, which is the
    // failure mode this whole change exists to remove.
    for (const f of ['version', 'modifiedTime', 'size', 'lastModifyingUser']) {
      expect(DISPLACEMENT_FILE_FIELDS).toContain(f);
    }
    // And the fields the callers already relied on before the widening.
    for (const f of ['id', 'name', 'webViewLink']) {
      expect(DISPLACEMENT_FILE_FIELDS).toContain(f);
    }
  });
});

describe('describeDisplaced', () => {
  const now = new Date('2026-09-09T12:15:00.000Z');

  it('reports revision, modifiedTime, age and principal', () => {
    const d = describeDisplaced(
      {
        id: '1i6kTt6E',
        name: 'solicitation-create-eval_verdict.yaml',
        version: '7',
        modifiedTime: '2026-09-09T12:12:00.000Z',
        lastModifyingUser: { displayName: 'ACE SA', emailAddress: 'ace-sa@x.iam.gserviceaccount.com' },
      },
      now,
    );
    expect(d.revisionVersion).toBe('7');
    expect(d.modifiedTime).toBe('2026-09-09T12:12:00.000Z');
    expect(d.ageSeconds).toBe(180);
    expect(d.lastModifiedBy).toBe('ace-sa@x.iam.gserviceaccount.com');
    // Absent because the fixture carries no `size`.
    expect(d.sizeBytes).toBeUndefined();
  });

  it('always carries the interpretation note', () => {
    const d = describeDisplaced({ id: 'a', version: 1 }, now);
    expect(d.note).toMatch(/REPLACED/);
    expect(d.note).toMatch(/expectAbsent/);
  });

  it('accepts a numeric version and a numeric size', () => {
    const d = describeDisplaced({ id: 'a', version: 12, size: 4096 }, now);
    expect(d.revisionVersion).toBe('12');
    expect(d.sizeBytes).toBe(4096);
  });

  it('parses a string size (Drive returns size as a string)', () => {
    expect(describeDisplaced({ id: 'a', size: '4096' }, now).sizeBytes).toBe(4096);
  });

  it('omits what Drive did not return rather than inventing it', () => {
    const d = describeDisplaced({ id: 'a' }, now);
    expect(d.revisionVersion).toBeUndefined();
    expect(d.modifiedTime).toBeUndefined();
    expect(d.ageSeconds).toBeUndefined();
    expect(d.lastModifiedBy).toBeUndefined();
    expect(d.sizeBytes).toBeUndefined();
  });

  it('never reports a negative age when Drive clock-skews ahead of ours', () => {
    const d = describeDisplaced({ id: 'a', modifiedTime: '2026-09-09T12:16:00.000Z' }, now);
    expect(d.ageSeconds).toBe(0);
  });

  it('falls back to displayName when no email is present', () => {
    const d = describeDisplaced({ id: 'a', lastModifyingUser: { displayName: 'ACE SA' } }, now);
    expect(d.lastModifiedBy).toBe('ACE SA');
  });

  it('ignores an unparseable modifiedTime instead of emitting NaN', () => {
    const d = describeDisplaced({ id: 'a', modifiedTime: 'not-a-date' }, now);
    expect(d.modifiedTime).toBe('not-a-date');
    expect(d.ageSeconds).toBeUndefined();
  });
});

describe('assertExpectedAbsent', () => {
  const ctx = { atom: 'drive_create_file', name: 'verdict.yaml', parentFolderId: 'folder-1' };

  it('is a no-op when nothing exists', () => {
    expect(() => assertExpectedAbsent(undefined, ctx)).not.toThrow();
    expect(() => assertExpectedAbsent({}, ctx)).not.toThrow();
  });

  it('refuses with the id, revision and age so the caller can go read it', () => {
    let msg = '';
    try {
      assertExpectedAbsent(
        { id: '1i6kTt6E', version: '7', modifiedTime: new Date(Date.now() - 180_000).toISOString() },
        ctx,
      );
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toContain('1i6kTt6E');
    expect(msg).toContain('revision=7');
    expect(msg).toContain('verdict.yaml');
    expect(msg).toContain('folder-1');
    expect(msg).toMatch(/NOTHING WAS WRITTEN/);
    // The recovery is always the same and the message says it.
    expect(msg).toMatch(/drive_read_file/);
  });

  it('names the atom that refused', () => {
    expect(() =>
      assertExpectedAbsent({ id: 'x' }, { ...ctx, atom: 'drive_create_doc_from_markdown' }),
    ).toThrow(/drive_create_doc_from_markdown/);
  });
});
