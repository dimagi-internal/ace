import { describe, it, expect } from 'vitest';
import {
  computeExpectedRequiredArtifacts,
  diffArtifacts,
  enumeratePhaseFolder,
  resolvePhaseFolderName,
  verifyPhaseArtifacts,
  type DriveListAdapter,
} from '../../lib/phase-closeout.js';

// A stub DriveListAdapter built from a flat description of the test
// fixture. `folders` maps a folderId to its immediate children (each
// child carries an id + name + mimeType). Constructing one of these
// per test keeps the assertion easy to read: "given this Drive tree,
// the closeout sees X missing."
function fakeDrive(
  folders: Record<string, Array<{ id: string; name: string; mimeType: string }>>,
): DriveListAdapter {
  return {
    async listFolder(folderId: string) {
      return folders[folderId] ?? [];
    },
  };
}

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

describe('resolvePhaseFolderName', () => {
  it('reads the folder name from the first manifest entry for that phase', () => {
    expect(resolvePhaseFolderName('design')).toBe('1-design');
    expect(resolvePhaseFolderName('commcare')).toBe('3-commcare');
    expect(resolvePhaseFolderName('connect')).toBe('4-connect');
    expect(resolvePhaseFolderName('synthetic-data-and-workflows')).toBe('7-synthetic');
  });
});

describe('computeExpectedRequiredArtifacts', () => {
  it('returns only entries flagged required: true', () => {
    const required = computeExpectedRequiredArtifacts('design');
    // All manifest entries we hand back must be required.
    for (const e of required) expect(e.required).toBe(true);
    // And the design phase must declare at least the canonical PDD.
    const paths = required.map((e) => e.path);
    expect(paths).toContain('1-design/idea-to-pdd.md');
  });

  it('does NOT include required: false manifest entries', () => {
    const required = computeExpectedRequiredArtifacts('connect');
    const paths = required.map((e) => e.path);
    // The verdict YAML lives in the manifest but is currently required: false
    // (PR-2 in this series flips it). This test pins the *contract* of the
    // helper — required: false entries are excluded — not the current
    // required-flag state, so it stays green across the required-bump PR.
    for (const e of required) expect(e.required).toBe(true);
    // Spot-check: the program-setup product file IS required.
    expect(paths).toContain('4-connect/connect-program-setup.md');
  });
});

describe('diffArtifacts (pure)', () => {
  it('returns ok=true when every required path is present', () => {
    const expected = computeExpectedRequiredArtifacts('design').map((e) => e.path);
    const report = diffArtifacts('design', expected);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.expected_count).toBe(expected.length);
  });

  it('flags missing entries with producedBy so the dispatcher knows what to re-run', () => {
    const expected = computeExpectedRequiredArtifacts('design');
    // Drop the first required artifact from the present set.
    const present = expected.slice(1).map((e) => e.path);
    const report = diffArtifacts('design', present);
    expect(report.ok).toBe(false);
    expect(report.missing).toHaveLength(1);
    expect(report.missing[0].path).toBe(expected[0].path);
    expect(report.missing[0].producedBy).toBe(expected[0].producedBy);
    expect(report.missing[0].description).toBe(expected[0].description);
  });

  it('treats an empty Drive folder as every required artifact missing', () => {
    const expected = computeExpectedRequiredArtifacts('design');
    const report = diffArtifacts('design', []);
    expect(report.ok).toBe(false);
    expect(report.missing).toHaveLength(expected.length);
  });

  it('ignores unexpected files in the Drive folder (manifest is the contract)', () => {
    const expected = computeExpectedRequiredArtifacts('design').map((e) => e.path);
    const present = [...expected, '1-design/some-orphan-debug-output.md'];
    const report = diffArtifacts('design', present);
    expect(report.ok).toBe(true);
    expect(report.present_count).toBe(expected.length + 1);
  });
});

describe('enumeratePhaseFolder', () => {
  it('returns paths relative to the run folder for the phase subfolder', async () => {
    const drive = fakeDrive({
      runRoot: [{ id: 'phaseId', name: '1-design', mimeType: FOLDER }],
      phaseId: [
        { id: 'pdd', name: 'idea-to-pdd.md', mimeType: DOC },
        { id: 'wo', name: 'pdd-to-work-order.gdoc', mimeType: DOC },
      ],
    });
    const paths = await enumeratePhaseFolder(drive, 'runRoot', 'design');
    expect(paths).toEqual([
      '1-design/idea-to-pdd.md',
      '1-design/pdd-to-work-order.gdoc',
    ]);
  });

  it('walks one level of subfolders so manifest paths like recipes/X.yaml are seen', async () => {
    const drive = fakeDrive({
      runRoot: [{ id: 'phaseId', name: '3-commcare', mimeType: FOLDER }],
      phaseId: [
        { id: 'summary', name: 'commcare-setup_summary.md', mimeType: DOC },
        { id: 'recipesFolder', name: 'recipes', mimeType: FOLDER },
      ],
      recipesFolder: [
        { id: 'j1', name: 'J1.yaml', mimeType: DOC },
        { id: 'j2', name: 'J2.yaml', mimeType: DOC },
      ],
    });
    const paths = await enumeratePhaseFolder(drive, 'runRoot', 'commcare');
    expect(paths).toEqual([
      '3-commcare/commcare-setup_summary.md',
      '3-commcare/recipes/J1.yaml',
      '3-commcare/recipes/J2.yaml',
    ]);
  });

  it('returns null when the phase folder does not exist (phase never started)', async () => {
    const drive = fakeDrive({ runRoot: [] });
    const paths = await enumeratePhaseFolder(drive, 'runRoot', 'connect');
    expect(paths).toBeNull();
  });
});

describe('verifyPhaseArtifacts (integration of enumerate + diff)', () => {
  it('reports ok when every required manifest entry is present in Drive', async () => {
    const required = computeExpectedRequiredArtifacts('design');
    const children = required.map((e, i) => ({
      id: `f${i}`,
      // path is "1-design/<basename>"; we want just the basename here.
      name: e.path.slice('1-design/'.length),
      mimeType: DOC,
    }));
    const drive = fakeDrive({
      runRoot: [{ id: 'phaseId', name: '1-design', mimeType: FOLDER }],
      phaseId: children,
    });
    const report = await verifyPhaseArtifacts(drive, 'runRoot', 'design');
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('reports every required entry as missing when the phase folder is absent', async () => {
    const drive = fakeDrive({ runRoot: [] });
    const report = await verifyPhaseArtifacts(drive, 'runRoot', 'design');
    const expected = computeExpectedRequiredArtifacts('design');
    expect(report.ok).toBe(false);
    expect(report.missing).toHaveLength(expected.length);
    // The producedBy field is the heal hint — make sure it survives the
    // round trip from manifest -> report.
    for (const m of report.missing) expect(m.producedBy).toBeTruthy();
  });

  it('reports just the gap when some required entries are present and some are not', async () => {
    const required = computeExpectedRequiredArtifacts('design');
    // Present only the first required entry; the rest are missing.
    const drive = fakeDrive({
      runRoot: [{ id: 'phaseId', name: '1-design', mimeType: FOLDER }],
      phaseId: [
        {
          id: 'one',
          name: required[0].path.slice('1-design/'.length),
          mimeType: DOC,
        },
      ],
    });
    const report = await verifyPhaseArtifacts(drive, 'runRoot', 'design');
    expect(report.ok).toBe(false);
    expect(report.missing).toHaveLength(required.length - 1);
    const missingPaths = report.missing.map((m) => m.path);
    expect(missingPaths).not.toContain(required[0].path);
  });
});
