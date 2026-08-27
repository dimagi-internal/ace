/**
 * Two ways the label a field worker actually reads stops matching the label
 * ACE authored — both invisible to every structural gate, because the app is
 * internally consistent with the wrong text.
 *
 * ## 1. CommCare renders choice labels as MARKDOWN (ace#1689)
 *
 * Nova emits every choice label with a markdown twin, and CommCare prefers it:
 *
 * ```xml
 * <value>1. Planning</value>
 * <value form="markdown">1. Planning</value>
 * ```
 *
 * `1. Planning` at the start of a line *is* a markdown ordered-list item, so
 * the renderer consumes the `1. ` marker and the radio button reads `Planning`.
 * Live device truth from `spark-facilitator/20260820-0817`, same screen:
 *
 * ```
 * "Which FCAP phase is this community in now?"
 * "Planning"            <- authored "1. Planning"
 * "Implementation"      <- authored "2. Implementation"
 * "Transition"          <- authored "4. Transition"
 * ```
 *
 * Two costs, and the second is worse than the cosmetic one. A numbered
 * taxonomy loses the numbers that carry its meaning; and any recipe, training
 * screenshot or assertion that matches on the authored text can never match,
 * which is what burned a full Deliver-leg dispatch — diagnosed only by reading
 * the failure ui-dump.
 *
 * ## 2. Case-list id-mapping enums drift from the form's own choice list (ace#1688)
 *
 * The community tile the FLW reads *before* a visit renders `phase` and
 * `current_step_id` through id-mapping enums. On the same run those enums
 * carried a completely different FCAP taxonomy from the one the meeting form
 * offered, so one stored value rendered two ways:
 *
 * | stored | community tile | meeting form |
 * |--------|----------------|--------------|
 * | 1      | `1. Introduction`   | `1. Planning` |
 * | 2      | `2. Planning`       | `2. Implementation` |
 *
 * The FLW reads "this community is in Planning", opens the form, and Planning
 * is a different phase. Nothing downstream can detect this: both vocabularies
 * are well-formed, and the case list and the form are separate app surfaces
 * that no gate compares.
 *
 * ## Why these are static checks and not device work
 *
 * The device truth is already recorded — the ui-dump in ace#1689 and the
 * released CCZ in ace#1688 — and *what markdown does to a string* is a
 * property of the renderer, not of one device run. Per
 * `CLAUDE.md § device-truth classification`, everything downstream of the
 * device's response is unit-testable; a device run would tell us what happened
 * once, where the rule tells us what always happens.
 *
 * Both checks return `CheckOutcome`, so "no labels to inspect" cannot be
 * mistaken for "labels are fine" — see `lib/check-outcome.ts`.
 */
import { type CheckOutcome, checked, unable } from './check-outcome.js';

/** A single authored choice label, addressed well enough to fix. */
export interface ChoiceLabel {
  /** The stored value (the code written to the case / submitted). */
  value: string;
  /** The label text as ACE authored it. */
  label: string;
  /** Where it lives, for the finding message (form + question path). */
  location?: string;
}

export interface MarkdownEatenFinding {
  value: string;
  location?: string;
  /** What ACE wrote. */
  authored: string;
  /** What CommCare will actually display. */
  rendered: string;
  /** Which markdown construct consumed it. */
  construct: 'ordered-list' | 'bullet-list' | 'heading' | 'blockquote';
  remediation: string;
}

/**
 * What CommCare will display for an authored label, given that it renders the
 * `form="markdown"` twin.
 *
 * Only leading BLOCK constructs are modelled — those are the ones that consume
 * their marker and silently shorten the label. Inline emphasis (`*x*`) also
 * renders, but it drops decoration rather than content, and ACE has never
 * shipped a label that relied on a literal asterisk. Deliberately conservative:
 * a false "this is fine" is the failure mode that cost the dispatch, but a
 * false alarm on a legitimate label would train people to ignore the check.
 */
export function renderMarkdownLabel(authored: string): {
  rendered: string;
  construct?: MarkdownEatenFinding['construct'];
} {
  // CommonMark ordered list: 1-9 digits, then `.` or `)`, then a space.
  const ordered = /^(\d{1,9})[.)][ \t]+(?=\S)/.exec(authored);
  if (ordered) {
    return { rendered: authored.slice(ordered[0].length), construct: 'ordered-list' };
  }
  const bullet = /^[-*+][ \t]+(?=\S)/.exec(authored);
  if (bullet) {
    return { rendered: authored.slice(bullet[0].length), construct: 'bullet-list' };
  }
  const heading = /^#{1,6}[ \t]+(?=\S)/.exec(authored);
  if (heading) {
    return { rendered: authored.slice(heading[0].length), construct: 'heading' };
  }
  const quote = /^>[ \t]*(?=\S)/.exec(authored);
  if (quote) {
    return { rendered: authored.slice(quote[0].length), construct: 'blockquote' };
  }
  return { rendered: authored };
}

/**
 * Flag every choice label whose displayed text differs from its authored text.
 *
 * `unable` when there are no labels to inspect: a build that produced no
 * choice list at all is a different problem, and reporting "ok" for it is the
 * blind-check-renders-as-pass class this repo has hit four times.
 */
export function checkMarkdownEatenLabels(
  labels: ChoiceLabel[],
): CheckOutcome<MarkdownEatenFinding> {
  if (labels.length === 0) {
    return unable('no choice labels were supplied to inspect');
  }
  const findings: MarkdownEatenFinding[] = [];
  for (const l of labels) {
    const { rendered, construct } = renderMarkdownLabel(l.label);
    if (construct && rendered !== l.label) {
      findings.push({
        value: l.value,
        location: l.location,
        authored: l.label,
        rendered,
        construct,
        remediation:
          construct === 'ordered-list'
            ? `CommCare will display "${rendered}", dropping the number. If the ` +
              `number carries meaning, keep it out of markdown's way — e.g. ` +
              `"Phase ${l.value}: ${rendered}" or "${l.label.replace(/^(\d{1,9})[.)][ \t]+/, '$1 - ')}". ` +
              `If it does not, drop it from the authored label so recipes and ` +
              `screenshots match what the device shows.`
            : `CommCare will display "${rendered}". Rewrite the label so it does ` +
              `not start with a markdown ${construct} marker.`,
      });
    }
  }
  return checked(findings.length === 0, findings);
}

export interface EnumDriftFinding {
  value: string;
  /** Label the case list (the tile the FLW reads before the visit) shows. */
  caseListLabel: string;
  /** Label the form's own choice list offers for the same stored value. */
  formLabel: string | null;
  kind: 'label-mismatch' | 'missing-from-form';
  remediation: string;
}

/**
 * What `checkCaseListEnumDrift` reports ALONGSIDE its findings.
 *
 * `unlabelledInCaseList` is deliberately NOT a finding. The rule is SUBSET,
 * not equality: a case list may legitimately render fewer entries than the
 * form offers — a tile that labels only the phases the pilot window covers is
 * a design decision, not drift. Demanding equality would fire on every such
 * app, and a check that cries wolf gets ignored, which is worse than the
 * defect. It is surfaced because the tile renders the raw stored code for
 * these values, which is worth SEEING without being worth FAILING.
 */
export interface EnumDriftExtras {
  unlabelledInCaseList: string[];
}

/**
 * Diff a case-list id-mapping enum against the choice list of the form that
 * writes the value.
 *
 * The form is the authority: it is what the FLW picks from, and what the stored
 * value means. A case-list enum that disagrees is stale or invented.
 *
 * **The rule is SUBSET, not equality.** Every entry the case list DOES render
 * must agree with the form; the case list need not render every entry the form
 * offers. Equality would fail a tile that deliberately labels only the phases
 * a pilot window covers, and a check with false positives is one people learn
 * to skip. Values the form can store but the tile has no label for come back
 * as `unlabelledInCaseList` — visible, not fatal.
 */
export function checkCaseListEnumDrift(input: {
  /** Property being rendered, e.g. `phase` — used in messages only. */
  property: string;
  /** value -> label, as the case list's id-mapping declares. */
  caseListEnums: Record<string, string>;
  /** value -> label, from the form's `select1` choice list. */
  formChoices: Record<string, string>;
}): CheckOutcome<EnumDriftFinding, EnumDriftExtras> {
  const { property, caseListEnums, formChoices } = input;
  if (Object.keys(caseListEnums).length === 0) {
    return unable(`case list declares no id-mapping enum for "${property}" to compare`);
  }
  if (Object.keys(formChoices).length === 0) {
    return unable(
      `no form choice list was supplied for "${property}" — the form is the ` +
        `authority here, so without it there is nothing to diff against`,
    );
  }

  const findings: EnumDriftFinding[] = [];
  for (const value of Object.keys(caseListEnums).sort()) {
    const caseListLabel = caseListEnums[value];
    const formLabel = formChoices[value] ?? null;
    if (formLabel === null) {
      findings.push({
        value,
        caseListLabel,
        formLabel,
        kind: 'missing-from-form',
        remediation:
          `The case list renders "${value}" as "${caseListLabel}", but the form ` +
          `offers no such value for "${property}" — so no FLW can ever produce it. ` +
          `Either the enum is stale or the form lost an option.`,
      });
    } else if (caseListLabel !== formLabel) {
      findings.push({
        value,
        caseListLabel,
        formLabel,
        kind: 'label-mismatch',
        remediation:
          `Stored "${value}" reads as "${caseListLabel}" on the community tile and ` +
          `"${formLabel}" in the form. The FLW reads one taxonomy before the visit ` +
          `and picks from another during it. The form is the authority — align the ` +
          `case-list id-mapping for "${property}" to it.`,
      });
    }
  }
  const unlabelledInCaseList = Object.keys(formChoices)
    .filter((v) => !(v in caseListEnums))
    .sort();
  return { ...checked(findings.length === 0, findings), unlabelledInCaseList };
}
