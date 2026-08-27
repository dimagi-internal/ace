/**
 * Cycles in the declared artifact dataflow must be declared, with their cut.
 *
 * ## Why this exists
 *
 * `lib/artifact-manifest.ts` is ACE's dataflow graph: each artifact names who
 * produces it and who consumes it. Phases run in `phase_ordinal` order, so an
 * edge pointing from a later phase back to an earlier one means the consumer
 * runs before its input exists.
 *
 * There are two very different reasons that happens, and telling them apart is
 * the whole point of this file:
 *
 *  - **A one-way backward edge** is an ORDERING mistake. Move the consumer after
 *    the producer and it's fixed.
 *  - **A cycle** cannot be sorted at all. Reordering only swaps which half
 *    breaks. It has to be CUT — run one side, then the other, then close the
 *    loop — or the node has to be split along its real dependency seam.
 *
 * ACE HAD one between Phase 5 (OCS) and Phase 6 (training), mis-diagnosed as the
 * first kind for months **because the manifest only declared half of it.** It is
 * gone as of 0.13.1028 — not cut, REMOVED, by splitting `ocs-agent-setup` at its
 * real dependency seam: Phase 5 creates and publishes the bot, Phase 6's
 * `ocs-knowledge-refresh` populates its knowledge base. That is the better
 * resolution when a cycle exists only because one node bundles two jobs with
 * different inputs. Cutting a cycle leaves a corrective second pass; splitting
 * the node leaves a plain DAG. Prefer the split when the seam is real. The `qa-and-training -> ocs` direction was there (the
 * training docs feed the chatbot's RAG collection); the `ocs -> qa-and-training`
 * direction was not (the guides embed the chatbot's widget_url), even though
 * `agents/qa-and-training.md` says so in prose. A graph missing half a cycle
 * doesn't look like a hard problem — it looks like a solvable ordering bug, and
 * "just reorder it" is the reasonable, wrong conclusion. Both directions are
 * declared as of 0.13.1026.
 *
 * So: cycles are allowed, but each one must be written down here together with
 * how it is cut. An undeclared cycle fails.
 */

import { describe, it, expect } from 'vitest';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';


/**
 * Known cycles, keyed by their phase pair, with the cut that makes them safe.
 * Adding an entry is a design decision — say how the loop is closed.
 */
const DECLARED_CYCLES: Record<string, string> = {
  'commcare<->connect':
    'Phase 3 deploys the apps, which Phase 4 needs to wire deliver units; ' +
    "`app-release-eval` (Phase 3) can additionally confirm enumeration against " +
    'Phase 4\'s live Connect state. CUT — and cut WELL, which is why it never ' +
    'caused a defect: the backward edge is an OPTIONAL upgrade on later passes ' +
    '(`4-connect/connect-opp-setup.md`, "optional, later passes only"), and the ' +
    'dimension has a first-class evidence path that is always available without ' +
    'Phase 4 — the `?latest=release` CCZ projection, the literal artifact ' +
    "Connect's Sync Deliver Units consumes. ace#1010 makes it explicit: do NOT " +
    'return unverifiable just because Phase 4 has not run.\n\n' +
    'Worth contrasting with the OCS cycle above, which had the same shape and no ' +
    'cut: a tolerant read, no alternative evidence path, and no second pass — so ' +
    'the missing input silently degraded the product instead of being an ' +
    'acknowledged optional upgrade. Same structure, opposite outcome.',
};

/**
 * Phase-level edges between single-phase producers.
 *
 * Read from the TYPED export rather than re-parsed out of the file's text. The
 * first version of this test regex-scraped `lib/artifact-manifest.ts` with a
 * lazy multi-line pattern that could slurp across entry boundaries and invent
 * an edge — an odd way to guard a graph whose whole problem was saying things
 * that were not true. `ARTIFACT_MANIFEST` is exported and typed; use it.
 *
 * Producers spanning several phases (`external`, `ace-orchestrator`) are
 * dropped: a cross-phase edge through them is an artifact of the aggregation,
 * not a real dependency.
 */
function phaseEdges(): Set<string> {
  const producerPhases = new Map<string, Set<string>>();
  for (const e of ARTIFACT_MANIFEST) {
    if (!producerPhases.has(e.producedBy)) producerPhases.set(e.producedBy, new Set());
    producerPhases.get(e.producedBy)!.add(e.phase);
  }
  const singlePhase = new Map(
    [...producerPhases]
      .filter(([n, ps]) => ps.size === 1 && n !== 'external' && n !== 'ace-orchestrator')
      .map(([n, ps]) => [n, [...ps][0]] as const),
  );

  const edges = new Set<string>();
  for (const e of ARTIFACT_MANIFEST) {
    if (!singlePhase.has(e.producedBy)) continue;
    for (const c of e.consumedBy) {
      const cp = singlePhase.get(c);
      if (cp && cp !== e.phase) edges.add(`${e.phase}->${cp}`);
    }
  }
  return edges;
}

/** Every phase pair with edges in BOTH directions, keyed `a<->b` (sorted). */
function cycles(): Set<string> {
  const edges = phaseEdges();
  const out = new Set<string>();
  for (const edge of edges) {
    const [a, b] = edge.split('->');
    if (edges.has(`${b}->${a}`)) out.add([a, b].sort().join('<->'));
  }
  return out;
}

describe('artifact dataflow cycles', () => {
  it('parses the manifest', () => {
    expect(ARTIFACT_MANIFEST.length, 'manifest is empty — nothing is being checked').toBeGreaterThan(
      100,
    );
    // An empty edge set passes the cycle assertion while checking nothing.
    expect(
      phaseEdges().size,
      'no cross-phase edges derived — the phase/producer aggregation is broken, not the repo',
    ).toBeGreaterThan(5);
  });

  it('declares every phase-level cycle, with its cut', () => {
    const undeclared = [...cycles()].filter((c) => !(c in DECLARED_CYCLES));
    expect(
      undeclared,
      'Undeclared cycle(s) in the artifact dataflow. A cycle cannot be fixed by\n' +
        'reordering phases — reordering only swaps which side is broken. Either cut\n' +
        'the loop (two passes), split the node along its real dependency seam, or drop\n' +
        'one edge. Then declare it in DECLARED_CYCLES with the cut you chose.\n\n  ' +
        undeclared.join('\n  '),
    ).toEqual([]);
  });

  it('keeps DECLARED_CYCLES honest — every declared cycle still exists', () => {
    // This assertion used to check only that the two PHASE NAMES appeared
    // somewhere in the manifest file, which is always true — so it passed for
    // a cycle that no longer existed, which is precisely the thing it warns
    // about one line up. 0.13.1028 deleted `ocs<->qa-and-training` by hand
    // after splitting `ocs-agent-setup`; had it not, nothing here would have
    // said so. It now recomputes.
    const live = cycles();
    const stale = Object.keys(DECLARED_CYCLES).filter((k) => !live.has(k));
    expect(
      stale,
      'DECLARED_CYCLES names cycles that no longer exist in the manifest. A stale\n' +
        'entry silently licenses a FUTURE cycle between the same two phases — the\n' +
        'undeclared-cycle check above would wave it through. If the cycle is gone,\n' +
        'delete the entry (and say so in the CHANGELOG — removing one is good news).\n\n  ' +
        stale.join('\n  '),
    ).toEqual([]);
  });
});
