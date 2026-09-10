/**
 * `PRODUCT_PRODUCERS` — which skill writes each `phases.<phase>.products.*`
 * key (dimagi-internal/ace#2354).
 *
 * ace-web's skill fork (ace-web#765) carries the fork phase's `products`
 * block into the forked run. Without a product-key → producing-skill map it
 * had to carry the block WHOLE and mark it UNATTRIBUTED — so a Phase 7 fork at
 * `demo-narrative` seeded the new run with a stale `synthetic.narrative` and
 * stale `ddd_*` next to the kept `synthetic.source` / `.workflows`. The map
 * lives here, next to the schema that types the same keys, and travels to
 * ace-web through the generated `docs/phase-products-schema.json`.
 *
 * Two invariants this file pins:
 *
 *   1. NO SILENT GAPS — every key the Zod schemas declare (walked recursively
 *      through object shapes) is attributed by `productProducer()` or listed
 *      in `UNATTRIBUTED_PRODUCT_KEYS` with a reason. A container whose
 *      children are each attributed counts as attributed (`training.docs`).
 *   2. EVERY PRODUCER IS REAL — a `skills/<name>/` dir, or `agents/<name>.md`
 *      when the phase agent itself writes the key, in which case the agent
 *      must be THAT phase's agent (a phase-owned key cannot be attributed to
 *      some other phase's agent).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  PHASE_PRODUCTS_SCHEMAS,
  PRODUCT_PRODUCERS,
  UNATTRIBUTED_PRODUCT_KEYS,
  productProducer,
  type PhaseName,
} from '../../lib/phase-products-schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Unwrap Optional/Nullable/Default wrappers down to the underlying type. */
function unwrap(t: z.ZodTypeAny): z.ZodTypeAny {
  let cur: any = t;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur.unwrap();
    else if (cur instanceof z.ZodDefault) cur = cur.removeDefault();
    else return cur;
  }
}

function objectShape(t: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  const u = unwrap(t);
  return u instanceof z.ZodObject ? (u.shape as Record<string, z.ZodTypeAny>) : null;
}

/** Every dotted object-key path the schema declares, recursively (arrays are leaves). */
function declaredPaths(schema: z.ZodTypeAny, prefix = ''): string[] {
  const shape = objectShape(schema);
  if (!shape) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(shape)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p, ...declaredPaths(v, p));
  }
  return out;
}

/**
 * A path is COVERED when `productProducer` resolves it, when it is explicitly
 * unattributed, or when it is a container every declared child of which is
 * covered (so `training.docs` is covered by its five attributed slots).
 */
function covered(phase: PhaseName, dotted: string, type: z.ZodTypeAny): boolean {
  if (productProducer(phase, dotted)) return true;
  if ((UNATTRIBUTED_PRODUCT_KEYS[phase] ?? []).some((u) => u.key === dotted)) return true;
  const shape = objectShape(type);
  if (!shape || Object.keys(shape).length === 0) return false;
  return Object.entries(shape).every(([k, v]) => covered(phase, `${dotted}.${k}`, v));
}

const PHASES = Object.keys(PHASE_PRODUCTS_SCHEMAS) as PhaseName[];

describe('PRODUCT_PRODUCERS covers every declared products key (ace#2354)', () => {
  for (const phase of PHASES) {
    it(`${phase}: every top-level product key is attributed or explicitly unattributed`, () => {
      const shape = objectShape(PHASE_PRODUCTS_SCHEMAS[phase])!;
      const gaps = Object.entries(shape)
        .filter(([k, v]) => !covered(phase, k, v))
        .map(([k]) => k);
      expect(gaps, `unattributed products keys in ${phase}: ${gaps.join(', ')}`).toEqual([]);
    });
  }

  it('synthetic-data-and-workflows is attributed one level DOWN — the block has three writers', () => {
    // The whole reason the map is dotted rather than top-level: `synthetic` is
    // written by demo-data-setup, demo-narrative AND the Phase 7 agent.
    const phase: PhaseName = 'synthetic-data-and-workflows';
    const synthetic = objectShape(objectShape(PHASE_PRODUCTS_SCHEMAS[phase])!.synthetic)!;
    for (const key of Object.keys(synthetic)) {
      expect(productProducer(phase, `synthetic.${key}`), `synthetic.${key}`).toBeTruthy();
    }
    expect(productProducer(phase, 'synthetic')).toBeUndefined();
  });

  it('every UNATTRIBUTED entry names a key the schema actually declares, with a reason', () => {
    for (const phase of Object.keys(UNATTRIBUTED_PRODUCT_KEYS) as PhaseName[]) {
      const declared = new Set(declaredPaths(PHASE_PRODUCTS_SCHEMAS[phase]));
      for (const entry of UNATTRIBUTED_PRODUCT_KEYS[phase] ?? []) {
        expect(declared.has(entry.key), `${phase}: ${entry.key} is not in the schema`).toBe(true);
        expect(entry.reason.trim().length, `${phase}: ${entry.key} needs a reason`).toBeGreaterThan(20);
        expect(
          productProducer(phase, entry.key),
          `${phase}: ${entry.key} is both attributed and unattributed`,
        ).toBeUndefined();
      }
    }
  });
});

describe('every producer is a real skill or the owning phase agent', () => {
  const skillDirs = new Set(
    fs.readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  );
  const agentDocs = new Set(
    fs.readdirSync(path.join(REPO_ROOT, 'agents'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length)),
  );

  for (const [phase, map] of Object.entries(PRODUCT_PRODUCERS) as [PhaseName, Record<string, string>][]) {
    it(`${phase}: producers resolve to skills/<name>/ or agents/<phase>.md`, () => {
      for (const [key, producer] of Object.entries(map)) {
        const isSkill = skillDirs.has(producer);
        const isAgent = agentDocs.has(producer);
        expect(isSkill || isAgent, `${phase}.${key} → ${producer} is neither a skill nor an agent`).toBe(true);
        if (!isSkill && isAgent) {
          // A phase-owned key is written by THIS phase's agent, never another's.
          // `design` is the legacy spelling of `idea-to-design`.
          const owner = phase === 'design' ? 'idea-to-design' : phase;
          expect(producer, `${phase}.${key} attributed to a different phase's agent`).toBe(owner);
        }
      }
    });
  }

  it('the Phase 7 agent owns every ddd_* key and demo-narrative owns narrative', () => {
    const phase: PhaseName = 'synthetic-data-and-workflows';
    expect(productProducer(phase, 'synthetic.ddd_terminal_status')).toBe('synthetic-data-and-workflows');
    expect(productProducer(phase, 'synthetic.ddd_open_strategy_findings')).toBe('synthetic-data-and-workflows');
    expect(productProducer(phase, 'synthetic.narrative')).toBe('demo-narrative');
    for (const k of ['source', 'labs_opp_id', 'workflows', 'provider', 'render_code_patched_this_run']) {
      expect(productProducer(phase, `synthetic.${k}`), k).toBe('demo-data-setup');
    }
  });
});

describe('productProducer resolution — exact, prefix, wildcard', () => {
  const phase: PhaseName = 'synthetic-data-and-workflows';

  it('a deeper path inherits the nearest attributed ancestor', () => {
    expect(productProducer(phase, 'synthetic.source.record_counts')).toBe('demo-data-setup');
    expect(productProducer('connect-setup', 'connect.opportunity.url')).toBe('connect-opp-setup');
  });

  it('a trailing `*` matches a key-segment PREFIX, and only the last segment may carry it', () => {
    expect(productProducer(phase, 'synthetic.ddd_run_id')).toBe('synthetic-data-and-workflows');
    expect(productProducer(phase, 'synthetic.ddd_')).toBe('synthetic-data-and-workflows');
    // `ddd_*` is a prefix on ONE segment, not a glob across segments.
    expect(productProducer(phase, 'synthetic.dddx')).toBeUndefined();
    for (const map of Object.values(PRODUCT_PRODUCERS)) {
      for (const key of Object.keys(map)) {
        const segs = key.split('.');
        segs.slice(0, -1).forEach((s) => expect(s, key).not.toContain('*'));
        const last = segs[segs.length - 1];
        if (last.includes('*')) expect(last.endsWith('*') && last.indexOf('*') === last.length - 1, key).toBe(true);
      }
    }
  });

  it('an exact entry outranks a wildcard at the same depth, and a deeper entry outranks a shallower one', () => {
    // solicitation → create; solicitation.awarded → review (deeper wins)
    expect(productProducer('solicitation-management', 'solicitation.url')).toBe('solicitation-create');
    expect(productProducer('solicitation-management', 'solicitation.awarded')).toBe('solicitation-review');
    expect(productProducer('solicitation-management', 'solicitation.awarded.org_slug')).toBe('solicitation-review');
    expect(productProducer('ocs-setup', 'ocs_chatbot')).toBe('ocs-agent-setup');
    expect(productProducer('ocs-setup', 'ocs_chatbot.knowledge_sources')).toBe('ocs-knowledge-refresh');
  });

  it('returns undefined for an unknown phase, an unmapped key, or a blank key', () => {
    expect(productProducer('scenarios-and-acceptance', 'anything')).toBeUndefined();
    expect(productProducer(phase, 'nope')).toBeUndefined();
    expect(productProducer(phase, '')).toBeUndefined();
  });
});
