import { describe, it, expect, vi } from 'vitest';

import { handleUpdateYamlFile } from '../../../mcp/google-drive-server.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#992 — the write-time half.
//
// PR #1151 closed the READ-time inconsistency: `complete` is now a documented
// legacy synonym in PHASE_STATUSES, TERMINAL_OK_STATUSES and
// LEGACY_STATUS_SYNONYMS, locked together by phase-status-vocabulary.test.ts.
//
// What stayed open is what the reporter actually asked for: nothing stops a
// NOVEL spelling from landing on Drive in the first place. The validator
// catches it on read, by which point the bad value is already persisted and
// surfaces as a coarse `malformed`.
//
// The guard is UNCONDITIONAL, not opt-in via validateAs — the agent that does
// not know the enum is exactly the agent that would not pass the flag.
// ---------------------------------------------------------------------------

/**
 * Same in-memory Drive fake as update-yaml-file.test.ts. `update` is exposed
 * so the rejection cases can assert NO write happened — the guard must run
 * before any Drive I/O, exactly as INVALID_PHASE_PRODUCTS does.
 */
function driveStub(initial = 'phases: {}\n') {
  const state = { content: initial, version: '1' };
  const update = vi.fn(async (req: any) => {
    state.content = String(req.media?.body ?? '');
    state.version = String(Number(state.version) + 1);
    return { data: { id: req.fileId, name: 'state.yaml', version: state.version } };
  });
  return {
    update,
    state,
    drive: {
      files: {
        get: vi.fn(async (req: any) =>
          req.alt === 'media'
            ? { data: state.content }
            : {
                data: {
                  mimeType: 'application/vnd.google-apps.document',
                  name: 'state.yaml',
                  version: state.version,
                },
              },
        ),
        export: vi.fn(async () => ({ data: state.content })),
        update,
      },
    } as never,
  };
}

describe('update_yaml_file — write-time phase-status guard (#992)', () => {
  it('THE REGRESSION: a novel phase status is REJECTED, and nothing is written', async () => {
    const { drive, update } = driveStub();
    await expect(
      handleUpdateYamlFile(
        { fileId: 'f1', patch: { phases: { 'idea-to-design': { status: 'complete_' } } } },
        drive,
      ),
    ).rejects.toThrow(/INVALID_PHASE_STATUS/);
    // No Drive write on rejection — the same contract INVALID_PHASE_PRODUCTS
    // already holds in this function.
    expect(update).not.toHaveBeenCalled();
  });

  it('the error names the legal enum and the canonical spelling', async () => {
    const { drive } = driveStub();
    // A typed refusal, not an interactive prompt: an autonomous run reads the
    // enum out of the message and retries in the same turn.
    await expect(
      handleUpdateYamlFile(
        { fileId: 'f1', patch: { phases: { x: { status: 'finished' } } } },
        drive,
      ),
    ).rejects.toThrow(/Legal values:.*\bdone\b/s);
  });

  it('ACCEPTS the legacy synonym — rejecting it would re-open #992 from the other side', async () => {
    // #1151 deliberately made `complete` legal so an older run does not
    // classify as malformed. The guard must not undo that.
    const { drive } = driveStub();
    await expect(
      handleUpdateYamlFile(
        { fileId: 'f1', patch: { phases: { 'idea-to-design': { status: 'complete' } } } },
        drive,
      ),
    ).resolves.toBeDefined();
  });

  it('accepts every canonical phase status', async () => {
    for (const status of ['done', 'in_progress', 'blocked', 'partial', 'skipped']) {
      const { drive } = driveStub();
      await expect(
        handleUpdateYamlFile({ fileId: 'f1', patch: { phases: { p: { status } } } }, drive),
      ).resolves.toBeDefined();
    }
  });

  it('a novel STEP status warns rather than rejecting', async () => {
    // Blast radius: failing an entire N-step write-back over one step word
    // costs more than the slip, and STEP_STATUSES is the looser vocabulary.
    const { drive } = driveStub();
    await expect(
      handleUpdateYamlFile(
        {
          fileId: 'f1',
          patch: { phases: { p: { status: 'done', steps: { s: { status: 'finished' } } } } },
        },
        drive,
      ),
    ).resolves.toBeDefined();
  });

  it('is a NO-OP on a patch with no phases key', async () => {
    // opp.yaml, iterate state, decisions — the guard must not touch them.
    const { drive } = driveStub();
    await expect(
      handleUpdateYamlFile({ fileId: 'f1', patch: { connect: { program: { id: 'x' } } } }, drive),
    ).resolves.toBeDefined();
  });

  it('is merge-mode agnostic — a deep nested patch is guarded too', async () => {
    // `deep`, `two-level` and `shallow` all carry status at the same path,
    // because the guard reads the PATCH rather than the merged result.
    const { drive, update } = driveStub();
    await expect(
      handleUpdateYamlFile(
        { fileId: 'f1', patch: { phases: { p: { status: 'bogus' } } }, merge: 'deep' },
        drive,
      ),
    ).rejects.toThrow(/INVALID_PHASE_STATUS/);
    expect(update).not.toHaveBeenCalled();
  });

  it('tolerates a malformed phase block without throwing something unrelated', async () => {
    const { drive } = driveStub();
    await expect(
      handleUpdateYamlFile({ fileId: 'f1', patch: { phases: { p: null } } }, drive),
    ).resolves.toBeDefined();
  });
});
