/**
 * Static QA checks for `solicitation-google-form-qa`.
 *
 * The artifact is an EVIDENCE BUNDLE (JSON) the skill assembles from live
 * reads, not the record alone: the record says what the producer believes it
 * made, and only the live form and an anonymous fetch say what a respondent
 * actually meets. Shape:
 *
 *   {
 *     record: { solicitation_id, form_id, edit_url, responder_url, status?,
 *               question_map: {form_question_id: solicitation_question_id},
 *               imported?: [{form_response_id, labs_response_id}] },
 *     solicitation: { id, is_public, questions: [{id, ...}] },   // get_solicitation
 *     form: { title, description?, items: [{title, description?, options?}] }, // get_google_form_definition
 *     anonymous_http_status: number,      // curl of responder_url, no cookies
 *     deny_list: string[],                // the opp's llo_facing_deny_list
 *     run_products_google_form?: {form_id, responder_url, edit_url} | null  // null = no run bound
 *   }
 *
 * Imported by `scripts/qa-run.ts` (runtime) and
 * `test/skills/solicitation-google-form-qa/checks.test.ts`.
 */

import type { QACheck, QACheckResult } from '../../lib/qa-types';
import { DEMONSTRATION_BANNER, IDENTITY_REFS, parseQuestionRef } from '../../lib/form-from-solicitation';
import { findDenyListHits } from '../../lib/synthetic-responses';

interface Bundle {
  record?: {
    solicitation_id?: number;
    form_id?: string;
    edit_url?: string;
    responder_url?: string;
    status?: string;
    question_map?: Record<string, string>;
    imported?: { form_response_id?: string; labs_response_id?: string | number }[];
  };
  solicitation?: { id?: number; is_public?: boolean; questions?: { id: string }[] };
  form?: { title?: string; description?: string; items?: { title?: string; description?: string; options?: string[] }[] };
  anonymous_http_status?: number;
  deny_list?: string[];
  run_products_google_form?: { form_id?: string; responder_url?: string; edit_url?: string } | null;
}

const IDENTITY = Object.values(IDENTITY_REFS) as string[];

function parse(artifact: string): Bundle | null {
  try {
    const b = JSON.parse(artifact);
    return b && typeof b === 'object' ? (b as Bundle) : null;
  } catch {
    return null;
  }
}

const ok = (detail?: string): QACheckResult => ({ pass: true, ...(detail ? { detail } : {}) });
const bad = (detail: string, auto_fix_hint: string): QACheckResult => ({ pass: false, detail, auto_fix_hint });

function sameSet(a: string[], b: string[]): { missing: string[]; extra: string[] } {
  const A = new Set(a);
  const B = new Set(b);
  return { missing: [...B].filter((x) => !A.has(x)), extra: [...A].filter((x) => !B.has(x)) };
}

export function checkRecordComplete(artifact: string): QACheckResult {
  const b = parse(artifact);
  if (!b) return bad('evidence bundle is not JSON', 'Re-assemble the bundle from the record and the live reads.');
  const r = b.record;
  const missing = ['form_id', 'edit_url', 'responder_url', 'solicitation_id'].filter((k) => !r || !(r as any)[k]);
  if (!r?.question_map || Object.keys(r.question_map).length === 0) missing.push('question_map');
  return missing.length === 0
    ? ok()
    : bad(`record lacks ${missing.join(', ')}`, 'Rewrite the record from the forms_create_from_spec result (Step 6).');
}

export function checkEveryQuestionMirrored(artifact: string): QACheckResult {
  const b = parse(artifact);
  const map = b?.record?.question_map;
  const qs = b?.solicitation?.questions;
  if (!map || !qs) return bad('record question_map or live solicitation questions absent', 'Re-read get_solicitation and the record.');
  const { missing, extra } = sameSet(Object.values(map), [...qs.map((q) => q.id), ...IDENTITY]);
  if (missing.length || extra.length) {
    return bad(
      `question_map vs solicitation: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
      'The solicitation changed after the form was made, or the form was built from a stale read. Rebuild the form (new name) from the current solicitation.',
    );
  }
  return ok();
}

export function checkFormItemsCarryRefs(artifact: string): QACheckResult {
  const b = parse(artifact);
  const items = b?.form?.items;
  const map = b?.record?.question_map;
  if (!items || !map) return bad('live form definition or question_map absent', 'Read the form with get_google_form_definition.');
  const refs = items.map((i) => parseQuestionRef(i.description)).filter((r): r is string => !!r);
  const dupes = refs.filter((r, i) => refs.indexOf(r) !== i);
  if (dupes.length) return bad(`refs repeat on the live form: ${[...new Set(dupes)].join(', ')}`, 'Someone duplicated an item; remove the copy or rebuild the form.');
  const { missing, extra } = sameSet(refs, Object.values(map));
  if (missing.length || extra.length) {
    return bad(
      `live form refs vs question_map: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
      'The form was edited after creation. Answers to an item without its [ref: …] line cannot be imported; restore the item or rebuild.',
    );
  }
  return ok();
}

export function checkBannerWhenPrivate(artifact: string): QACheckResult {
  const b = parse(artifact);
  if (b?.solicitation?.is_public === undefined) return bad('live solicitation is_public unknown', 'Re-read get_solicitation.');
  if (b.solicitation.is_public) return ok('public call: no banner required');
  const desc = (b.form?.description ?? '').trim();
  return desc.startsWith(DEMONSTRATION_BANNER)
    ? ok()
    : bad('private (demonstration) call, but the form description does not start with the banner', 'Restore the demonstration banner at the top of the form description.');
}

export function checkNoDenyListedParty(artifact: string): QACheckResult {
  const b = parse(artifact);
  if (!b?.form) return bad('live form definition absent', 'Read the form with get_google_form_definition.');
  if (!Array.isArray(b.deny_list)) return bad('deny_list absent from the bundle', 'Put the opp\'s llo_facing_deny_list in the bundle ([] when none is declared).');
  const texts: [string, string][] = [
    ['title', b.form.title ?? ''],
    ['description', b.form.description ?? ''],
  ];
  (b.form.items ?? []).forEach((it, i) => {
    texts.push([`items[${i}].title`, it.title ?? '']);
    texts.push([`items[${i}].description`, it.description ?? '']);
    (it.options ?? []).forEach((o, j) => texts.push([`items[${i}].options[${j}]`, o]));
  });
  const hits = texts.flatMap(([where, t]) => findDenyListHits(t, b.deny_list!).map((h) => `${where}: "${h}"`));
  return hits.length === 0
    ? ok()
    : bad(`the public form names deny-listed parties: ${hits.join('; ')}`, 'Edit those items now (the form is public), then fix the solicitation text they came from.');
}

export function checkResponderLinkOpen(artifact: string): QACheckResult {
  const b = parse(artifact);
  if (b?.record?.status === 'closed') return ok('form is closed; link openness not required');
  const s = b?.anonymous_http_status;
  if (typeof s !== 'number') return bad('no anonymous fetch status in the bundle', 'curl the responder_url with no cookies and record the HTTP status.');
  return s === 200
    ? ok()
    : bad(
        `anonymous fetch of the responder link returned ${s}`,
        'Publishing alone does not open the form: call forms_set_publish_settings with anyoneWithLinkCanRespond: true (playbook/integrations/google-forms.md).',
      );
}

export function checkProductsRecorded(artifact: string): QACheckResult {
  const b = parse(artifact);
  if (!b) return bad('evidence bundle is not JSON', 'Re-assemble the bundle.');
  if (b.run_products_google_form === null) return ok('no run bound; run_state not checked');
  const p = b.run_products_google_form;
  const r = b.record ?? {};
  if (!p) return bad('run_state products.solicitation.google_form is missing', 'Write {form_id, responder_url, edit_url} with update_yaml_file merge: deep.');
  const diffs = (['form_id', 'responder_url', 'edit_url'] as const).filter((k) => p[k] !== r[k]);
  return diffs.length === 0
    ? ok()
    : bad(`run_state google_form disagrees with the record on ${diffs.join(', ')}`, 'Rewrite the products block from the record.');
}

export function checkImportsUnique(artifact: string): QACheckResult {
  const b = parse(artifact);
  const imported = b?.record?.imported ?? [];
  const f = imported.map((x) => x.form_response_id);
  const l = imported.map((x) => String(x.labs_response_id));
  if (f.some((x) => !x) || l.some((x) => !x || x === 'undefined')) {
    return bad('an imported row lacks its form_response_id or labs_response_id', 'Re-read list_responses and repair the record row.');
  }
  const dupF = f.filter((x, i) => f.indexOf(x) !== i);
  const dupL = l.filter((x, i) => l.indexOf(x) !== i);
  if (dupF.length || dupL.length) {
    return bad(
      `duplicate imports: form [${[...new Set(dupF)].join(', ')}], labs [${[...new Set(dupL)].join(', ')}]`,
      'A form response was imported twice. Delete the duplicate labs response and fix the record.',
    );
  }
  return ok(imported.length === 0 ? 'nothing imported yet' : undefined);
}

export const CHECKS: QACheck[] = [
  { id: 'record_complete', type: 'static', description: 'Record carries form_id, edit_url, responder_url, solicitation_id and a non-empty question_map', run: checkRecordComplete },
  { id: 'every_question_mirrored', type: 'static', description: 'question_map covers exactly the live solicitation question ids plus the three identity items', run: checkEveryQuestionMirrored },
  { id: 'form_items_carry_refs', type: 'static', description: 'The LIVE form\'s items carry unique [ref: …] lines matching question_map (catches edits after creation)', run: checkFormItemsCarryRefs },
  { id: 'banner_when_private', type: 'static', description: 'A private call\'s form description starts with the demonstration banner', run: checkBannerWhenPrivate },
  { id: 'no_deny_listed_party', type: 'static', description: 'No respondent-facing text on the live form names a deny-listed party', run: checkNoDenyListedParty },
  { id: 'responder_link_open', type: 'static', description: 'An anonymous fetch of the responder link returns 200 (unless the form is closed)', run: checkResponderLinkOpen },
  { id: 'products_recorded', type: 'static', description: 'run_state products.solicitation.google_form matches the record (skipped when no run is bound)', run: checkProductsRecorded },
  { id: 'imports_unique', type: 'static', description: 'No form response or labs response appears twice in the record\'s imported list', run: checkImportsUnique },
];
