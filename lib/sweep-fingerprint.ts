/**
 * Pure ACE-fingerprint scoring for Drive folders. Used by the sweep-drive
 * skill after the live-set diff has identified candidate orphans; this module
 * decides high / medium / low confidence so the human can triage in chunks.
 *
 * Per-system fingerprint helpers will be added in subsequent PRs (PR 2 for
 * Connect, PR 3 for OCS, PR 4 for HQ, PR 5 for labs). Each gets its own
 * exported function so the heuristics can be tuned independently.
 */

import type { Confidence, DriveFolderInfo, LiveSet } from './sweep-types';

const CRISPR_PREFIX = /^CRISPR-/i;
const KEBAB_OPP_NAME = /^[a-z][a-z0-9-]{2,39}$/;

export interface ScoreResult {
  confidence: Confidence;
  signals: string[];
}

/**
 * Score a Drive folder. Does NOT do the live-set diff itself — the caller is
 * expected to have already determined this folder is an orphan candidate
 * (i.e. its name does not match an active opp slug). The scorer defensively
 * downgrades to medium if it sees a name that IS in liveSet.oppSlugs in case
 * the caller passed it through.
 */
export function scoreDriveFolder(
  folder: DriveFolderInfo,
  liveSet: LiveSet,
  aceRootFolderId: string,
): ScoreResult {
  const signals: string[] = [];

  if (folder.parentId !== aceRootFolderId) {
    signals.push(`not under ACE root (parent=${folder.parentId})`);
    return { confidence: 'low', signals };
  }

  if (liveSet.oppSlugs.includes(folder.name)) {
    signals.push('name matches an active opp slug');
    return { confidence: 'medium', signals };
  }

  if (CRISPR_PREFIX.test(folder.name)) {
    signals.push('name has CRISPR- prefix (canonical test opp pattern)');
    return { confidence: 'high', signals };
  }

  if (KEBAB_OPP_NAME.test(folder.name)) {
    signals.push('name is kebab-case opp-style (3-40 chars, lowercase)');
    return { confidence: 'high', signals };
  }

  signals.push('under ACE root but does not match a known ACE name pattern');
  return { confidence: 'medium', signals };
}
