/**
 * Which wins when a PDD pins an identity-only `entity_id` grain AND the form
 * has a non-payable branch.
 *
 * ace#1434. Two instructions gave directly opposed answers and neither named a
 * precedence:
 *
 *   - `pdd-to-deliver-app-eval § connectify_wiring (b)` — "entity ID composite
 *     matches PDD formula", where the PDD pins the grain in § Program
 *     Parameters as a typed handoff and marks it source-pinned, "explicitly not
 *     to be re-litigated per run".
 *   - the same rubric's **(b2)** and `_app-component-library §
 *     payability-scoped-key` — when a subset of submissions is non-payable the
 *     key MUST carry the payability discriminator, hard-gating ≤3 otherwise.
 *
 * A build cannot satisfy both: (b2) mandates a third component, (b) mandates
 * exactly two. The SAME opportunity resolved it two different ways on
 * consecutive runs — 20260814-0856 rewrote the PDD to match the build,
 * 20260814-2019 deviated from the PDD and disclosed it as D-9. Both defensible,
 * neither specified, and #1285's counter-evidence comment already establishes
 * that a gate hard-asserting either shape will false-fail the other.
 *
 * ## The ruling: the discriminator wins, and the deviation is disclosed
 *
 * Because the two are not symmetric. Honouring the pin produces a build that is
 * WRONG in the field — the non-payable submission mints the key first and the
 * real payable visit dedups against it, so the worker is structurally blocked
 * from payment for work they did (#969, the whole reason the component exists).
 * Honouring the discriminator produces a build that is right and a PDD that is
 * out of date, which is a disclosure problem, not a payment problem. Jonathan's
 * own comment on #1285 already rules this way: "`consent_confirmed` inside the
 * key is not incoherent — it is a required preventer."
 *
 * "Source-pinned" binds against per-run re-litigation on TASTE. It does not
 * bind against a correctness preventer, and the deviation channel exists so the
 * override is visible rather than silent.
 */

export interface GrainInputs {
  /** Key components the PDD pinned, in order. */
  pinnedComponents: readonly string[];
  /** Field that discriminates payable from non-payable, when one exists. */
  payabilityDiscriminator?: string;
  /** True when the PDD marks a subset of submissions to this form non-payable. */
  hasNonPayableBranch: boolean;
  /** True when the PDD marks the grain source-pinned / not to be re-litigated. */
  sourcePinned?: boolean;
}

export type GrainResolution = {
  /** The components the build must ship, in order. */
  components: string[];
  /** True when this differs from what the PDD pinned. */
  deviates: boolean;
  /** Set when `deviates` — the build MUST disclose it as a named deviation. */
  discloseAs?: string;
  /** Set when the discriminator is needed but no field expresses it. */
  unresolvable?: true;
  reason: string;
};

/**
 * Deterministic — the property #1434 asks for. Same inputs, one verdict.
 */
export function resolveEntityIdGrain(input: GrainInputs): GrainResolution {
  const pinned = [...input.pinnedComponents];

  if (!input.hasNonPayableBranch) {
    return {
      components: pinned,
      deviates: false,
      reason:
        'No non-payable branch, so (b2) does not fire and the PDD-pinned grain stands.',
    };
  }

  if (input.payabilityDiscriminator === undefined) {
    // The component's own escape hatch: do NOT ship the identity-only key
    // silently. Record it and name the field that would fix it.
    return {
      components: pinned,
      deviates: false,
      unresolvable: true,
      reason:
        'A non-payable branch exists but no form field expresses payability, so the ' +
        'discriminator cannot be a key component. Ship the pinned grain and RECORD in ' +
        'the build memo that non-payable submissions share the payable key space, ' +
        'naming the field that would fix it. Do not ship this silently.',
    };
  }

  if (pinned.includes(input.payabilityDiscriminator)) {
    return {
      components: pinned,
      deviates: false,
      reason: 'The PDD already pins the payability discriminator; (b) and (b2) agree.',
    };
  }

  return {
    components: [...pinned, input.payabilityDiscriminator],
    deviates: true,
    discloseAs: `entity_id grain extended with '${input.payabilityDiscriminator}' (payability discriminator)`,
    reason:
      `The PDD pins an identity-only grain (${pinned.join(' + ')}) and a non-payable ` +
      `branch exists, so (b2) requires '${input.payabilityDiscriminator}' in the key. ` +
      'The discriminator wins: honouring the pin blocks a worker from payment for work ' +
      'they did (#969), while honouring the discriminator leaves the PDD out of date — ' +
      'a disclosure problem, not a payment problem. Disclose it as a named deviation.' +
      (input.sourcePinned
        ? ' "Source-pinned" binds against per-run re-litigation on taste, not against a ' +
          'correctness preventer (ace#1434).'
        : ''),
  };
}
