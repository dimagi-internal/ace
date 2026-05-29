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

/**
 * Coerce a candidate identifier to a string. Accepts strings AND numbers —
 * labs/OCS IDs (solicitation_id, experiment_id, collection_id, workflow_id,
 * labs_opp_id, …) are stored as bare integers in YAML, which an earlier
 * string-only guard silently dropped. Returns null for empty/non-scalar.
 */
function asId(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function pushId(arr: string[], v: unknown): void {
  const s = asId(v);
  if (s) arr.push(s);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function dedupeStable(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * The live-set's job is to mark resources that are still LIVE so the sweep
 * never deletes them. Over-inclusion is safe (fewer deletions); under-inclusion
 * is dangerous (deletes a live resource). So each collector below is generous:
 * it reads every alias key name that has ever been written for a resource,
 * across the legacy top-level `opp.yaml` blocks (`ocs_chatbot:`, `solicitation:`,
 * `synthetic:`, `connect:`) AND the canonical `run_state.yaml`
 * `phases.<phase>.products.*` shape. Key names verified against live Drive
 * state 2026-05-29 (see the union table in the sweep live-set design notes):
 * field names drift across opps (OCS collection has 4 names, chatbot id 3,
 * solicitation id 2, synthetic opp id 2; Connect ids are flat on some opps,
 * nested on others). A `scope` is any object that may directly hold these
 * blocks: the opp.yaml root, a run_state root, or one phase's `products`.
 */
function collectConnect(ids: LiveSet['identifiers'], scope: Record<string, unknown>): void {
  const connect = asRecord(scope.connect);
  const program = asRecord(connect.program);
  const opportunity = asRecord(connect.opportunity);

  // program id: flat (bednet), nested (most), or a top-level `connect_program` (in-progress runs)
  pushId(ids.connectProgramIds, connect.program_id);
  pushId(ids.connectProgramIds, program.id);
  pushId(ids.connectProgramIds, asRecord(scope.connect_program).id);

  // opportunity id: flat or nested. Also the legacy flat `products.opportunity.id`.
  pushId(ids.connectOpportunityIds, connect.opportunity_id);
  pushId(ids.connectOpportunityIds, opportunity.id);
  pushId(ids.connectOpportunityIds, asRecord(scope.opportunity).id);

  // payment units: singular block, nested arrays on the opportunity, or a
  // `payment_units[]` array (keyed by uuid / payment_unit_uuid / server_id / id),
  // plus the legacy flat `products.payment_units[]`.
  const singularPu = asRecord(connect.payment_unit);
  pushId(ids.connectPaymentUnitIds, singularPu.id);
  pushId(ids.connectPaymentUnitIds, singularPu.int_id);
  for (const x of asArray(opportunity.payment_unit_ids)) pushId(ids.connectPaymentUnitIds, x);
  for (const x of asArray(opportunity.payment_unit_uuids)) pushId(ids.connectPaymentUnitIds, x);
  for (const arr of [asArray(connect.payment_units), asArray(scope.payment_units)]) {
    for (const pu of arr) {
      const r = asRecord(pu);
      pushId(ids.connectPaymentUnitIds, r.payment_unit_uuid);
      pushId(ids.connectPaymentUnitIds, r.uuid);
      pushId(ids.connectPaymentUnitIds, r.server_id);
      pushId(ids.connectPaymentUnitIds, r.id);
    }
  }

  // CommCare app ids that live under `connect` (flat on bednet, nested on leep).
  pushId(ids.commcareAppIds, connect.learn_app_id);
  pushId(ids.commcareAppIds, connect.deliver_app_id);
  pushId(ids.commcareAppIds, opportunity.learn_hq_app_id);
  pushId(ids.commcareAppIds, opportunity.deliver_hq_app_id);
}

function collectOcs(ids: LiveSet['identifiers'], scope: Record<string, unknown>): void {
  // `ocs_chatbot` is the live key; `chatbot` is the legacy run_state key.
  for (const block of [asRecord(scope.ocs_chatbot), asRecord(scope.chatbot)]) {
    pushId(ids.ocsChatbotIds, block.experiment_id);
    pushId(ids.ocsChatbotIds, block.id);
    pushId(ids.ocsChatbotIds, block.chatbot_id);
    pushId(ids.ocsChatbotIds, block.public_id);
    pushId(ids.ocsCollectionIds, block.collection_id);
    pushId(ids.ocsCollectionIds, block.collection_id_per_opp);
    pushId(ids.ocsCollectionIds, block.collection_id_shared);
    pushId(ids.ocsCollectionIds, block.shared_collection_id);
    pushId(ids.ocsCollectionIds, block.opp_collection_id);
  }
}

function collectSolicitation(ids: LiveSet['identifiers'], scope: Record<string, unknown>): void {
  const s = asRecord(scope.solicitation);
  pushId(ids.labsRecordIds, s.solicitation_id);
  pushId(ids.labsRecordIds, s.labs_id);
  pushId(ids.labsRecordIds, s.id); // legacy run_state key
  for (const x of asArray(s.orphaned_create_attempts)) pushId(ids.labsRecordIds, x);
}

function collectSynthetic(ids: LiveSet['identifiers'], scope: Record<string, unknown>): void {
  const syn = asRecord(scope.synthetic);
  pushId(ids.labsSyntheticIds, syn.labs_opp_id);
  pushId(ids.labsSyntheticIds, syn.labs_opportunity_id);

  const workflows = asRecord(syn.workflows);
  // Flat opp.yaml form: `<name>_id`.
  pushId(ids.labsWorkflowIds, workflows.llo_weekly_review_id);
  pushId(ids.labsWorkflowIds, workflows.program_admin_audit_id);
  pushId(ids.labsPipelineIds, workflows.llo_pipeline_id);
  // Nested run_state form: `<persona>.{workflow_id, pipeline_id}`.
  for (const v of Object.values(workflows)) {
    const r = asRecord(v);
    pushId(ids.labsWorkflowIds, r.workflow_id);
    pushId(ids.labsPipelineIds, r.pipeline_id);
  }

  // Legacy flat `products.*` fields.
  pushId(ids.labsWorkflowIds, scope.workflow_id);
  pushId(ids.labsPipelineIds, scope.pipeline_id);
  pushId(ids.labsSyntheticIds, scope.synthetic_opp_id);
}

function collectCommcare(ids: LiveSet['identifiers'], scope: Record<string, unknown>): void {
  // `products.apps.{learn,deliver}` (bednet/leep) and `products.commcare.{learn,deliver}` (itn-fgd).
  for (const wrapper of [asRecord(scope.apps), asRecord(scope.commcare)]) {
    pushId(ids.commcareAppIds, asRecord(wrapper.learn).hq_app_id);
    pushId(ids.commcareAppIds, asRecord(wrapper.deliver).hq_app_id);
  }
  // Legacy flat `products.{learn,deliver}_app.hq_app_id`.
  pushId(ids.commcareAppIds, asRecord(scope.learn_app).hq_app_id);
  pushId(ids.commcareAppIds, asRecord(scope.deliver_app).hq_app_id);
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

  // Build the list of scopes to scan: opp.yaml root (legacy top-level blocks +
  // durable Connect program ref), each run_state root (top-level `connect_program`
  // on in-progress runs), and every phase's `products`.
  const scopes: Record<string, unknown>[] = [asRecord(tryParse(oppYaml))];
  for (const text of runStateYamls) {
    const run = asRecord(tryParse(text));
    scopes.push(run);
    for (const phaseBody of Object.values(asRecord(run.phases))) {
      scopes.push(asRecord(asRecord(phaseBody).products));
    }
  }

  for (const scope of scopes) {
    collectConnect(ids, scope);
    collectOcs(ids, scope);
    collectSolicitation(ids, scope);
    collectSynthetic(ids, scope);
    collectCommcare(ids, scope);
  }

  // Dedupe each bucket (the same id appears in opp.yaml + many runs); preserve
  // insertion order. mergeFragments dedupes across opps afterward.
  for (const k of Object.keys(ids) as Array<keyof LiveSet['identifiers']>) {
    ids[k] = dedupeStable(ids[k]);
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
