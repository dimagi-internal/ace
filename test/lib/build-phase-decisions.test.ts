/**
 * The build phases log their calls as decision rows, and the boundary fence
 * fails a build that did not (dimagi-internal/ace#2384, a regression of #399).
 *
 * The positive control is the measured defect: `poverty-graduation/20260908-0510`
 * shipped 66 decision rows, 0 of them from the app build. Since 2026-10-03 the
 * decisions log is the run's only review artifact (the build memo is retired),
 * so a build producer that ran and wrote no rows is invisible to a reviewer.
 */
import { describe, it, expect } from 'vitest';
import yaml from 'yaml';

import {
  BUILD_PHASE_DECISION_CONTRACTS,
  checkBuildPhaseDecisions,
  decisionRowsFromYaml,
  unreadableBuildPhaseDecisions,
  verifyBuildPhaseDecisions,
  type DriveReadAdapter,
} from '../../lib/build-phase-decisions.js';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';
import { resolvePhaseFolderName } from '../../lib/phase-closeout.js';

const DELIVER = '3-commcare/pdd-to-deliver-app_summary.md';
const LEARN = '3-commcare/pdd-to-learn-app_summary.md';
const OPP = '4-connect/connect-opp-setup.md';

type Row = Record<string, unknown>;
const many = (n: number, phase: string, skill: string, prefix: string, extra: Row = {}): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, phase, skill, plain: 'A plain line.', ...extra }));
const decisionsYaml = (rows: Row[]) =>
  yaml.stringify({ schema_version: 6, opportunity: 'o', run_id: 'r', generated_at: '2026-10-03T00:00:00Z', decisions: rows });

/** The measured register: 66 rows, none from the app build. */
const REGISTER_0510 = [...many(60, '1-design', 'idea-to-pdd', 'd'), ...many(6, '3-commcare', 'app-test-cases', 't')];

describe('checkBuildPhaseDecisions', () => {
  it('fails the measured defect: both builds ran, neither wrote a row (app-test-cases rows do not count)', () => {
    const r = checkBuildPhaseDecisions({ phase: 'commcare', present: { [LEARN]: true, [DELIVER]: true }, decisionsYaml: decisionsYaml(REGISTER_0510) });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.producer)).toEqual(['pdd-to-learn-app', 'pdd-to-deliver-app']);
    expect(r.summary).toMatch(/^FAIL/);
  });

  it('passes once each producer wrote rows under its own skill tag', () => {
    const rows = [...REGISTER_0510, ...many(3, '3-commcare', 'pdd-to-learn-app', 'l'), ...many(2, '3-commcare', 'pdd-to-deliver-app', 'v')];
    const r = checkBuildPhaseDecisions({ phase: 'commcare', present: { [LEARN]: true, [DELIVER]: true }, decisionsYaml: decisionsYaml(rows) });
    expect(r.ok).toBe(true);
    expect(r.producers.map((p) => p.decision_rows)).toEqual([3, 2]);
  });

  it('superseded rows do not count — a producer whose every row is history is silent', () => {
    const rows = many(3, '4-connect', 'connect-opp-setup', 'c', { superseded_by: 'x' });
    const r = checkBuildPhaseDecisions({ phase: 'connect', present: { [OPP]: true }, decisionsYaml: decisionsYaml(rows) });
    expect(r.failures.map((f) => f.producer)).toEqual(['connect-opp-setup']);
  });

  it('a producer whose summary is absent is not judged (missing[] owns that)', () => {
    const r = checkBuildPhaseDecisions({ phase: 'commcare', present: {}, decisionsYaml: decisionsYaml([]) });
    expect(r.ok).toBe(true);
    expect(r.producers.every((p) => p.verdict === 'absent')).toBe(true);
  });

  it('warns on live partner rows without `plain` (schema v6), not on harness rows', () => {
    const rows = [
      ...many(1, '3-commcare', 'pdd-to-deliver-app', 'v', { plain: undefined }),
      { id: 'deliver-smoke-x', phase: '3-commcare', skill: 'pdd-to-deliver-app' },
      ...many(1, '3-commcare', 'pdd-to-learn-app', 'l'),
    ];
    const r = checkBuildPhaseDecisions({ phase: 'commcare', present: { [LEARN]: true, [DELIVER]: true }, decisionsYaml: decisionsYaml(rows) });
    expect(r.ok).toBe(true);
    expect(r.producers[1].missing_plain).toEqual(['v-0']);
    expect(r.warnings.join('\n')).toMatch(/plain/);
  });

  it('an unparseable log fails a ran producer with the parse error named', () => {
    const r = checkBuildPhaseDecisions({ phase: 'connect', present: { [OPP]: true }, decisionsYaml: ': : :\n' });
    expect(r.ok).toBe(false);
  });

  it('throws for a phase with no contract', () => {
    expect(() => checkBuildPhaseDecisions({ phase: 'ocs', present: {}, decisionsYaml: null })).toThrow(/no build-phase contract/);
    expect(unreadableBuildPhaseDecisions('ocs', 'x')).toBeNull();
  });
});

describe('the contract table stays on the paths the manifest uses', () => {
  for (const [phase, contract] of Object.entries(BUILD_PHASE_DECISION_CONTRACTS)) {
    it(`${phase}: the decision phase tag is the phase's run-folder name`, () => {
      expect(contract!.decisionPhaseTag).toBe(resolvePhaseFolderName(contract!.phase));
    });
    for (const { producer, path } of contract!.sources) {
      it(`${phase}: ${path} is a required manifest artifact of ${producer} in that phase`, () => {
        const e = ARTIFACT_MANIFEST.find((a) => a.path === path);
        expect(e, `no manifest entry for ${path}`).toBeDefined();
        expect(e!.producedBy).toBe(producer);
        expect(e!.phase).toBe(contract!.phase);
      });
    }
  }
});

describe('decisionRowsFromYaml', () => {
  it('reads the persisted `decisions:` list, tolerating a BOM from a Doc export', () => {
    const { rows } = decisionRowsFromYaml('﻿' + decisionsYaml(many(2, '3-commcare', 'pdd-to-learn-app', 'l')));
    expect(rows).toHaveLength(2);
  });
  it('a `rows:` top-level key (the atom ARGUMENT, not the file shape — ace#782) is not a log', () => {
    expect(decisionRowsFromYaml('rows: []\n').note).toMatch(/no top-level `decisions:`/);
  });
});

describe('verifyBuildPhaseDecisions — the Drive walk the atom runs', () => {
  const FOLDER = 'application/vnd.google-apps.folder';
  const DOC = 'application/vnd.google-apps.document';

  function fakeDrive(
    folders: Record<string, Array<{ id: string; name: string; mimeType: string }>>,
    texts: Record<string, string>,
  ): DriveReadAdapter {
    return {
      async listFolder(id) {
        return folders[id] ?? [];
      },
      async readText(id) {
        if (!(id in texts)) throw new Error(`unexpected read of ${id}`);
        return texts[id];
      },
    };
  }

  it('finds the summaries (with or without the .md suffix) and decisions.yaml — not decisions.gdoc', async () => {
    const drive = fakeDrive(
      {
        run: [
          { id: 'f3', name: '3-commcare', mimeType: FOLDER },
          { id: 'dy', name: 'decisions.yaml', mimeType: DOC },
          { id: 'dg', name: 'decisions.gdoc', mimeType: DOC },
        ],
        f3: [
          { id: 'ds', name: 'pdd-to-deliver-app_summary.md', mimeType: DOC },
          { id: 'ls', name: 'pdd-to-learn-app_summary', mimeType: DOC },
        ],
      },
      { dy: decisionsYaml(REGISTER_0510) },
    );
    const r = (await verifyBuildPhaseDecisions(drive, 'run', 'commcare'))!;
    expect(r.ok).toBe(false);
    expect(r.producers.map((p) => [p.producer, p.verdict])).toEqual([
      ['pdd-to-learn-app', 'silent'],
      ['pdd-to-deliver-app', 'silent'],
    ]);
  });

  it('a phase folder that does not exist yet reads as absent producers, not a failure', async () => {
    const r = (await verifyBuildPhaseDecisions(fakeDrive({ run: [] }, {}), 'run', 'commcare'))!;
    expect(r.ok).toBe(true);
  });

  it('is null for a phase without a contract, and never touches Drive for it', async () => {
    expect(await verifyBuildPhaseDecisions(fakeDrive({}, {}), 'run', 'design')).toBeNull();
  });

  it('a check that could not read its inputs does not pass', () => {
    const r = unreadableBuildPhaseDecisions('commcare', 'HTTP 503')!;
    expect(r.ok).toBe(false);
    expect(r.unreadable).toBe(true);
    expect(r.summary).toContain('HTTP 503');
  });
});
