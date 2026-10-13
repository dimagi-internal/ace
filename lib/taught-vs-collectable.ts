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
// ace#1793 — every verb here is matched in its INFLECTED forms too. The bare
// stems missed the ordinary way a curriculum writes ("Every visit captures a
// location", "all three get a location fix"), which silently downgraded the
// whole check to `unable`. `location fix` / `gps fix` also match on their own:
// the noun phrase names the evidence action without needing a verb at all.
const EVIDENCE_ACTIONS: { action: string; phrases: RegExp; kinds: string[] }[] = [
  {
    action: 'photograph',
    phrases: /\b(tak(?:e|es|en|ing)|captur(?:e|es|ed|ing)|snap(?:s|ped|ping)?)\b[^.]{0,40}\bphotograph|\bphotograph\b[^.]{0,20}\bof\b|\b(tak(?:e|es|en|ing)|captur(?:e|es|ed|ing))\b[^.]{0,20}\bphoto\b/i,
    kinds: ['image', 'photo'],
  },
  {
    action: 'GPS fix',
    phrases: /\b(captur(?:e|es|ed|ing)|record(?:s|ed|ing)?|tak(?:e|es|en|ing)|get(?:s|ting)?)\b[^.]{0,30}\b(gps|location|coordinates)\b|\b(gps|location)\s+fix\b/i,
    kinds: ['geopoint', 'gps'],
  },
  {
    action: 'audio recording',
    phrases: /\b(record(?:s|ed|ing)?)\b[^.]{0,30}\b(audio|voice|recording)\b/i,
    kinds: ['audio'],
  },
];

/**
 * Only text a curriculum states as applying to EVERY visit counts. A step
 * described as conditional ("if the household consents…") is not a promise the
 * Deliver form must honour on all branches, and flagging it would make this the
 * always-fires class.
 */
// Widened for ace#1793. The bare, sentence-initial form ("Every visit captures
// a location") carries no preposition, and the count in "all <n>" is a property
// of the programme — this one has THREE non-payable outcomes, not four — so
// neither is a linguistic variant worth failing on. Both near-missed phrasings
// already in the list, which is the signature of this module's recurring bug
// class (ace#1332, #1538, #1576, #1634): the matcher, not the curriculum.
//
// ace#2856 made ONE change here, and it is a removal rather than an addition:
// the noun after `every` / `each` was a CLOSED list (`visit|household|door|
// outcome`), so a programme whose unit of observation is anything else was
// unreachable by construction. `turmeric-market-study-ghana/20261012-1749`
// observes a seller at a market stall, so "at every stall" and "of every
// seller" both missed — not exotic phrasings, the only way that curriculum
// could state the rule. The noun is a property of the programme, exactly like
// the count in `all <n>` that ace#1793 generalised for the same reason.
//
// What was deliberately NOT done is add the other phrasings the issue measured
// ("in all cases", "without exception"). That is the move that cannot
// converge — the denominator is English — and it is the move that produced
// ace#1793 and then this recurrence. Those two now land in `unclassified`
// below, which is loud, which is the actual fix.
const UNCONDITIONAL_MARKERS =
  /\b(you still do all of this|(?:at |on |in )?(?:every|each) \w+|including empty|always|all (?:two|three|four|five|six))\b/i;

/**
 * Text that states an evidence step applies only SOMETIMES.
 *
 * This is not a second list of phrasings to keep topping up — it exists to
 * separate two outcomes that `unable` used to conflate (ace#2856):
 *
 *   (a) the curriculum genuinely teaches no UNCONDITIONAL evidence step, and
 *   (b) the matcher could not tell.
 *
 * Both printed the same "nothing to cross-check" line, so a reader could not
 * distinguish a correct negative from a broken matcher without reading both
 * curricula by hand — which is the work this check exists to remove. Four
 * recurrences of this module's bug class reached production that way.
 *
 * Conditionals are a far smaller and more stable class than unconditionals
 * because they are grammatical constructions (consent, dependency, permission)
 * rather than open-ended restatements of "every <programme noun>". A label
 * carrying one is an AFFIRMATIVE (a): the curriculum says "sometimes", and
 * the Deliver form is under no obligation to collect on every branch.
 *
 * **An unconditional marker outranks a conditional one** — see
 * `classifyLearnLabel`. "Always photograph the stall, even if she declines"
 * is unconditional prose containing the word `if`, and precedence this way
 * round means no label that classifies as unconditional today can be
 * reclassified by this addition. The change is monotonic.
 */
const CONDITIONAL_MARKERS =
  /\b(if (?:she|he|they|the \w+) (?:agrees?|consents?|permits?|allows?|is willing|says yes)|only (?:when|if|where)|depend(?:s|ing)? (?:on|upon)|with (?:her|his|their) (?:consent|permission)|if (?:consent|permission) is (?:given|granted)|where (?:she|he|they) (?:agrees?|consents?)|provided (?:that )?(?:she|he|they) (?:agrees?|consents?))\b/i;

/**
 * How a single Learn label states the conditionality of what it teaches.
 *
 * - `unconditional` — cross-check it against the Deliver form.
 * - `conditional` — the curriculum says "sometimes"; nothing to enforce.
 * - `unclassified` — **the matcher could not tell.** Neither marker class
 *   matched. This is the state that must be loud: it is where every
 *   recurrence of this bug class has lived, wearing `unable`'s clothes.
 */
export type LabelConditionality = 'unconditional' | 'conditional' | 'unclassified';

export function classifyLearnLabel(text: string): LabelConditionality {
  if (UNCONDITIONAL_MARKERS.test(text)) return 'unconditional';
  if (CONDITIONAL_MARKERS.test(text)) return 'conditional';
  return 'unclassified';
}

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

/** Keep a quoted label readable in a one-line verdict reason. */
function trimLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
}

export function checkTaughtStepsCollectable(
  learn: Blueprint | undefined | null,
  deliver: Blueprint | undefined | null,
): TaughtVsCollectableReport {
  const findings: TaughtFinding[] = [];
  let taughtAny = false;
  // ace#2856: what the matcher DID see, so `unable` can say which of its two
  // meanings it means. `unclassified` is the one that used to be invisible.
  const conditional: string[] = [];
  const unclassified: string[] = [];

  const deliverFields = (deliver?.modules ?? []).flatMap((m) =>
    (m.forms ?? []).flatMap((f) => flatten(f.fields)),
  );

  for (const mod of learn?.modules ?? []) {
    for (const form of mod.forms ?? []) {
      for (const field of form.fields ?? []) {
        const text = field.label ?? '';
        if (!text) continue;
        // Only labels that teach an evidence action are of any interest — the
        // conditionality of a label about something else is irrelevant, and
        // counting it would make `unclassified` fire on every curriculum.
        if (!EVIDENCE_ACTIONS.some((a) => a.phrases.test(text))) continue;
        const conditionality = classifyLearnLabel(text);
        if (conditionality !== 'unconditional') {
          (conditionality === 'conditional' ? conditional : unclassified).push(text.trim());
          continue;
        }
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
    // Three different facts used to print one sentence (ace#2856). The point
    // of splitting them is that a reader can now tell a correct negative from
    // a matcher that gave up, which is precisely what four recurrences of this
    // bug class needed and did not have.
    if (unclassified.length > 0) {
      return unable(
        `MATCHER LIMITED, not a clean negative: ${unclassified.length} Learn label(s) teach an ` +
          'evidence action, and the matcher could classify NONE of them as either unconditional or ' +
          'conditional — so this is most likely the recurring matcher bug (ace#1332, #1538, #1576, ' +
          '#1634, #1793, #2856), not a curriculum that teaches nothing unconditionally. READ THESE ' +
          `AND DECIDE BY HAND: ${unclassified.map((t) => JSON.stringify(trimLabel(t))).join('; ')}` +
          (conditional.length > 0
            ? `. (${conditional.length} further label(s) WERE read as conditional.)`
            : ''),
      );
    }
    if (conditional.length > 0) {
      return unable(
        `the curriculum teaches ${conditional.length} evidence step(s) and states every one of them ` +
          'CONDITIONALLY, so the Deliver form is under no obligation to collect on all branches and ' +
          'there is nothing to cross-check. This is a read of the curriculum, not a matcher giving ' +
          `up: ${conditional.map((t) => JSON.stringify(trimLabel(t))).join('; ')}`,
      );
    }
    return unable(
      'no Learn label teaches an evidence step at all (none matched an EVIDENCE_ACTIONS phrase), so ' +
        'there was nothing to cross-check against the Deliver form. If the curriculum DOES teach ' +
        'one — a photograph, a GPS fix, an audio recording — the EVIDENCE_ACTIONS matcher is the bug',
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
