//
// Pure cross-blueprint check: is every evidence step the Learn curriculum
// teaches as UNCONDITIONAL actually collectable in the Deliver form, on every
// branch the worker can be on?
//
// Why this exists: dimagi-internal/ace#1259. `pdd-to-learn-app` and
// `pdd-to-deliver-app` each build from the PDD independently, and each `-eval`
// grades its own app against the PDD in isolation. So a curriculum can
// confidently instruct a worker to perform a step the instrument cannot
// record, and every Phase 3 gate passes.
//
// Live on hh-poverty-targeting/20260813-1612: Learn M8's worked example (the
// padlocked dwelling) tells the worker to photograph the building, capture GPS,
// record the outcome as vacant and submit. The Deliver form's only
// `dwelling_photo` sits in a group gated `relevant: consent = 'yes'`, and on a
// vacant visit `consent` is never reached — so at their first padlocked
// dwelling a worker follows the training, takes the photo, and finds no screen
// to attach it to. The evidence the training presents as the point of the visit
// is silently discarded. GPS, by contrast, is required with no relevance, so
// that half of the same worked example works everywhere — which is what makes
// this a real asymmetry rather than "training over-promises" in general.
//
// This module deliberately does NOT decide which artifact is wrong. On that run
// both were PDD-conformant (§5.1 lists the live photograph under "a payable
// visit requires all of"; §5.2 gates the photo screen on Consent = yes), so the
// call is a judgement. What was missing is the CHECK: nothing cross-read the
// two blueprints, and a human found it by reading them side by side.
//

/** Minimal blueprint shapes — the subset both Nova apps expose. */

import { type CheckOutcome, checked, unable, formatUnable } from './check-outcome.js';
export interface BlueprintField {
  id: string;
  kind: string;
  label?: string;
  required?: boolean;
  relevant?: unknown;
  options?: { label?: string }[];
  children?: BlueprintField[];
}
export interface BlueprintForm {
  form_name: string;
  fields?: BlueprintField[];
}
export interface BlueprintModule {
  module_name: string;
  forms?: BlueprintForm[];
}
export interface Blueprint {
  modules?: BlueprintModule[];
}

/**
 * Evidence actions a curriculum can teach, each mapped to the Deliver field
 * KINDS that can record it. Deliberately small: these are the actions ACE's
 * Learn apps actually instruct and whose absence costs a worker real effort in
 * the field. A taught step with no entry here is not guessed at.
 */
const EVIDENCE_ACTIONS: { action: string; phrases: RegExp; kinds: string[] }[] = [
  {
    action: 'photograph',
    phrases: /\b(take|capture|snap)\b[^.]{0,40}\bphotograph|\bphotograph\b[^.]{0,20}\bof\b|\btake\b[^.]{0,20}\bphoto\b/i,
    kinds: ['image', 'photo'],
  },
  {
    action: 'GPS fix',
    phrases: /\b(capture|record|take)\b[^.]{0,30}\b(gps|location|coordinates)\b/i,
    kinds: ['geopoint', 'gps'],
  },
  {
    action: 'audio recording',
    phrases: /\b(record)\b[^.]{0,30}\b(audio|voice|recording)\b/i,
    kinds: ['audio'],
  },
];

/**
 * Only text a curriculum states as applying to EVERY visit counts. A step
 * described as conditional ("if the household consents…") is not a promise the
 * Deliver form must honour on all branches, and flagging it would make this the
 * always-fires class.
 */
const UNCONDITIONAL_MARKERS =
  /\b(you still do all of this|at every visit|on every visit|including empty|every household|always|all four)\b/i;

export type TaughtFindingReason = 'absent' | 'gated';

export interface TaughtFinding {
  /** The evidence action the curriculum teaches. */
  taught: string;
  /** Where it is taught. */
  module: string;
  /** The Deliver field that would record it, when one exists. */
  field?: string;
  /** The relevance expression gating that field, when it is gated. */
  gate?: string;
  reason: TaughtFindingReason;
}

/**
 * `status: 'unable'` when the curriculum states no unconditional evidence
 * step — there is nothing to cross-check, which is NOT the same as the two
 * apps agreeing. `lib/check-outcome.ts`.
 */
export type TaughtVsCollectableReport = CheckOutcome<TaughtFinding>;

function flatten(fields: BlueprintField[] | undefined, inheritedGate?: string): {
  field: BlueprintField;
  gate?: string;
}[] {
  const out: { field: BlueprintField; gate?: string }[] = [];
  for (const f of fields ?? []) {
    const gate = f.relevant ? gateText(f.relevant) : inheritedGate;
    if (f.children?.length) out.push(...flatten(f.children, gate));
    else out.push({ field: f, gate });
  }
  return out;
}

/** `relevant` may be a string or Nova's structured `{parts:[…]}` shape. */
function gateText(relevant: unknown): string {
  if (typeof relevant === 'string') return relevant;
  const parts = (relevant as { parts?: { text?: string; uuid?: string }[] })?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p.text ?? p.uuid ?? '').join(' ').trim();
  return String(relevant);
}

export function checkTaughtStepsCollectable(
  learn: Blueprint | undefined | null,
  deliver: Blueprint | undefined | null,
): TaughtVsCollectableReport {
  const findings: TaughtFinding[] = [];
  let taughtAny = false;

  const deliverFields = (deliver?.modules ?? []).flatMap((m) =>
    (m.forms ?? []).flatMap((f) => flatten(f.fields)),
  );

  for (const mod of learn?.modules ?? []) {
    for (const form of mod.forms ?? []) {
      for (const field of form.fields ?? []) {
        const text = field.label ?? '';
        if (!text || !UNCONDITIONAL_MARKERS.test(text)) continue;
        for (const action of EVIDENCE_ACTIONS) {
          if (!action.phrases.test(text)) continue;
          taughtAny = true;
          const candidates = deliverFields.filter((d) =>
            action.kinds.includes(String(d.field.kind).toLowerCase()),
          );
          if (candidates.length === 0) {
            findings.push({ taught: action.action, module: mod.module_name, reason: 'absent' });
            continue;
          }
          // Collectable on every branch iff at least one recording field is
          // reachable unconditionally.
          const ungated = candidates.find((c) => !c.gate);
          if (!ungated) {
            const first = candidates[0];
            findings.push({
              taught: action.action,
              module: mod.module_name,
              field: first.field.id,
              gate: first.gate,
              reason: 'gated',
            });
          }
        }
      }
    }
  }

  if (!taughtAny) {
    return unable(
      'the Learn blueprint states no unconditionally-taught evidence step (no label matched both an ' +
        'UNCONDITIONAL_MARKERS phrase and an EVIDENCE_ACTIONS phrase), so there was nothing to ' +
        'cross-check against the Deliver form. If the curriculum DOES teach one, the phrase ' +
        'matchers are the bug',
    );
  }
  return checked(findings.length === 0, findings);
}

export function formatTaughtVsCollectableReport(report: TaughtVsCollectableReport): string {
  if (report.status === 'unable') return formatUnable('taught-vs-collectable', report.reason);
  if (report.ok) {
    return 'taught-vs-collectable: every unconditionally-taught evidence step is collectable on all branches';
  }
  return [
    `taught-vs-collectable: ${report.findings.length} step(s) the curriculum teaches as unconditional`,
    'cannot be recorded on every branch a worker can be on:',
    ...report.findings.map((f) =>
      f.reason === 'absent'
        ? `  ${f.module} teaches "${f.taught}" — the Deliver form has NO field that records it`
        : `  ${f.module} teaches "${f.taught}" — the only field that records it (${f.field}) is gated on \`${f.gate}\``,
    ),
    '',
    'A worker who follows the training on the gated-out branch performs the step and',
    'finds no screen to attach it to; the evidence is silently discarded.',
    'NOTE: which artifact is wrong is a judgement — the Learn app may over-teach, or',
    'the Deliver form may under-collect, and both can be PDD-conformant at once (that',
    'was true on the run this check comes from). Decide deliberately, then fix ONE',
    'side (dimagi-internal/ace#1259).',
  ].join('\n');
}
