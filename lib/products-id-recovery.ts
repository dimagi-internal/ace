/**
 * Rebuild a phase's EXTERNAL-resource ids in `products` from the artifact
 * frontmatter the manifest declares — the structural half of ace#2412.
 *
 * ## The defect
 *
 * A phase mints external objects (Nova apps, HQ apps, …) early, but
 * `products` used to land only at phase END. On
 * `poverty-graduation/20260915-1518` the Phase 3 agent was killed mid-phase by
 * the harness stream watchdog with two Nova apps already `complete` and
 * `phases.commcare-setup.products: null`. The orchestrator's Step 2a then reads
 * "no app ids recorded" as "a fresh run that has built nothing", and the
 * natural recovery re-dispatches the build — minting a SECOND pair of apps.
 * The ids were recoverable only by hand, from `nova_app_id` in
 * `3-commcare/pdd-to-{learn,deliver}-app_summary.md`.
 *
 * PR #2438 made "write the id in the step that mints it" a contract. That is
 * prose an agent must remember; this helper makes the failure non-fatal
 * whether or not the prose was obeyed.
 *
 * ## Read the declared field, never scan
 *
 * {@link PRODUCT_ID_SOURCES} names, per phase, exactly which manifest artifact
 * carries which frontmatter field and which `products` key it fills. The
 * manifest entry's own description declares the field
 * (`Required frontmatter: \`nova_app_id\``), and
 * `test/lib/products-id-recovery.test.ts` pins every source against it. The
 * caller reads only {@link declaredSourcePaths} — never "anything in the phase
 * folder that looks like an id", which is the guessing CLAUDE.md § close the
 * loop to the source of truth forbids. When a declared source exists but
 * cannot answer (no frontmatter, empty field) or disagrees with what products
 * already records, the result is `halt`, loudly — never a best guess.
 */

import { parse as parseYaml } from 'yaml';

/** One declared id: `field` in `artifact`'s frontmatter fills `products.<productKey>`. */
export interface ProductIdSource {
  artifact: string;
  field: string;
  productKey: string;
}

/** Keyed by run_state phase name (`phases.<name>`). */
export const PRODUCT_ID_SOURCES: Readonly<Record<string, readonly ProductIdSource[]>> = {
  'commcare-setup': [
    { artifact: '3-commcare/pdd-to-learn-app_summary.md', field: 'nova_app_id', productKey: 'apps.learn.nova_app_id' },
    { artifact: '3-commcare/pdd-to-deliver-app_summary.md', field: 'nova_app_id', productKey: 'apps.deliver.nova_app_id' },
    { artifact: '3-commcare/app-deploy_summary.md', field: 'learn_app_id', productKey: 'apps.learn.hq_app_id' },
    { artifact: '3-commcare/app-deploy_summary.md', field: 'deliver_app_id', productKey: 'apps.deliver.hq_app_id' },
  ],
};

/** The only files a caller should read for `phase` — no folder scan. */
export function declaredSourcePaths(phase: string): string[] {
  return [...new Set((PRODUCT_ID_SOURCES[phase] ?? []).map((s) => s.artifact))];
}

export interface RecoveredId {
  productKey: string;
  value: string;
  from: string;
}

export interface RecoveryProblem {
  productKey: string;
  artifact: string;
  problem: 'no-frontmatter' | 'field-missing' | 'conflict';
  detail: string;
}

export type ProductIdRecovery =
  | { status: 'unable'; reason: string }
  | { status: 'halt'; problems: RecoveryProblem[] }
  | {
      status: 'ok';
      /** Nested `products` fragment to deep-merge — empty when nothing was missing. */
      patch: Record<string, unknown>;
      recovered: RecoveredId[];
      alreadyRecorded: string[];
      /** Keys absent from products whose declared artifact does not exist either. */
      noEvidence: { productKey: string; artifact: string }[];
    };

function frontmatter(md: string): Record<string, unknown> | undefined {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  try {
    const fm = parseYaml(m[1]);
    return fm && typeof fm === 'object' ? (fm as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

const present = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * Reconcile `products` ids for `phase` from the declared artifacts.
 *
 * @param products  the phase's current `products` block (null/undefined ok)
 * @param artifacts declared path → file contents; `undefined` = file absent.
 *                  Only {@link declaredSourcePaths} are consulted.
 */
export function recoverProductIds(args: {
  phase: string;
  products: unknown;
  artifacts: Record<string, string | undefined>;
}): ProductIdRecovery {
  const sources = PRODUCT_ID_SOURCES[args.phase];
  if (!sources || sources.length === 0) {
    return {
      status: 'unable',
      reason:
        `no declared id sources for phase "${args.phase}" — PRODUCT_ID_SOURCES names none, so its ` +
        `external ids cannot be recovered from artifacts; check the external system live before re-dispatching`,
    };
  }
  const patch: Record<string, unknown> = {};
  const recovered: RecoveredId[] = [];
  const alreadyRecorded: string[] = [];
  const noEvidence: { productKey: string; artifact: string }[] = [];
  const problems: RecoveryProblem[] = [];

  for (const s of sources) {
    const recorded = getPath(args.products, s.productKey);
    const body = args.artifacts[s.artifact];
    if (body === undefined) {
      if (present(recorded)) alreadyRecorded.push(s.productKey);
      else noEvidence.push({ productKey: s.productKey, artifact: s.artifact });
      continue;
    }
    const fm = frontmatter(body);
    if (!fm) {
      problems.push({
        productKey: s.productKey,
        artifact: s.artifact,
        problem: 'no-frontmatter',
        detail: `${s.artifact} exists but has no parseable YAML frontmatter, so \`${s.field}\` cannot be read`,
      });
      continue;
    }
    const value = fm[s.field];
    if (!present(value)) {
      if (present(recorded)) {
        alreadyRecorded.push(s.productKey);
        continue;
      }
      problems.push({
        productKey: s.productKey,
        artifact: s.artifact,
        problem: 'field-missing',
        detail: `${s.artifact} exists but its frontmatter has no \`${s.field}\` — the declared field is the only source`,
      });
      continue;
    }
    const v = String(value).trim();
    if (present(recorded)) {
      if (String(recorded).trim() !== v) {
        problems.push({
          productKey: s.productKey,
          artifact: s.artifact,
          problem: 'conflict',
          detail: `products.${s.productKey} = "${String(recorded)}" but ${s.artifact} \`${s.field}\` = "${v}"`,
        });
      } else alreadyRecorded.push(s.productKey);
      continue;
    }
    setPath(patch, s.productKey, v);
    recovered.push({ productKey: s.productKey, value: v, from: `${s.artifact}#${s.field}` });
  }

  if (problems.length > 0) return { status: 'halt', problems };
  return { status: 'ok', patch, recovered, alreadyRecorded, noEvidence };
}
