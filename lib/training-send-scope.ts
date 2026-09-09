/**
 * Which training artifacts an outbound email is allowed to include.
 *
 * ## The rule this encodes (operator decision, 2026-09-09; ace#2333)
 *
 * **ACE always GENERATES every training artifact. Only SENDING is scoped.**
 *
 * Both halves are load-bearing, and the first one is the half that gets
 * "optimised" away. When the operator says "for the turmeric-market-study, we
 * only need the training deck", that is an instruction about what leaves the
 * building — not a licence to stop producing the FLW guide, the LLO guide, the
 * quick reference or the FAQ. A previous pass read the same sentence as
 * permission to delete five Phase 6 producers plus their evals and manifest
 * entries; the producers are cheap, the artifacts are useful internally, and a
 * deleted producer is a capability the next opportunity silently lacks.
 *
 * So: the producers stay unconditional. This module governs the attachment /
 * link list on the way out, and nothing else. Nothing here may be imported by
 * a producer to decide whether to run.
 *
 * ## Why a module rather than a line in each skill
 *
 * The send decision is made in two places — `training-onboarding-email`
 * composes the links (Phase 6) and `llo-onboarding` performs the send
 * (Phase 9). Before this module, `training-onboarding-email`'s self-check
 * asserted "All three sibling docs are linked" unconditionally, which made
 * honouring a narrower request a *test failure*. Two skills disagreeing about
 * what may be sent is how an out-of-scope document reaches an external
 * organisation, so the list and the check live in one place.
 */

/**
 * Every training artifact that may be attached to or linked from an outbound
 * email, in the order they should appear when the scope is unrestricted.
 *
 * `training-onboarding-email` is deliberately absent: it is the email itself,
 * not something the email encloses.
 */
export const SENDABLE_TRAINING_ARTIFACTS = [
  'training-deck',
  'training-llo-guide',
  'training-flw-guide',
  'training-quick-reference',
  'training-faq',
] as const;

export type SendableTrainingArtifact = (typeof SENDABLE_TRAINING_ARTIFACTS)[number];

/**
 * Names an operator or an older skill may use for the same artifact.
 *
 * The repo already refers to these documents three ways — the canonical
 * basenames (`training-llo-guide.md`), `training-onboarding-email`'s Step 2
 * shorthand (`llo-manager-guide`, `flw-training-guide`, `quick-reference`), and
 * whatever a human types into a request ("just the deck"). A scope that only
 * accepted one spelling would reject the operator's own words.
 */
const ALIASES: Record<string, SendableTrainingArtifact> = {
  deck: 'training-deck',
  'training deck': 'training-deck',
  'trainingdeck': 'training-deck',
  'llo-guide': 'training-llo-guide',
  'llo guide': 'training-llo-guide',
  'llo-manager-guide': 'training-llo-guide',
  'llo manager guide': 'training-llo-guide',
  'flw-guide': 'training-flw-guide',
  'flw guide': 'training-flw-guide',
  'flw-training-guide': 'training-flw-guide',
  'flw training guide': 'training-flw-guide',
  'quick-reference': 'training-quick-reference',
  'quick reference': 'training-quick-reference',
  'quick-ref': 'training-quick-reference',
  'pocket-card': 'training-quick-reference',
  faq: 'training-faq',
};

/** Strip the decorations a filename or a human picks up along the way. */
function canonicalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.(md|gdoc|pdf|docx|pptx)$/, '')
    .replace(/[_\s]+/g, ' ')
    .trim();
}

/**
 * Resolve one operator-supplied name to a canonical artifact key, or `null` if
 * it names nothing sendable.
 */
export function normalizeArtifactKey(raw: string): SendableTrainingArtifact | null {
  const key = canonicalize(raw);
  const direct = (SENDABLE_TRAINING_ARTIFACTS as readonly string[]).find(
    (k) => k === key || k.replace(/-/g, ' ') === key,
  );
  if (direct) return direct as SendableTrainingArtifact;
  return ALIASES[key] ?? ALIASES[key.replace(/ /g, '-')] ?? null;
}

export interface SendScope {
  /** The artifacts this send may include, in canonical order. */
  keys: SendableTrainingArtifact[];
  /**
   * `true` when the operator named a subset. An unscoped send (`false`) is the
   * default and includes everything — the pre-existing behaviour.
   */
  explicit: boolean;
}

/**
 * Resolve the send scope for one outbound email.
 *
 * `undefined` / `null` means the operator said nothing, which stays "send them
 * all". An explicitly EMPTY list is an error rather than "send nothing": a
 * request to enclose no documents is a request not to send this email, and
 * silently producing a link-free onboarding email would look like a successful
 * send of a broken deliverable.
 */
export function resolveSendScope(requested?: readonly string[] | null): SendScope {
  if (requested === undefined || requested === null) {
    return { keys: [...SENDABLE_TRAINING_ARTIFACTS], explicit: false };
  }
  if (requested.length === 0) {
    throw new Error(
      'Training send scope is an empty list. To enclose nothing, do not send the ' +
        'email; to enclose everything, omit the scope. An empty scope is ambiguous ' +
        'between the two.',
    );
  }

  const unknown: string[] = [];
  const resolved = new Set<SendableTrainingArtifact>();
  for (const raw of requested) {
    const key = normalizeArtifactKey(raw);
    if (key === null) unknown.push(raw);
    else resolved.add(key);
  }

  if (unknown.length > 0) {
    throw new Error(
      `Training send scope names ${unknown.length} artifact(s) ACE cannot send: ` +
        `${unknown.map((u) => JSON.stringify(u)).join(', ')}.\n` +
        `Sendable: ${SENDABLE_TRAINING_ARTIFACTS.join(', ')}.\n` +
        'A typo must fail loudly here — resolving it to "send everything" is how an ' +
        'out-of-scope document reaches an external organisation.',
    );
  }

  return {
    keys: SENDABLE_TRAINING_ARTIFACTS.filter((k) => resolved.has(k)),
    explicit: true,
  };
}

/**
 * Assert that a composed email encloses nothing outside its scope.
 *
 * Deliberately one-directional. An in-scope artifact that is MISSING is a
 * different defect with a different cause (a phase-ordering bug, an unresolved
 * Drive link) and is checked where the links are resolved; this function exists
 * to stop the leak, and conflating the two would make the leak check skippable
 * whenever a link happened to be missing.
 */
export function assertSendScopeRespected(
  scope: SendScope,
  included: readonly string[],
): void {
  const allowed = new Set<string>(scope.keys);
  const leaked: string[] = [];
  for (const raw of included) {
    const key = normalizeArtifactKey(raw);
    if (key !== null && !allowed.has(key)) leaked.push(key);
  }
  if (leaked.length > 0) {
    throw new Error(
      `This send encloses ${leaked.length} artifact(s) outside its scope: ` +
        `${[...new Set(leaked)].join(', ')}.\n` +
        `In scope: ${scope.keys.join(', ')}.\n` +
        'Remove the links/attachments rather than widening the scope — the scope is ' +
        'the operator\'s instruction about what the recipient receives.',
    );
  }
}

/** Human-readable one-liner for a phase summary or a decisions row. */
export function describeSendScope(scope: SendScope): string {
  return scope.explicit
    ? `scoped to ${scope.keys.length} artifact(s): ${scope.keys.join(', ')}`
    : `unscoped — all ${scope.keys.length} training artifacts`;
}
