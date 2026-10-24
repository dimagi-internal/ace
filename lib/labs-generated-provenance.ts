/**
 * Will labs count a manifest's data as GENERATED?
 *
 * Labs (connect-labs #2718, `labs/synthetic/provenance.py::replays_real_cases`)
 * treats a `longitudinal` block in `mode: mirror` as a near-copy of real cases,
 * and a `mode: modelled` block without `numbers: modelled` the same way, unless
 * the block declares `numbers: authored`: the caller wrote every series itself,
 * from no real case. Data generated from a replaying pool is never marked
 * generated, so labs' canopy panel and `data_query` refuse agents on it.
 *
 * ACE's programme cascade (`demo-data-setup` § C3) writes its transplant pool by
 * hand and generates it in mirror mode, so every cascade pool must say
 * `numbers: authored`. A clone (`synthetic_profile_from_prod(mirror=true)`)
 * replays real cases and must NOT say it: the declaration is ACE's word on where
 * the numbers came from, and labs takes it.
 *
 * `unmarkedPools` mirrors labs' rule so `scripts/run-labs-synthetic-generate.ts
 * --expect-generated` refuses before sending; `readGenerated` reads labs' own
 * answer afterwards, which is the authority.
 */

import { parse as parseYaml } from 'yaml';

/** Paths (dotted) of every longitudinal block labs would treat as replaying real cases. */
export function unmarkedPools(manifestYaml: string): string[] {
  const doc = parseYaml(manifestYaml);
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const mode = obj.mode;
    const numbers = obj.numbers;
    if ((mode === 'mirror' || mode === 'modelled') && numbers === 'authored') {
      // The pool is the caller's; anything else in the block is still walked.
      for (const [k, v] of Object.entries(obj)) if (k !== 'transplant_pool') walk(v, path ? `${path}.${k}` : k);
      return;
    }
    if (mode === 'mirror' || (mode === 'modelled' && numbers !== 'modelled')) {
      found.push(path || '(root)');
      return;
    }
    for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(doc, '');
  return found;
}

export interface GeneratedAnswer {
  /** Labs' `generated` field; `undefined` when labs did not report one (pre-#2718 labs). */
  generated: boolean | undefined;
  /** Labs' `not_generated_because`, when it gave one. */
  reason?: string;
}

/** Read `generated` / `not_generated_because` from `synthetic_generate_from_manifest`'s JSON payload. */
export function readGenerated(payloadText: string): GeneratedAnswer {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { generated: undefined };
  }
  if (!payload || typeof payload !== 'object') return { generated: undefined };
  const p = payload as Record<string, unknown>;
  const generated = typeof p.generated === 'boolean' ? p.generated : undefined;
  const reason = typeof p.not_generated_because === 'string' ? p.not_generated_because : undefined;
  return reason ? { generated, reason } : { generated };
}
