/**
 * Optional `/ace:run` steps: one resolver, one persisted block.
 *
 * A run can opt into extra steps that are OFF by default (spec:
 * `docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md` § A). They are
 * declared two ways:
 *
 *   - `/ace:run --with <step>[,<step>…]` for this run, and
 *   - `opp.yaml.optional_steps:` as a standing per-opp default, which the operator
 *     writes and no skill mutates.
 *
 * At Pre-flight the orchestrator resolves both into ONE top-level
 * `run_state.yaml.optional_steps` block, the only thing a downstream skill reads.
 * A resume reads the block and never re-resolves, so an `opp.yaml` edit cannot
 * change a run in flight (run independence). **A missing block means every step
 * is off**, and that is how every run that predates this module reads.
 *
 * The implications live here, not in the skills that consume them (§ A2):
 *
 *   - `seed_responses`, `ace_winner` and `supply_chain` FORCE
 *     `private_solicitation: true`. Fabricated responses must never sit on a
 *     listed call; this is a hard rule, not a default.
 *   - `supply_chain` and `simulate_weeks` REQUIRE `ace_winner`: with no real
 *     awardee there is nobody to procure for. This is a refusal, not an
 *     implication, so the operator says out loud that ACE plays the winner.
 *   - `google_form` does NOT imply `private_solicitation` (a private call can
 *     still have a public form).
 *   - `--invite-candidates` together with `seed_responses` is refused, so real
 *     candidates are never invited to a call full of fabricated responses (§ A3).
 *   - An unknown step name is an error, never ignored: a typo must not silently
 *     drop the privacy rule a step was meant to bring with it.
 */

export const OPTIONAL_STEP_NAMES = [
  'private_solicitation',
  'google_form',
  'seed_responses',
  'ace_winner',
  'supply_chain',
  'simulate_weeks',
] as const;
export type OptionalStepName = (typeof OPTIONAL_STEP_NAMES)[number];

/** `labs_e2e` expands to every step, with `simulate_weeks=4`. */
export const OPTIONAL_STEP_ALIASES: Record<string, readonly string[]> = {
  labs_e2e: [
    'private_solicitation',
    'google_form',
    'seed_responses',
    'ace_winner',
    'supply_chain',
    'simulate_weeks=4',
  ],
};

export const DEFAULT_SEED_RESPONSE_COUNT = 5;
export const DEFAULT_SIMULATE_WEEKS = 4;
const SEED_COUNT_RANGE = [2, 20] as const;
const SIMULATE_WEEKS_RANGE = [1, 12] as const;

/** The steps that force a private solicitation when enabled. */
const FORCES_PRIVATE: readonly OptionalStepName[] = ['seed_responses', 'ace_winner', 'supply_chain'];
/** The steps that require the ACE-owned winner. */
const REQUIRES_ACE_WINNER: readonly OptionalStepName[] = ['supply_chain', 'simulate_weeks'];

/** The persisted `run_state.yaml.optional_steps` block. Every key is always present. */
export interface OptionalSteps {
  resolved_at: string;
  source: 'flag' | 'opp.yaml' | 'both';
  private_solicitation: boolean;
  google_form: boolean;
  seed_responses: false | { count: number };
  ace_winner: boolean;
  supply_chain: boolean;
  simulate_weeks: false | number;
  /** Steps turned on by an implication rather than by name, and the step that forced each. */
  implied?: Partial<Record<OptionalStepName, OptionalStepName>>;
}

export type OptionalStepsErrorCode =
  | 'UNKNOWN_STEP'
  | 'BAD_VALUE'
  | 'REQUIRES_ACE_WINNER'
  | 'INVITE_CANDIDATES_CONFLICT'
  | 'BAD_OPP_YAML';

export class OptionalStepsError extends Error {
  constructor(
    readonly code: OptionalStepsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OptionalStepsError';
  }
}

interface Requested {
  steps: Set<OptionalStepName>;
  seedCount?: number;
  weeks?: number;
}

function parseInt10(raw: string, step: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new OptionalStepsError('BAD_VALUE', `\`${step}=${raw}\`: the value must be a whole number`);
  }
  return Number(raw);
}

function checkRange(n: number, [lo, hi]: readonly [number, number], step: string): number {
  if (n < lo || n > hi) {
    throw new OptionalStepsError('BAD_VALUE', `\`${step}=${n}\` is out of range (${lo}–${hi})`);
  }
  return n;
}

/** Parse one token (`seed_responses`, `seed_responses=7`, `simulate_weeks=4`, `labs_e2e`) into `into`. */
function addToken(token: string, into: Requested, origin: string): void {
  const t = token.trim();
  if (!t) return;
  const alias = OPTIONAL_STEP_ALIASES[t];
  if (alias) {
    for (const a of alias) addToken(a, into, origin);
    return;
  }
  const [name, value] = t.split('=', 2) as [string, string | undefined];
  if (!(OPTIONAL_STEP_NAMES as readonly string[]).includes(name)) {
    const known = [...OPTIONAL_STEP_NAMES, ...Object.keys(OPTIONAL_STEP_ALIASES)].join(', ');
    throw new OptionalStepsError('UNKNOWN_STEP', `unknown optional step \`${name}\` (from ${origin}); known: ${known}`);
  }
  const step = name as OptionalStepName;
  if (value !== undefined) {
    if (step === 'seed_responses') into.seedCount = checkRange(parseInt10(value, step), SEED_COUNT_RANGE, step);
    else if (step === 'simulate_weeks') into.weeks = checkRange(parseInt10(value, step), SIMULATE_WEEKS_RANGE, step);
    else throw new OptionalStepsError('BAD_VALUE', `\`${step}\` takes no value (got \`${t}\`)`);
  }
  into.steps.add(step);
}

/** Parse the raw `--with` value. Empty / undefined → nothing requested. */
export function parseWithFlag(raw: string | undefined): Requested {
  const into: Requested = { steps: new Set() };
  if (raw) for (const tok of raw.split(',')) addToken(tok, into, '--with');
  return into;
}

/**
 * Parse `opp.yaml.optional_steps`. Two shapes are accepted:
 *   - a list of the same tokens `--with` takes: `[labs_e2e]`, `[seed_responses=7, …]`;
 *   - a mapping: `{private_solicitation: true, seed_responses: {count: 7}, simulate_weeks: 4}`.
 * A `false` mapping value means "not requested". Anything else is BAD_OPP_YAML.
 */
export function parseOppYamlSteps(value: unknown): Requested {
  const into: Requested = { steps: new Set() };
  if (value === undefined || value === null) return into;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v !== 'string') {
        throw new OptionalStepsError('BAD_OPP_YAML', 'opp.yaml optional_steps list entries must be strings');
      }
      addToken(v, into, 'opp.yaml');
    }
    return into;
  }
  if (typeof value !== 'object') {
    throw new OptionalStepsError('BAD_OPP_YAML', 'opp.yaml optional_steps must be a list or a mapping');
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === false || v === null) continue;
    if (k === 'seed_responses' && typeof v === 'object' && v !== null && 'count' in v) {
      addToken(`seed_responses=${(v as { count: unknown }).count}`, into, 'opp.yaml');
    } else if (k === 'simulate_weeks' && typeof v === 'number') {
      addToken(`simulate_weeks=${v}`, into, 'opp.yaml');
    } else if (v === true) {
      addToken(k, into, 'opp.yaml');
    } else {
      throw new OptionalStepsError('BAD_OPP_YAML', `opp.yaml optional_steps.${k}: unsupported value ${JSON.stringify(v)}`);
    }
  }
  return into;
}

export interface ResolveOptionalStepsInput {
  /** Raw `--with` value, as typed. */
  withFlag?: string;
  /** `opp.yaml.optional_steps`, as parsed. */
  oppYamlSteps?: unknown;
  /** `--invite-candidates` / `ACE_SOLICITATION_INVITE_CANDIDATES=1`. */
  inviteCandidates?: boolean;
  now?: Date;
}

/**
 * Resolve the run's optional steps. Returns `null` when nothing is requested.
 * `null` means "write no block", which keeps a default run byte-identical to
 * one from before this module existed. Throws `OptionalStepsError` on a refusal.
 *
 * The flag wins over `opp.yaml` on a value conflict (`simulate_weeks=6` vs `4`),
 * because it is the more specific, more recent instruction.
 */
export function resolveOptionalSteps(input: ResolveOptionalStepsInput): OptionalSteps | null {
  const flag = parseWithFlag(input.withFlag);
  const opp = parseOppYamlSteps(input.oppYamlSteps);
  if (flag.steps.size === 0 && opp.steps.size === 0) return null;

  const steps = new Set<OptionalStepName>([...opp.steps, ...flag.steps]);
  const source: OptionalSteps['source'] =
    flag.steps.size > 0 && opp.steps.size > 0 ? 'both' : flag.steps.size > 0 ? 'flag' : 'opp.yaml';

  for (const s of REQUIRES_ACE_WINNER) {
    if (steps.has(s) && !steps.has('ace_winner')) {
      throw new OptionalStepsError(
        'REQUIRES_ACE_WINNER',
        `\`${s}\` needs \`ace_winner\`: with no real awardee there is no one to procure or deliver for. Add \`ace_winner\` (or use \`labs_e2e\`).`,
      );
    }
  }
  if (steps.has('seed_responses') && input.inviteCandidates) {
    throw new OptionalStepsError(
      'INVITE_CANDIDATES_CONFLICT',
      '`seed_responses` cannot run with `--invite-candidates`: real candidates would be invited to a call full of fabricated responses.',
    );
  }

  const implied: Partial<Record<OptionalStepName, OptionalStepName>> = {};
  if (!steps.has('private_solicitation')) {
    const forcer = FORCES_PRIVATE.find((s) => steps.has(s));
    if (forcer) {
      steps.add('private_solicitation');
      implied.private_solicitation = forcer;
    }
  }

  const seedCount = flag.seedCount ?? opp.seedCount ?? DEFAULT_SEED_RESPONSE_COUNT;
  const weeks = flag.weeks ?? opp.weeks ?? DEFAULT_SIMULATE_WEEKS;
  const out: OptionalSteps = {
    resolved_at: (input.now ?? new Date()).toISOString(),
    source,
    private_solicitation: steps.has('private_solicitation'),
    google_form: steps.has('google_form'),
    seed_responses: steps.has('seed_responses') ? { count: seedCount } : false,
    ace_winner: steps.has('ace_winner'),
    supply_chain: steps.has('supply_chain'),
    simulate_weeks: steps.has('simulate_weeks') ? weeks : false,
  };
  if (Object.keys(implied).length > 0) out.implied = implied;
  return out;
}

/**
 * Is `step` enabled in this run? Reads ONLY the persisted block, never the
 * flag or opp.yaml. An absent block, or a run_state with none, reads as off.
 */
export function isOptionalStepEnabled(runState: unknown, step: OptionalStepName): boolean {
  if (!runState || typeof runState !== 'object') return false;
  const block = (runState as Record<string, unknown>).optional_steps;
  if (!block || typeof block !== 'object') return false;
  const v = (block as Record<string, unknown>)[step];
  return v !== false && v !== undefined && v !== null;
}

/**
 * Validate a persisted `optional_steps` block's SHAPE, for
 * `lib/run-state-validator.ts`. An absent block is valid: it means all off.
 * It also re-checks the hard implications, so a hand-edited block cannot hold
 * `seed_responses` on a public call.
 */
export function validateOptionalStepsBlock(value: unknown): string[] {
  const issues: string[] = [];
  if (value === undefined || value === null) return issues;
  if (typeof value !== 'object' || Array.isArray(value)) return ['optional_steps must be a mapping'];
  const b = value as Record<string, unknown>;
  const allowed = new Set<string>(['resolved_at', 'source', 'implied', ...OPTIONAL_STEP_NAMES]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) issues.push(`unknown key optional_steps.${k}`);
  if (typeof b.resolved_at !== 'string') issues.push('optional_steps.resolved_at must be an ISO timestamp string');
  if (!['flag', 'opp.yaml', 'both'].includes(b.source as string)) {
    issues.push('optional_steps.source must be one of: flag, opp.yaml, both');
  }
  for (const k of ['private_solicitation', 'google_form', 'ace_winner', 'supply_chain'] as const) {
    if (typeof b[k] !== 'boolean') issues.push(`optional_steps.${k} must be a boolean`);
  }
  const seed = b.seed_responses;
  if (!(seed === false || (typeof seed === 'object' && seed !== null && Number.isInteger((seed as { count?: unknown }).count)))) {
    issues.push('optional_steps.seed_responses must be false or {count: <int>}');
  }
  const weeks = b.simulate_weeks;
  if (!(weeks === false || (typeof weeks === 'number' && Number.isInteger(weeks) && weeks > 0))) {
    issues.push('optional_steps.simulate_weeks must be false or a positive integer');
  }
  const on = (k: OptionalStepName) => b[k] !== false && b[k] !== undefined && b[k] !== null;
  for (const s of FORCES_PRIVATE) {
    if (on(s) && b.private_solicitation !== true) {
      issues.push(`optional_steps.${s} is on but private_solicitation is not true (${s} forces a private call)`);
    }
  }
  for (const s of REQUIRES_ACE_WINNER) {
    if (on(s) && b.ace_winner !== true) issues.push(`optional_steps.${s} is on but ace_winner is not`);
  }
  return issues;
}

/** Render the block as the YAML the orchestrator writes into run_state.yaml (top level). */
export function renderOptionalStepsYaml(steps: OptionalSteps): string {
  const lines = [
    'optional_steps:',
    `  resolved_at: ${steps.resolved_at}`,
    `  source: ${steps.source === 'opp.yaml' ? '"opp.yaml"' : steps.source}`,
    `  private_solicitation: ${steps.private_solicitation}`,
    `  google_form: ${steps.google_form}`,
    `  seed_responses: ${steps.seed_responses === false ? 'false' : `{ count: ${steps.seed_responses.count} }`}`,
    `  ace_winner: ${steps.ace_winner}`,
    `  supply_chain: ${steps.supply_chain}`,
    `  simulate_weeks: ${steps.simulate_weeks}`,
  ];
  if (steps.implied) {
    lines.push('  implied:');
    for (const [k, v] of Object.entries(steps.implied)) lines.push(`    ${k}: ${v}`);
  }
  return lines.join('\n');
}
