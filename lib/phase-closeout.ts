/**
 * Phase-closeout deterministic checklist.
 *
 * Single source of truth: `lib/artifact-manifest.ts` declares every artifact
 * each phase is expected to produce, with `required: boolean`. This module
 * turns that declaration into a runtime gate.
 *
 * Two pure functions (`computeExpectedRequiredArtifacts`, `diffArtifacts`)
 * plus one IO-bearing helper (`enumeratePhaseFolder`) that the
 * `verify_phase_artifacts` MCP tool wraps. Pure → trivially unit-testable;
 * IO isolated → mockable.
 *
 * Pairs with the existing `classify_phase_writeback` MCP tool: that one
 * checks whether `run_state.yaml` has the right shape; this one checks
 * whether the per-phase Drive folder has the artifacts the manifest
 * declares required. Both should land in the boundary fence's parallel
 * block so a phase can't slip past either gate.
 *
 * See agents/ace-orchestrator.md § Phase boundary fence for how the
 * orchestrator wires this in.
 */

import { ARTIFACT_MANIFEST, type ArtifactEntry, type Phase } from './artifact-manifest.js';

/**
 * Manifest entries declared for exactly this phase (NOT cumulative across
 * earlier phases — the boundary fence checks one phase at a time). The
 * top-level `artifactsForPhase` helper is cumulative-up-to-phase by design
 * (`validateFixture` uses it that way), which is the wrong shape for
 * closeout: we'd cumulatively re-flag every earlier phase's artifacts as
 * "missing from this phase's folder" forever.
 */
function manifestEntriesForExactPhase(phase: Phase): ArtifactEntry[] {
  return ARTIFACT_MANIFEST.filter((a) => a.phase === phase);
}

export interface MissingArtifact {
  /** Path relative to the run folder, e.g. "4-connect/connect-program-setup-eval_verdict.yaml" */
  path: string;
  /** Skill that should have produced this artifact — what the dispatcher re-runs to heal. */
  producedBy: string;
  /** Human-readable description from the manifest. */
  description: string;
}

export interface PhaseCloseoutReport {
  phase: Phase;
  /** All `required: true` manifest entries are present. */
  ok: boolean;
  /** Required entries the Drive listing did NOT contain. */
  missing: MissingArtifact[];
  /** Count of files actually found under the phase folder (for telemetry). */
  present_count: number;
  /** Count of required entries declared by the manifest for this phase. */
  expected_count: number;
}

/**
 * Match the `<N>-<phase-shorthand>` convention used by the run-folder
 * layout (e.g. `1-design`, `3-commcare`, `7-synthetic`). The closeout
 * only checks artifacts that live under one of those folders — opp-level
 * entries (paths like `inputs/...`, `opp.yaml`, `eval-calibration/...`)
 * are also tagged with a `phase:` value but they sit at the opp root, not
 * under any run folder, so they're out of scope for a per-run boundary
 * gate.
 */
const RUN_LEVEL_PATH = /^\d+-/;

function isRunLevelArtifact(entry: ArtifactEntry): boolean {
  return RUN_LEVEL_PATH.test(entry.path);
}

/**
 * Return every manifest entry for `phase` that the closeout must see
 * after the phase reports done: declared as run-level (under a
 * `<N>-<phase>/` folder) and marked `required: true`. Pure.
 *
 * The drift-checking agent's job is to keep this set honest (skill exists
 * but no manifest entry → drift agent flags; manifest entry but skill is
 * never dispatched → this runtime gate catches at the boundary).
 */
export function computeExpectedRequiredArtifacts(phase: Phase): ArtifactEntry[] {
  return manifestEntriesForExactPhase(phase).filter((a) => a.required && isRunLevelArtifact(a));
}

/**
 * Diff expected vs. present. Pure; takes the already-enumerated
 * present-paths so it's trivial to test without Drive mocking.
 *
 * `presentPaths` should be relative to the run folder, in the same shape
 * as the manifest's `path` field (e.g. "4-connect/connect-program-setup-eval_verdict.yaml").
 */
export function diffArtifacts(
  phase: Phase,
  presentPaths: ReadonlyArray<string>,
): PhaseCloseoutReport {
  const expected = computeExpectedRequiredArtifacts(phase);
  const present = new Set(presentPaths);
  const missing = expected
    .filter((e) => !present.has(e.path))
    .map(({ path, producedBy, description }) => ({ path, producedBy, description }));
  return {
    phase,
    ok: missing.length === 0,
    missing,
    present_count: presentPaths.length,
    expected_count: expected.length,
  };
}

/**
 * Phase → folder-name resolver, derived from the manifest itself so we
 * never hard-code the `<N>-<phase>` convention twice. The first segment
 * of any expected path IS the folder name; if no entries are declared
 * for the phase we fall back to a sensible default.
 *
 * If the manifest grows a phase with zero declared artifacts (the
 * closeout phase, for example, before it's filled in) the resolver
 * returns null and the IO layer should treat that as "nothing to check"
 * — not an error.
 */
export function resolvePhaseFolderName(phase: Phase): string | null {
  const runLevel = manifestEntriesForExactPhase(phase).filter(isRunLevelArtifact);
  if (runLevel.length === 0) return null;
  const segment = runLevel[0].path.split('/')[0];
  return segment || null;
}

/**
 * Adapter the IO helper expects. Lets the MCP tool inject the real Drive
 * client without dragging `googleapis` into pure-function tests.
 */
export interface DriveListAdapter {
  /** List immediate children of `folderId`. Returns id+name+mimeType per entry. */
  listFolder(folderId: string): Promise<
    Array<{ id: string; name: string; mimeType: string }>
  >;
}

const FOLDER_MIMETYPE = 'application/vnd.google-apps.folder';

/**
 * Walk the phase subfolder under `runFolderId` two levels deep and
 * return every file path relative to the run folder. Two levels covers
 * the `<phase>/<file>` and `<phase>/<subfolder>/<file>` cases the
 * manifest currently uses (e.g. `3-commcare/recipes/journey-learn.yaml`).
 *
 * Returns null if the phase folder doesn't exist under `runFolderId`.
 * Callers can treat null as "this phase hasn't been touched yet" — not
 * an error.
 */
export async function enumeratePhaseFolder(
  drive: DriveListAdapter,
  runFolderId: string,
  phase: Phase,
): Promise<string[] | null> {
  const folderName = resolvePhaseFolderName(phase);
  if (!folderName) return [];

  const runChildren = await drive.listFolder(runFolderId);
  const phaseFolder = runChildren.find(
    (c) => c.name === folderName && c.mimeType === FOLDER_MIMETYPE,
  );
  if (!phaseFolder) return null;

  const paths: string[] = [];
  const phaseChildren = await drive.listFolder(phaseFolder.id);
  for (const child of phaseChildren) {
    if (child.mimeType === FOLDER_MIMETYPE) {
      const grandChildren = await drive.listFolder(child.id);
      for (const g of grandChildren) {
        if (g.mimeType !== FOLDER_MIMETYPE) {
          paths.push(`${folderName}/${child.name}/${g.name}`);
        }
      }
    } else {
      paths.push(`${folderName}/${child.name}`);
    }
  }
  return paths;
}

/**
 * End-to-end: enumerate the phase folder and diff against the manifest.
 * If the phase folder doesn't exist yet, every required artifact is
 * reported missing (which is what an unstarted phase should look like
 * to the boundary fence).
 */
export async function verifyPhaseArtifacts(
  drive: DriveListAdapter,
  runFolderId: string,
  phase: Phase,
): Promise<PhaseCloseoutReport> {
  const present = (await enumeratePhaseFolder(drive, runFolderId, phase)) ?? [];
  return diffArtifacts(phase, present);
}
