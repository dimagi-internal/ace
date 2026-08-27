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
 * ACE has exactly one, between Phase 5 (OCS) and Phase 6 (training), and it was
 * mis-diagnosed as the first kind for months **because the manifest only
 * declared half of it.** The `qa-and-training -> ocs` direction was there (the
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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Known cycles, keyed by their phase pair, with the cut that makes them safe.
 * Adding an entry is a design decision — say how the loop is closed.
 */
const DECLARED_CYCLES: Record<string, string> = {
  'ocs<->qa-and-training':
    'Phase 5 publishes the chatbot and emits widget_url, which the Phase 6 guides ' +
    'link to; Phase 6 writes the training docs, which belong in the chatbot\'s RAG ' +
    'collection. CUT: Phase 5 creates and publishes, Phase 6 writes the docs, then ' +
    'Phase 6 Step 2d re-runs `ocs-agent-setup --reindex` to close the loop. ' +
    'Reordering the two phases is NOT a fix — it leaves every guide with a dead ' +
    '"ask questions here" link.',

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

interface Entry {
  producedBy: string;
  consumers: string[];
  phase: string;
}

function parseManifest(): Entry[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'lib/artifact-manifest.ts'), 'utf8');
  const body = src.slice(src.indexOf('DISPATCH') >= 0 ? 0 : 0);
  const re =
    /\{\s*path:\s*'([^']+)',[\s\S]*?producedBy:\s*'([^']+)',[\s\S]*?consumedBy:\s*\[([\s\S]*?)\],[\s\S]*?phase:\s*'([^']+)'/g;
  const out: Entry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const consumers = [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    out.push({ producedBy: m[2], consumers, phase: m[4] });
  }
  return out;
}

describe('artifact dataflow cycles', () => {
  const entries = parseManifest();

  it('parses the manifest', () => {
    expect(entries.length, 'no manifest entries parsed — did the shape change?').toBeGreaterThan(
      100,
    );
  });

  it('declares every phase-level cycle, with its cut', () => {
    // Map each producer to the phase(s) it produces in. Producers that span
    // several phases (the orchestrator, `external`) are dropped: a cross-phase
    // edge through them is an artifact of the aggregation, not a real dependency.
    const producerPhases = new Map<string, Set<string>>();
    for (const e of entries) {
      if (!producerPhases.has(e.producedBy)) producerPhases.set(e.producedBy, new Set());
      producerPhases.get(e.producedBy)!.add(e.phase);
    }
    const singlePhase = new Map(
      [...producerPhases].filter(([n, ps]) => ps.size === 1 && n !== 'external' && n !== 'ace-orchestrator')
        .map(([n, ps]) => [n, [...ps][0]]),
    );

    const edges = new Set<string>();
    for (const e of entries) {
      if (!singlePhase.has(e.producedBy)) continue;
      for (const c of e.consumers) {
        const cp = singlePhase.get(c);
        if (cp && cp !== e.phase) edges.add(`${e.phase}->${cp}`);
      }
    }

    const cycles = new Set<string>();
    for (const edge of edges) {
      const [a, b] = edge.split('->');
      if (edges.has(`${b}->${a}`)) cycles.add([a, b].sort().join('<->'));
    }

    const undeclared = [...cycles].filter((c) => !(c in DECLARED_CYCLES));
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
    // A stale entry here would silently license a future cycle between the same
    // two phases. If the cycle is genuinely gone, delete the entry.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'lib/artifact-manifest.ts'), 'utf8');
    for (const key of Object.keys(DECLARED_CYCLES)) {
      const [a, b] = key.split('<->');
      expect(
        src.includes(`phase: '${a}'`) && src.includes(`phase: '${b}'`),
        `DECLARED_CYCLES names phases ${a}/${b}, but the manifest has no such phases`,
      ).toBe(true);
    }
  });
});
