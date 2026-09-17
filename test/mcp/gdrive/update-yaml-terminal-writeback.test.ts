/**
 * ace#2174 at the WRITE PATH — `update_yaml_file` refuses to record a phase
 * that claims it finished while its manifest-required artifacts are absent.
 *
 * Why the write path and not the boundary fence: on
 * `poverty-graduation/20260905-1345` the READ-side check was already correct.
 * `verify_phase_artifacts(phase: 'commcare')` returned
 * `ok: false, present_count: 1, expected_count: 10`, and nothing acted on it,
 * because acting on it is prose in `agents/ace-orchestrator.md`. A second
 * read-side report would share that failure mode exactly. So the lie is
 * refused at the moment it would be written.
 *
 * These tests drive `handleUpdateYamlFile` itself — the same function the
 * `update_yaml_file` atom calls — against a fake Drive holding a real run
 * folder tree, so they exercise the guard through the merge loop rather than
 * around it.
 */
import { describe, it, expect, vi } from 'vitest';
import YAML from 'yaml';
import { handleUpdateYamlFile } from '../../../mcp/google-drive-server.js';
import { computeExpectedRequiredArtifacts } from '../../../lib/phase-closeout.js';

const RUN_FOLDER = 'runFolder1';
const PHASE_FOLDER = 'commcareFolder1';
const RECIPES_FOLDER = 'recipesFolder1';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * A fake Drive holding ONE run_state.yaml plus a run-folder tree.
 *
 * `phaseFiles` are names directly under `3-commcare/`; `recipeFiles` are names
 * under `3-commcare/recipes/`, so the two-level walk `enumeratePhaseFolder`
 * performs is genuinely exercised (that walk is what sees
 * `recipes/journey-learn.yaml`, the artifact ace#892 registered).
 */
function makeRunFolderDrive(opts: {
  content: string;
  fileName?: string;
  phaseFiles: string[];
  recipeFiles?: string[];
}) {
  const state = { content: opts.content, version: '1' };
  const fileName = opts.fileName ?? 'run_state.yaml';
  const recipeFiles = opts.recipeFiles ?? [];

  const listFolder = vi.fn(async (req: any) => {
    const q: string = req.q ?? '';
    if (q.includes(`'${RUN_FOLDER}' in parents`)) {
      return {
        data: {
          files: [
            { id: PHASE_FOLDER, name: '3-commcare', mimeType: FOLDER_MIME },
            { id: 'rsFile', name: fileName, mimeType: 'application/vnd.google-apps.document' },
          ],
        },
      };
    }
    if (q.includes(`'${PHASE_FOLDER}' in parents`)) {
      return {
        data: {
          files: [
            ...(recipeFiles.length
              ? [{ id: RECIPES_FOLDER, name: 'recipes', mimeType: FOLDER_MIME }]
              : []),
            ...opts.phaseFiles.map((n, i) => ({
              id: `p${i}`,
              name: n,
              mimeType: 'application/vnd.google-apps.document',
            })),
          ],
        },
      };
    }
    if (q.includes(`'${RECIPES_FOLDER}' in parents`)) {
      return {
        data: {
          files: recipeFiles.map((n, i) => ({
            id: `r${i}`,
            name: n,
            mimeType: 'application/vnd.google-apps.document',
          })),
        },
      };
    }
    return { data: { files: [] } };
  });

  return {
    state,
    listFolder,
    files: {
      get: vi.fn(async (req: any) => {
        if (req.alt === 'media') return { data: state.content };
        return {
          data: {
            mimeType: 'application/vnd.google-apps.document',
            name: fileName,
            version: state.version,
            parents: [RUN_FOLDER],
          },
        };
      }),
      export: vi.fn(async () => ({ data: state.content })),
      list: listFolder,
      update: vi.fn(async (req: any) => {
        const body = req.media?.body;
        state.content = typeof body === 'string' ? body : String(body);
        state.version = String(Number(state.version) + 1);
        return {
          data: {
            id: req.fileId,
            name: fileName,
            modifiedTime: '2026-09-17T00:00:00Z',
            version: state.version,
          },
        };
      }),
    },
  };
}

/** Every `required: true` path for Phase 3, as basenames, split by subfolder. */
function fullCommcareArtifactSet(): { phaseFiles: string[]; recipeFiles: string[] } {
  const phaseFiles: string[] = [];
  const recipeFiles: string[] = [];
  for (const entry of computeExpectedRequiredArtifacts('commcare')) {
    const rel = entry.path.replace(/^3-commcare\//, '');
    if (rel.startsWith('recipes/')) recipeFiles.push(rel.slice('recipes/'.length));
    else phaseFiles.push(rel);
  }
  return { phaseFiles, recipeFiles };
}

const BASE_STATE = YAML.stringify({
  opportunity: 'poverty-graduation',
  run_id: '20260905-1345',
  phases: {
    'commcare-setup': { status: 'in_progress', started_at: '2026-09-06T12:00:00Z' },
  },
});

describe('update_yaml_file: terminal phase write-back artifact gate (ace#2174)', () => {
  it('REFUSES the ace#2174 write — done/pass with 9 of 10 required artifacts absent — and writes nothing', async () => {
    // Drive `3-commcare/` held exactly this one file, and had no `recipes/`.
    const fake = makeRunFolderDrive({
      content: BASE_STATE,
      phaseFiles: ['pdd-to-deliver-app_summary.md'],
    });

    await expect(
      handleUpdateYamlFile(
        {
          fileId: 'rsFile',
          merge: 'deep',
          patch: {
            phases: {
              'commcare-setup': {
                status: 'done',
                verdict: 'pass',
                completed_at: '2026-09-07T13:35:00Z',
                summary_artifact: '3-commcare/pdd-to-deliver-app_summary.md',
              },
            },
          },
        },
        fake as any,
      ),
    ).rejects.toThrow(/PHASE_ARTIFACTS_INCOMPLETE/);

    expect(fake.files.update).not.toHaveBeenCalled();
    expect(YAML.parse(fake.state.content).phases['commcare-setup'].status).toBe('in_progress');
  });

  it('the refusal names the Learn smoke recipe and its producer — the artifact Phase 6 hard-halts without', async () => {
    const fake = makeRunFolderDrive({
      content: BASE_STATE,
      phaseFiles: ['pdd-to-deliver-app_summary.md'],
    });

    await expect(
      handleUpdateYamlFile(
        {
          fileId: 'rsFile',
          merge: 'deep',
          patch: { phases: { 'commcare-setup': { status: 'done', verdict: 'pass' } } },
        },
        fake as any,
      ),
    ).rejects.toThrow(/3-commcare\/recipes\/journey-learn\.yaml \(producedBy: app-test-cases\)/);
  });

  it('ALLOWS `status: partial` on the identical Drive state — the honest write-back is never blocked', async () => {
    const fake = makeRunFolderDrive({
      content: BASE_STATE,
      phaseFiles: ['pdd-to-deliver-app_summary.md'],
    });

    await handleUpdateYamlFile(
      {
        fileId: 'rsFile',
        merge: 'deep',
        patch: {
          phases: {
            'commcare-setup': {
              status: 'partial',
              verdict: 'partial-producer-deferred',
              status_note: 'app-test-cases did not run; no smoke recipes shipped.',
            },
          },
        },
      },
      fake as any,
    );

    expect(fake.files.update).toHaveBeenCalledTimes(1);
    expect(YAML.parse(fake.state.content).phases['commcare-setup'].status).toBe('partial');
  });

  it('ALLOWS `status: done` once every required artifact is present', async () => {
    const { phaseFiles, recipeFiles } = fullCommcareArtifactSet();
    const fake = makeRunFolderDrive({ content: BASE_STATE, phaseFiles, recipeFiles });

    await handleUpdateYamlFile(
      {
        fileId: 'rsFile',
        merge: 'deep',
        patch: { phases: { 'commcare-setup': { status: 'done', verdict: 'pass' } } },
      },
      fake as any,
    );

    expect(fake.files.update).toHaveBeenCalledTimes(1);
    expect(YAML.parse(fake.state.content).phases['commcare-setup'].status).toBe('done');
  });

  it('does not gate a non-terminal write — an in_progress patch spends zero folder listings', async () => {
    const fake = makeRunFolderDrive({ content: BASE_STATE, phaseFiles: [] });

    await handleUpdateYamlFile(
      {
        fileId: 'rsFile',
        merge: 'deep',
        patch: { phases: { 'commcare-setup': { status: 'in_progress' } } },
      },
      fake as any,
    );

    expect(fake.files.update).toHaveBeenCalledTimes(1);
    expect(fake.listFolder).not.toHaveBeenCalled();
  });

  it('does not gate a file that is not a run_state.yaml', async () => {
    const fake = makeRunFolderDrive({
      content: YAML.stringify({ phases: { 'commcare-setup': { status: 'pending' } } }),
      fileName: 'run_state.backup.yaml',
      phaseFiles: [],
    });

    await handleUpdateYamlFile(
      {
        fileId: 'rsFile',
        merge: 'deep',
        patch: { phases: { 'commcare-setup': { status: 'done' } } },
      },
      fake as any,
    );

    expect(fake.files.update).toHaveBeenCalledTimes(1);
  });

  it('a Drive listing failure is a PASS, not a refusal — a hiccup must not strand a finished phase', async () => {
    const fake = makeRunFolderDrive({ content: BASE_STATE, phaseFiles: [] });
    fake.files.list = vi.fn(async () => {
      throw new Error('backendError: transient');
    }) as any;

    await handleUpdateYamlFile(
      {
        fileId: 'rsFile',
        merge: 'deep',
        patch: { phases: { 'commcare-setup': { status: 'done', verdict: 'pass' } } },
      },
      fake as any,
    );

    expect(fake.files.update).toHaveBeenCalledTimes(1);
  });

  it('honours a mode already on the document, not just one carried in the patch (ace#1069)', async () => {
    // Phase 6 in `app-QA-only`: the eleven training artifacts are not required,
    // so the ONLY required entries left are app-screenshot-capture's two
    // verdicts. A guard reading the patch alone would miss the mode and refuse.
    const content = YAML.stringify({
      phases: {
        'qa-and-training': { status: 'in_progress', mode: 'app-QA-only' },
      },
    });
    const state = { content, version: '1' };
    const files = {
      get: vi.fn(async (req: any) => {
        if (req.alt === 'media') return { data: state.content };
        return {
          data: {
            mimeType: 'application/vnd.google-apps.document',
            name: 'run_state.yaml',
            version: state.version,
            parents: [RUN_FOLDER],
          },
        };
      }),
      export: vi.fn(async () => ({ data: state.content })),
      list: vi.fn(async (req: any) => {
        const q: string = req.q ?? '';
        if (q.includes(`'${RUN_FOLDER}' in parents`)) {
          return {
            data: {
              files: [{ id: 'qaFolder', name: '6-qa-and-training', mimeType: FOLDER_MIME }],
            },
          };
        }
        if (q.includes("'qaFolder' in parents")) {
          return {
            data: {
              files: [
                'app-screenshot-capture_verdict-shallow.yaml',
                'app-screenshot-capture_verdict.yaml',
              ].map((n, i) => ({
                id: `q${i}`,
                name: n,
                mimeType: 'application/vnd.google-apps.document',
              })),
            },
          };
        }
        return { data: { files: [] } };
      }),
      update: vi.fn(async (req: any) => {
        const body = req.media?.body;
        state.content = typeof body === 'string' ? body : String(body);
        state.version = String(Number(state.version) + 1);
        return { data: { id: req.fileId, name: 'run_state.yaml', modifiedTime: 'x', version: state.version } };
      }),
    };

    await handleUpdateYamlFile(
      {
        fileId: 'rsFile',
        merge: 'deep',
        patch: { phases: { 'qa-and-training': { status: 'done', verdict: 'proceed' } } },
      },
      { files } as any,
    );

    expect(files.update).toHaveBeenCalledTimes(1);
  });
});
