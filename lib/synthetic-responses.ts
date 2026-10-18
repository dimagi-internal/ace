/**
 * Synthetic solicitation responses: validate a seed plan, then build the
 * `create_response` payloads. Pure; no I/O.
 *
 * Used by `skills/solicitation-seed-responses` (spec
 * `docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md` § D) and by
 * its `-qa` partner. The skill composes the personas (that part is judgment);
 * this module is the part that must not be judgment. Every rule here guards
 * something a fabricated response must never do:
 *
 *   - **Pass itself off as a real organisation.** Every fictional org name
 *     carries the `[Synthetic]` suffix, and no fictional name may match a real
 *     one (case-insensitive, punctuation-folded) — checked against whatever
 *     real-name list the caller passes (the LLO Directory + `labs_context`).
 *   - **Name a party the opportunity must keep out of LLO-facing text.** The
 *     deny list is per-opp data the caller reads from the opp's `inputs/`;
 *     nothing opp-specific lives here.
 *   - **Use a made-up third-party address.** `submitted_by_email` is always
 *     ACE's own mailbox with a `+synthetic-<n>` tag, built here, never taken
 *     from the persona.
 *   - **Leave a required question blank by accident.** Only a persona flagged
 *     `missing_answer` may skip one, and it must actually skip one.
 *
 * The winner is the one respondent that is NOT fictional: it is the ACE-owned
 * org (`llo_org`), bound by `llo_entity_id` (its labs slug) and carrying
 * `org_id` = its CONNECT organisation id as a string. That is what
 * `award_response.org_id` takes (spec § K1; stated by jjackson/connect-labs#2605; pinned live 2026-10-18 in
 * `test/fixtures/labs/seed-responses-probe-2026-10-18.json`). A response
 * created without `org_id` reads back `org_id: ""`, and one created without
 * `org_name` reads back the submitter's name as its org name, so the builder
 * always sends both.
 */

export const SYNTHETIC_SUFFIX = '[Synthetic]';

/** A folded real name shorter than this is too generic to match by containment. */
const MIN_CONTAINMENT_LENGTH = 5;

export interface SolicitationQuestion {
  id: string;
  required?: boolean;
  text?: string;
  type?: string;
}

export type PersonaFlag = 'missing_answer' | 'over_budget' | 'strong' | 'weak';

export interface WinnerBinding {
  /** The winner's labs org slug (`create_response.llo_entity_id`). */
  llo_entity_id: string;
  /** The winner's Connect organisation integer id (`award_response.org_id`). */
  connect_org_id: string | number;
}

export interface SyntheticPersona {
  /** Stable key for the roster (e.g. `strong-north`). */
  key: string;
  org_name: string;
  /** What this persona was built to exercise in the review. */
  intended_profile: string;
  /** Question id -> answer text. */
  answers: Record<string, string>;
  submitted_by_name: string;
  /** ISO timestamp inside the call's open window. */
  submission_date: string;
  flags?: PersonaFlag[];
  /** Present on exactly one persona: the ACE-owned winner. */
  winner?: WinnerBinding;
}

export interface SeedPlanInput {
  solicitation_id: number;
  questions: SolicitationQuestion[];
  personas: SyntheticPersona[];
  /** Expected number of responses, winner included. */
  count: number;
  /** ACE's mailbox, from `config/agent.json` `email`. */
  mailbox: string;
  /** Real organisation names a fictional one must not match. */
  real_org_names: string[];
  /** Parties that must never appear in LLO-facing text (per-opp data). */
  deny_list: string[];
}

export interface CreateResponsePayload {
  solicitation_id: number;
  org_name: string;
  responses: Record<string, string>;
  submitted_by_name: string;
  submitted_by_email: string;
  submission_date: string;
  status: 'submitted';
  llo_entity_id?: string;
  org_id?: string;
}

export interface SeedPlanError {
  persona?: string;
  code:
    | 'COUNT_MISMATCH'
    | 'WINNER_COUNT'
    | 'WINNER_UNBOUND'
    | 'WINNER_MISSING_ANSWER'
    | 'MISSING_SUFFIX'
    | 'REAL_ORG_COLLISION'
    | 'DENY_LIST_HIT'
    | 'UNANSWERED_REQUIRED'
    | 'MISSING_ANSWER_NOT_MISSING'
    | 'UNKNOWN_QUESTION'
    | 'DUPLICATE_NAME'
    | 'DUPLICATE_KEY'
    | 'BAD_DATE'
    | 'BAD_MAILBOX';
  message: string;
}

export class SeedPlanValidationError extends Error {
  constructor(public readonly errors: SeedPlanError[]) {
    super(`seed plan refused: ${errors.map((e) => `${e.code}${e.persona ? `(${e.persona})` : ''}: ${e.message}`).join('; ')}`);
    this.name = 'SeedPlanValidationError';
  }
}

/** Lowercase, non-alphanumerics to single spaces, trimmed. `Give-Directly` -> `give directly`. */
export function foldName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function stripSyntheticSuffix(name: string): string {
  return name.replace(/\s*\[synthetic\]\s*$/i, '').trim();
}

/** `ace@dimagi-ai.com`, 3 -> `ace+synthetic-3@dimagi-ai.com`. */
export function syntheticEmail(mailbox: string, n: number): string {
  const at = mailbox.indexOf('@');
  if (at <= 0 || at !== mailbox.lastIndexOf('@')) {
    throw new Error(`not a mailbox address: ${mailbox}`);
  }
  const local = mailbox.slice(0, at).replace(/\+.*$/, '');
  return `${local}+synthetic-${n}${mailbox.slice(at)}`;
}

/**
 * Every deny-list term found in `text`, matched on whole folded words, so
 * `GD` catches "GD's pilot" but not "budget". Terms are matched as written and
 * also with their spaces removed, so `Give Directly` catches `GiveDirectly`.
 */
export function findDenyListHits(text: string, denyList: string[]): string[] {
  const hay = ` ${foldName(text)} `;
  const squashed = ` ${foldName(text).replace(/ /g, '')} `;
  const hits: string[] = [];
  for (const term of denyList) {
    const folded = foldName(term);
    if (!folded) continue;
    const joined = folded.replace(/ /g, '');
    const words = hay.split(' ').filter(Boolean);
    if (
      hay.includes(` ${folded} `) ||
      words.includes(joined) ||
      (joined.length >= MIN_CONTAINMENT_LENGTH && squashed.includes(joined))
    ) {
      hits.push(term);
    }
  }
  return hits;
}

/**
 * The real organisation name a fictional one collides with, or null. Equal
 * after folding (suffix stripped), or one contains the other as whole words
 * when the shorter side is long enough to be distinctive.
 */
export function findRealOrgCollision(name: string, realOrgNames: string[]): string | null {
  const mine = foldName(stripSyntheticSuffix(name));
  if (!mine) return null;
  for (const real of realOrgNames) {
    const theirs = foldName(stripSyntheticSuffix(real));
    if (!theirs) continue;
    if (mine === theirs) return real;
    const [short, long] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
    if (short.length >= MIN_CONTAINMENT_LENGTH && ` ${long} `.includes(` ${short} `)) return real;
  }
  return null;
}

/** Parse the per-opp deny list (`llo_facing_deny_list:` in the opp's inputs). */
export function normalizeDenyList(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('llo_facing_deny_list must be a list of strings');
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('llo_facing_deny_list must be a list of strings');
    const t = item.trim();
    if (t && !out.some((o) => foldName(o) === foldName(t))) out.push(t);
  }
  return out;
}

export function validateSeedPlan(input: SeedPlanInput): SeedPlanError[] {
  const errors: SeedPlanError[] = [];
  const questionIds = new Set(input.questions.map((q) => q.id));
  const required = input.questions.filter((q) => q.required).map((q) => q.id);

  try {
    syntheticEmail(input.mailbox, 1);
  } catch {
    errors.push({ code: 'BAD_MAILBOX', message: `mailbox ${JSON.stringify(input.mailbox)} is not an address` });
  }
  if (input.personas.length !== input.count) {
    errors.push({ code: 'COUNT_MISMATCH', message: `${input.personas.length} personas for count ${input.count}` });
  }
  const winners = input.personas.filter((p) => p.winner);
  if (winners.length !== 1) {
    errors.push({ code: 'WINNER_COUNT', message: `exactly one persona must be the winner, found ${winners.length}` });
  }

  const winnerNames = winners.map((w) => w.org_name);
  const realNames = input.real_org_names.filter(
    (r) => !winnerNames.some((w) => foldName(stripSyntheticSuffix(w)) === foldName(r)),
  );
  const seenNames = new Map<string, string>();
  const seenKeys = new Set<string>();

  for (const p of input.personas) {
    const who = p.key;
    if (seenKeys.has(p.key)) errors.push({ persona: who, code: 'DUPLICATE_KEY', message: `key ${p.key} repeats` });
    seenKeys.add(p.key);
    const folded = foldName(stripSyntheticSuffix(p.org_name));
    if (seenNames.has(folded)) {
      errors.push({ persona: who, code: 'DUPLICATE_NAME', message: `${p.org_name} repeats ${seenNames.get(folded)}` });
    }
    seenNames.set(folded, p.key);

    if (p.winner) {
      const id = String(p.winner.connect_org_id ?? '').trim();
      if (!p.winner.llo_entity_id?.trim() || !/^\d+$/.test(id)) {
        errors.push({
          persona: who,
          code: 'WINNER_UNBOUND',
          message: 'the winner needs llo_entity_id (labs slug) and connect_org_id (Connect integer id)',
        });
      }
      if (p.flags?.includes('missing_answer')) {
        errors.push({ persona: who, code: 'WINNER_MISSING_ANSWER', message: 'the winner may not skip a required answer' });
      }
    } else {
      if (!/\s\[Synthetic\]$/.test(p.org_name)) {
        errors.push({ persona: who, code: 'MISSING_SUFFIX', message: `${p.org_name} must end with " ${SYNTHETIC_SUFFIX}"` });
      }
      const collision = findRealOrgCollision(p.org_name, realNames);
      if (collision) {
        errors.push({ persona: who, code: 'REAL_ORG_COLLISION', message: `${p.org_name} matches real organisation ${collision}` });
      }
    }

    const texts = [p.org_name, p.submitted_by_name, ...Object.values(p.answers)];
    const hits = new Set(texts.flatMap((t) => findDenyListHits(t, input.deny_list)));
    if (hits.size) {
      errors.push({ persona: who, code: 'DENY_LIST_HIT', message: `names a party kept out of LLO-facing text: ${[...hits].join(', ')}` });
    }

    for (const id of Object.keys(p.answers)) {
      if (!questionIds.has(id)) errors.push({ persona: who, code: 'UNKNOWN_QUESTION', message: `answer for unknown question ${id}` });
    }
    const unanswered = required.filter((id) => !(p.answers[id] ?? '').trim());
    if (p.flags?.includes('missing_answer')) {
      if (!unanswered.length) {
        errors.push({ persona: who, code: 'MISSING_ANSWER_NOT_MISSING', message: 'flagged missing_answer but answers every required question' });
      }
    } else if (unanswered.length) {
      errors.push({ persona: who, code: 'UNANSWERED_REQUIRED', message: `required question(s) unanswered: ${unanswered.join(', ')}` });
    }

    if (Number.isNaN(Date.parse(p.submission_date))) {
      errors.push({ persona: who, code: 'BAD_DATE', message: `submission_date ${p.submission_date} is not ISO` });
    }
  }
  return errors;
}

/** Validate, then build one payload per persona in roster order. Throws on any error. */
export function buildCreateResponsePayloads(input: SeedPlanInput): CreateResponsePayload[] {
  const errors = validateSeedPlan(input);
  if (errors.length) throw new SeedPlanValidationError(errors);
  return input.personas.map((p, i) => {
    const responses: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.answers)) if ((v ?? '').trim()) responses[k] = v;
    const payload: CreateResponsePayload = {
      solicitation_id: input.solicitation_id,
      org_name: p.org_name,
      responses,
      submitted_by_name: p.submitted_by_name,
      submitted_by_email: syntheticEmail(input.mailbox, i + 1),
      submission_date: p.submission_date,
      status: 'submitted',
    };
    if (p.winner) {
      payload.llo_entity_id = p.winner.llo_entity_id;
      payload.org_id = String(p.winner.connect_org_id);
    }
    return payload;
  });
}

export interface ExistingResponse {
  id: number;
  org_name?: string;
  llo_entity_id?: string;
  submitted_by_email?: string;
}

/**
 * Split payloads into those still to create and those already on the call.
 * `create_response` has no idempotency key and the call's owner may file two
 * responses for one org (observed live, 2026-10-18), so a re-run must check
 * `list_responses` first. A payload matches an existing response on its
 * synthetic email tag or its folded org name.
 */
export function partitionAgainstExisting(
  payloads: CreateResponsePayload[],
  existing: ExistingResponse[],
): { create: CreateResponsePayload[]; skip: { payload: CreateResponsePayload; response_id: number }[] } {
  const create: CreateResponsePayload[] = [];
  const skip: { payload: CreateResponsePayload; response_id: number }[] = [];
  for (const payload of payloads) {
    const match = existing.find(
      (r) =>
        (r.submitted_by_email && r.submitted_by_email.toLowerCase() === payload.submitted_by_email.toLowerCase()) ||
        (r.org_name && foldName(r.org_name) === foldName(payload.org_name)),
    );
    if (match) skip.push({ payload, response_id: match.id });
    else create.push(payload);
  }
  return { create, skip };
}
