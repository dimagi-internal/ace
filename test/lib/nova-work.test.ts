/**
 * lib/nova-work.ts — the private-work lifecycle (voidcraft-labs/commcare-nova#693, ace#2526).
 *
 * Every response shape below is VERBATIM from a live run against
 * mcp.commcare.app on 2026-09-28 (throwaway app "ACE probe work-lifecycle",
 * deleted afterwards), trimmed only of fields the code does not read.
 */
import { describe, it, expect } from 'vitest';
import { NovaWork, classifySaveResult, refusalOf, newRequestId } from '../../lib/nova-work.js';

const SAVED = {
  app_id: '1e1f5c59-aed9-46fa-bebe-0bb2e60a2dc4',
  saved: true,
  work_id: 'd7a8fa76-aced-470a-9359-a9b4f9b014b7',
  batchId: 'genesis:1e1f5c59-aed9-46fa-bebe-0bb2e60a2dc4',
  success: true,
  revision: null,
  saved_revision: 1,
};
const STALE = {
  kind: 'stale-base',
  saved: false,
  baseSeq: 1,
  message:
    'The saved app changed after this work began. Your pending work is preserved. Inspect it, then discard and restart from the current app.',
  success: false,
  currentSeq: 2,
};
const STAGED = {
  ok: true,
  saved: false,
  work_id: 'd7a8fa76-aced-470a-9359-a9b4f9b014b7',
  revision: 'e1106e97-03f8-405e-b06d-6953b93c7b17:4',
  diagnostics: { canCommit: true, findingCount: 0 },
};
const REFERENCED = {
  code: 'referenced',
  error: 'One or more apps still reference this lookup resource.',
  blockingApps: [{ appId: '1e1f5c59-aed9-46fa-bebe-0bb2e60a2dc4', deleted: false }],
};

describe('classifySaveResult', () => {
  it('a real save', () => {
    expect(classifySaveResult(SAVED)).toEqual({ kind: 'saved', appId: SAVED.app_id, savedRevision: 1 });
  });

  it('a stale-base refusal — returned as DATA, no isError — is not a save', () => {
    expect(classifySaveResult(STALE)).toEqual({ kind: 'stale', message: STALE.message });
  });

  it('a staged mutation receipt is not a save, even though ok:true', () => {
    expect(classifySaveResult(STAGED).kind).toBe('refused');
  });

  it('garbage is not a save', () => {
    expect(classifySaveResult(undefined).kind).toBe('refused');
    expect(classifySaveResult({ saved: true }).kind).toBe('refused'); // no app_id
  });
});

describe('refusalOf', () => {
  it('names refusals Nova returns as data', () => {
    expect(refusalOf(STALE)).toMatch(/saved app changed/);
    expect(refusalOf(REFERENCED)).toMatch(/^referenced:/);
  });

  it('passes a staged receipt and a save', () => {
    expect(refusalOf(STAGED)).toBeNull();
    expect(refusalOf(SAVED)).toBeNull();
  });
});

describe('newRequestId', () => {
  it('is unique per call — a reused id with changed input is refused upstream', () => {
    expect(newRequestId('x')).not.toBe(newRequestId('x'));
  });
});

/** A fake Nova that mimics the observed lifecycle. */
function fakeNova(opts: { staleOnSave?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let seq = 0;
  let revision: string | null = null;
  const call = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    switch (name) {
      case 'begin_work':
        return { work_id: 'W', project_id: 'P', app_id: (args.app_id as string) ?? null };
      case 'get_work':
        return { work_id: 'W', revision, pending_changes: revision ? 1 : 0, stale: !!opts.staleOnSave };
      case 'save_work':
        if (args.expected_revision !== revision) {
          throw new Error('Nova save_work rejected the call: Read the work and use its current revision');
        }
        if (opts.staleOnSave) return STALE;
        revision = null;
        return SAVED;
      case 'discard_work':
        revision = null;
        return { success: true, discarded: true };
      default:
        revision = `R:${++seq}`;
        return { ...STAGED, revision };
    }
  };
  return { call, calls };
}

describe('NovaWork', () => {
  it('stages with work_id + a fresh request_id, then saves with the latest revision', async () => {
    const nova = fakeNova();
    const w = await NovaWork.begin({ newApp: { name: 'x' } }, { call: nova.call });
    await w.stage('create_module', { name: 'M' });
    await w.stage('create_form', { moduleUuid: 'M', name: 'F', type: 'survey' });
    const out = await w.save();
    expect(out).toMatchObject({ kind: 'saved', appId: SAVED.app_id });
    expect(w.appId).toBe(SAVED.app_id);

    const staged = nova.calls.filter((c) => c.name.startsWith('create_'));
    for (const c of staged) {
      expect(c.args.work_id).toBe('W');
      expect(typeof c.args.request_id).toBe('string');
    }
    expect(staged[0].args.request_id).not.toBe(staged[1].args.request_id);
    expect(nova.calls.find((c) => c.name === 'save_work')!.args.expected_revision).toBe('R:2');
  });

  it('begin on an existing app passes app_id; new_app carries project_id only when given', async () => {
    const nova = fakeNova();
    await NovaWork.begin({ appId: 'A' }, { call: nova.call });
    await NovaWork.begin({ newApp: { name: 'n', projectId: 'P' } }, { call: nova.call });
    await NovaWork.begin({ newApp: { name: 'n' } }, { call: nova.call });
    const begins = nova.calls.filter((c) => c.name === 'begin_work').map((c) => c.args);
    expect(begins[0].app_id).toBe('A');
    expect(begins[1].new_app).toEqual({ name: 'n', project_id: 'P' });
    expect(begins[2].new_app).toEqual({ name: 'n' });
  });

  it('refuses to stage a mutation that still carries app_id', async () => {
    const nova = fakeNova();
    const w = await NovaWork.begin({ appId: 'A' }, { call: nova.call });
    await expect(w.stage('add_fields', { app_id: 'A', formUuid: 'F', fields: [] })).rejects.toThrow(/work_id, not app_id/);
  });

  it('THROWS on a stale save rather than reporting success', async () => {
    const nova = fakeNova({ staleOnSave: true });
    const w = await NovaWork.begin({ appId: 'A' }, { call: nova.call });
    await w.stage('edit_field', { fieldUuid: 'f', updates: { label: 'x' } });
    await expect(w.save()).rejects.toThrow(/stale/);
  });

  it('save with nothing pending is a no-op, not a call', async () => {
    const nova = fakeNova();
    const w = await NovaWork.begin({ appId: 'A' }, { call: nova.call });
    expect(await w.save()).toEqual({ kind: 'nothing-pending' });
    expect(nova.calls.some((c) => c.name === 'save_work')).toBe(false);
  });

  it('a refusal returned as data from a stage() throws', async () => {
    const call = async (name: string) => (name === 'begin_work' ? { work_id: 'W' } : REFERENCED);
    const w = await NovaWork.begin({ appId: 'A' }, { call });
    await expect(w.stage('remove_lookup_table', { tableId: 't', expectedTableRevision: '1' })).rejects.toThrow(
      /referenced/,
    );
  });
});
