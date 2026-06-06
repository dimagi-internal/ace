/**
 * Tests for the canonical phase-identity source of truth in
 * `lib/artifact-manifest.ts` (jjackson/ace#637 follow-up). PHASE_DEFS is
 * the single place the (agentName ↔ key ↔ folder ↔ ordinal) relationship
 * lives; these tests pin the derivations + the invariant that the
 * declared `folder` matches the real manifest path prefixes.
 */

import { describe, it, expect } from 'vitest';
import {
  ARTIFACT_MANIFEST,
  PHASES,
  PHASE_DEFS,
  normalizePhaseKey,
  phaseFolder,
  phaseAgentName,
  isPhaseKey,
} from '../../lib/artifact-manifest.js';

describe('PHASE_DEFS canonical phase identity (#637)', () => {
  it('PHASES is derived from PHASE_DEFS in order', () => {
    expect(PHASES).toEqual(PHASE_DEFS.map((p) => p.key));
  });

  it('ordinals are 1..N contiguous in declaration order', () => {
    expect(PHASE_DEFS.map((p) => p.ordinal)).toEqual(
      PHASE_DEFS.map((_, i) => i + 1),
    );
  });

  it('keys and agentNames are each unique; ACE-opp folders are unique (partnership phases may share)', () => {
    // keys and agentNames must be globally unique — no two phases can have the
    // same canonical identifier or agent-dispatch name.
    for (const field of ['key', 'agentName'] as const) {
      const vals = PHASE_DEFS.map((p) => p[field]);
      expect(new Set(vals).size, `${field} must be unique`).toBe(vals.length);
    }
    // Folders are unique within the ACE Connect-opp pipeline (ordinals 1–10).
    // The partnership-video pipeline (ordinals 11+) intentionally shares
    // '2-research/' between partnership-research and partnership-angles — both
    // phases write QA/eval artifacts into the same research folder.
    const oppPhaseFolders = PHASE_DEFS.filter((p) => p.ordinal <= 10).map((p) => p.folder);
    expect(new Set(oppPhaseFolders).size, 'ACE-opp phase folders must be unique').toBe(oppPhaseFolders.length);
  });

  it('normalizePhaseKey resolves BOTH key-spaces and rejects unknowns', () => {
    for (const p of PHASE_DEFS) {
      expect(normalizePhaseKey(p.key)).toBe(p.key); // short key → itself
      expect(normalizePhaseKey(p.agentName)).toBe(p.key); // agent name → key
    }
    expect(normalizePhaseKey('not-a-phase')).toBeUndefined();
  });

  it('the 5 phases where agentName != key are exactly the historically-broken set', () => {
    const differ = PHASE_DEFS.filter((p) => p.agentName !== p.key).map((p) => p.key);
    expect(new Set(differ)).toEqual(
      new Set(['design', 'commcare', 'connect', 'ocs', 'execution-management']),
    );
  });

  it('phaseFolder / phaseAgentName / isPhaseKey are consistent with PHASE_DEFS', () => {
    for (const p of PHASE_DEFS) {
      expect(phaseFolder(p.key)).toBe(p.folder);
      expect(phaseAgentName(p.key)).toBe(p.agentName);
      expect(isPhaseKey(p.key)).toBe(true);
      expect(isPhaseKey(p.agentName)).toBe(p.agentName === p.key); // agentName isn't a key unless they coincide
    }
  });

  it('INVARIANT: every run-folder manifest artifact lives under its phase folder', () => {
    // Run-folder artifacts have an `N-...` first path segment; opp-level
    // ones (inputs/, opp.yaml, decisions.*, run_state.yaml, README.md,
    // open-questions.md, …) do not and are exempt.
    for (const entry of ARTIFACT_MANIFEST) {
      const firstSeg = entry.path.split('/')[0];
      if (!/^\d+-/.test(firstSeg)) continue;
      expect(
        firstSeg,
        `${entry.path} (phase=${entry.phase}) should sit under ${phaseFolder(entry.phase)}`,
      ).toBe(phaseFolder(entry.phase));
    }
  });
});
