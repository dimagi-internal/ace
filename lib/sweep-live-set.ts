/**
 * Pure live-set extraction. Parses one opp's opp.yaml + run_state.yaml bodies
 * and returns a LiveSet fragment scoped to that opp. The caller (the
 * sweep-live-set skill) walks Drive, fetches each opp's YAMLs, calls
 * extractOppFragment for each, then mergeFragments to produce the final
 * cross-opp LiveSet.
 *
 * No I/O. No Drive auth. Pure parsing + shape extraction so tests can
 * exercise the path-extraction logic without mocking Drive.
 */

import { parse as parseYaml } from 'yaml';
import type { LiveSet } from './sweep-types';

function emptyIdentifiers(): LiveSet['identifiers'] {
  return {
    connectProgramIds: [],
    connectOpportunityIds: [],
    connectPaymentUnitIds: [],
    ocsChatbotIds: [],
    ocsCollectionIds: [],
    ocsSessionIds: [],
    commcareAppIds: [],
    labsWorkflowIds: [],
    labsPipelineIds: [],
    labsSyntheticIds: [],
    labsRecordIds: [],
    driveFileIds: [],
  };
}

function tryParse(yamlText: string): unknown {
  try {
    return parseYaml(yamlText) ?? {};
  } catch {
    return {};
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function pushIfString(arr: string[], v: unknown): void {
  const s = asString(v);
  if (s) arr.push(s);
}

/**
 * Extract identifier fragment for one opp.
 *
 * `runStateYamls` is an array — one entry per `runs/<run-id>/run_state.yaml`
 * under this opp's folder. Pass [] if the opp has no runs yet.
 */
export function extractOppFragment(
  oppSlug: string,
  oppYaml: string,
  runStateYamls: string[],
): LiveSet {
  const ids = emptyIdentifiers();

  // opp.yaml: durable Connect program reference
  const opp = tryParse(oppYaml) as Record<string, unknown>;
  const connect = (opp.connect ?? {}) as Record<string, unknown>;
  const program = (connect.program ?? {}) as Record<string, unknown>;
  pushIfString(ids.connectProgramIds, program.id);

  // run_state.yaml: per-phase products
  for (const text of runStateYamls) {
    const run = tryParse(text) as Record<string, unknown>;
    const phases = (run.phases ?? {}) as Record<string, unknown>;
    for (const phaseBody of Object.values(phases)) {
      const products = ((phaseBody as Record<string, unknown> | undefined)?.products
        ?? {}) as Record<string, unknown>;

      // Connect setup phase products
      const opportunity = (products.opportunity ?? {}) as Record<string, unknown>;
      pushIfString(ids.connectOpportunityIds, opportunity.id);
      const paymentUnits = (products.payment_units ?? []) as unknown[];
      if (Array.isArray(paymentUnits)) {
        for (const pu of paymentUnits) {
          pushIfString(ids.connectPaymentUnitIds, (pu as Record<string, unknown>)?.id);
        }
      }

      // OCS phase products
      const chatbot = (products.chatbot ?? {}) as Record<string, unknown>;
      pushIfString(ids.ocsChatbotIds, chatbot.id);
      pushIfString(ids.ocsCollectionIds, chatbot.collection_id);

      // Solicitation / labs records
      const solicitation = (products.solicitation ?? {}) as Record<string, unknown>;
      pushIfString(ids.labsRecordIds, solicitation.id);

      // Synthetic / workflow phase products (flat fields on products)
      pushIfString(ids.labsWorkflowIds, products.workflow_id);
      pushIfString(ids.labsPipelineIds, products.pipeline_id);
      pushIfString(ids.labsSyntheticIds, products.synthetic_opp_id);

      // CommCare apps
      const learnApp = (products.learn_app ?? {}) as Record<string, unknown>;
      const deliverApp = (products.deliver_app ?? {}) as Record<string, unknown>;
      pushIfString(ids.commcareAppIds, learnApp.hq_app_id);
      pushIfString(ids.commcareAppIds, deliverApp.hq_app_id);
    }
  }

  return {
    generatedAt: '',
    oppSlugs: [oppSlug],
    identifiers: ids,
  };
}

function dedupeSort(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/** Merge fragments from many opps into one LiveSet, deduping and sorting. */
export function mergeFragments(fragments: LiveSet[], generatedAt: string): LiveSet {
  const out = emptyIdentifiers();
  const slugs: string[] = [];
  for (const frag of fragments) {
    slugs.push(...frag.oppSlugs);
    for (const k of Object.keys(out) as Array<keyof LiveSet['identifiers']>) {
      out[k].push(...frag.identifiers[k]);
    }
  }
  for (const k of Object.keys(out) as Array<keyof LiveSet['identifiers']>) {
    out[k] = dedupeSort(out[k]);
  }
  return {
    generatedAt,
    oppSlugs: dedupeSort(slugs),
    identifiers: out,
  };
}
