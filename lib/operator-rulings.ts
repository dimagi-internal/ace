/**
 * Per-opp operator rulings — the sanctioned way for an operator to override a
 * STANDING design assumption for one opp.
 *
 * `skills/idea-to-pdd § Standing design assumptions` holds two rules that
 * apply to every ACE design (operator directive, 2026-09-26): every worker has
 * a smartphone with data (`devices-assumed`), and the Connect app is the
 * system of record (`system-of-record`). On 2026-10-04 the owner ruled, for
 * spark-facilitator ONLY, that devices are costed separately and asked about.
 * Before this file there was no way to carry that: a run that honoured it was
 * violating a standing rule, and one that did not was ignoring the owner.
 *
 * `ACE/<opp>/inputs/operator-rulings.yaml` (schema v1 below) is opp-level and
 * operator-written. Producer skills read it and honour a ruling over the
 * standing assumption for the artifacts it names (`applies_to`), and record a
 * decision row per ruling. That row is sent as `status: ai-default` with
 * `feedback_ref: operator-rulings/<ruling id>`; the decisions write boundary
 * (`applyOperatorRulings`, called from `composeAppendedLog`) stamps
 * `status: human-decided` + `decided_by` / `decided_at` FROM THIS FILE — the
 * same attribution path `applyDecisionOverrides` uses for a reviewer's saved
 * ruling, because a caller may never assert `human-decided` itself
 * (ace#2307: an agent asserting a human ruled fabricates one).
 */

import yaml from 'yaml';
import { z } from 'zod';

import type { DecisionRow } from './decisions-schema.js';
import { auditOutsiderText } from './pdd-description-plain-language.js';

/** Canonical filename under `ACE/<opp>/inputs/`. */
export const OPERATOR_RULINGS_FILENAME = 'operator-rulings.yaml' as const;
export const OPERATOR_RULINGS_SCHEMA_VERSION = 1 as const;

/** The `feedback_ref` record slug a ruling's decision rows carry. */
export const OPERATOR_RULINGS_REF_SLUG = 'operator-rulings' as const;

/**
 * The standing assumptions a ruling may override, keyed as
 * `skills/idea-to-pdd § Standing design assumptions` numbers them.
 */
export const STANDING_ASSUMPTIONS = {
  'devices-assumed':
    'Every worker has a smartphone that runs Connect, with a data connection; devices and data are never raised, costed or asked about.',
  'system-of-record':
    'The Connect app is the system of record for the work it records, replacing whatever the partner uses today.',
} as const;
export type StandingAssumptionKey = keyof typeof STANDING_ASSUMPTIONS;
export const STANDING_ASSUMPTION_KEYS = Object.keys(STANDING_ASSUMPTIONS) as StandingAssumptionKey[];

/** The artifacts a ruling can apply to. */
export const RULING_ARTIFACTS = ['pdd', 'solicitation', 'work-order', 'apps', 'connect', 'training', 'chatbot'] as const;
export type RulingArtifact = (typeof RULING_ARTIFACTS)[number];

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const OperatorRulingSchema = z
  .object({
    id: z.string().regex(KEBAB, { message: 'id must be kebab-case' }),
    ruling: z.string().min(1).describe('The ruling in plain language, as the operator gave it.'),
    overrides: z
      .enum(STANDING_ASSUMPTION_KEYS as [StandingAssumptionKey, ...StandingAssumptionKey[]])
      .optional()
      .describe('The standing assumption this ruling overrides for this opp, when it overrides one.'),
    decided_by: z.string().min(1).describe('Email of the person who ruled.'),
    decided_at: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ].*)?$/, { message: 'decided_at must be an ISO date' }),
    applies_to: z.array(z.enum(RULING_ARTIFACTS)).min(1),
  })
  .superRefine((r, ctx) => {
    for (const issue of auditOutsiderText(r.ruling, 'outsider')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ruling must read in plain language (${issue.kind}: "${issue.token}") — it is shown to reviewers on the decision row it creates`,
        path: ['ruling'],
      });
    }
  });
export type OperatorRuling = z.infer<typeof OperatorRulingSchema>;

export const OperatorRulingsFileSchema = z
  .object({
    schema_version: z.literal(OPERATOR_RULINGS_SCHEMA_VERSION),
    kind: z.literal('operator-rulings'),
    opp: z.string().min(1),
    rulings: z.array(OperatorRulingSchema),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.rulings.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ruling id: ${r.id}`, path: ['rulings', i, 'id'] });
      seen.add(r.id);
    });
  });
export type OperatorRulingsFile = z.infer<typeof OperatorRulingsFileSchema>;

export class OperatorRulingsError extends Error {
  readonly code = 'MALFORMED_OPERATOR_RULINGS' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OperatorRulingsError';
  }
}

/**
 * Parse `inputs/operator-rulings.yaml`. Throws `OperatorRulingsError` — a
 * malformed file means an operator's ruling would otherwise be silently
 * ignored, so the decisions write fails loud rather than ship a run that
 * contradicts it.
 */
export function parseOperatorRulingsYaml(text: string): OperatorRulingsFile {
  let raw: unknown;
  try {
    raw = yaml.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new OperatorRulingsError(`${OPERATOR_RULINGS_FILENAME} is not valid YAML: ${(e as Error).message}`);
  }
  const r = OperatorRulingsFileSchema.safeParse(raw);
  if (!r.success) {
    const where = r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new OperatorRulingsError(`${OPERATOR_RULINGS_FILENAME} does not match schema v1: ${where}`);
  }
  return r.data;
}

/** The rulings that apply to one artifact. */
export function rulingsFor(file: OperatorRulingsFile | null | undefined, artifact: RulingArtifact): OperatorRuling[] {
  return (file?.rulings ?? []).filter((r) => r.applies_to.includes(artifact));
}

/** The standing assumptions overridden for one artifact. */
export function overriddenAssumptions(file: OperatorRulingsFile | null | undefined, artifact: RulingArtifact): Set<StandingAssumptionKey> {
  return new Set(rulingsFor(file, artifact).flatMap((r) => (r.overrides ? [r.overrides] : [])));
}

export function operatorRulingRef(id: string): string {
  return `${OPERATOR_RULINGS_REF_SLUG}/${id}`;
}

export function isOperatorRulingRef(ref: string | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(`${OPERATOR_RULINGS_REF_SLUG}/`);
}

/** Decision-id prefix per producer, so each skill's row for one ruling has its own id. */
const ROW_PREFIX: Record<string, string> = {
  'idea-to-pdd': 'pdd',
  'solicitation-create': 'sol',
  'pdd-to-work-order': 'wo',
};

const FOLLOW = 'Follow the operator ruling';
const STANDING = 'Follow the standing assumption';

/**
 * The decision row a producer appends for one ruling. Sent as `ai-default`;
 * the write boundary stamps `human-decided` from the file.
 */
export function rulingDecisionRow(ruling: OperatorRuling, at: { phase: string; skill: string }): DecisionRow {
  const prefix = ROW_PREFIX[at.skill] ?? at.skill;
  const question = ruling.overrides
    ? `Does this design follow the operator ruling "${ruling.id}" over the standing assumption "${ruling.overrides}"?`
    : `Does this design follow the operator ruling "${ruling.id}"?`;
  return {
    id: `${prefix}-ruling-${ruling.id}`,
    phase: at.phase,
    skill: at.skill,
    question,
    'ai-default': FOLLOW,
    options: ruling.overrides ? [FOLLOW, STANDING] : [FOLLOW],
    source: `inputs/${OPERATOR_RULINGS_FILENAME} (${ruling.id}, ${ruling.decided_by}, ${ruling.decided_at})`,
    status: 'ai-default',
    evidence_basis: 'stated',
    value_set_by: 'external',
    plain: ruling.ruling,
    plain_value: 'As the operator ruled',
    feedback_ref: operatorRulingRef(ruling.id),
    reasoning: ruling.overrides
      ? `An operator ruling for this opp overrides the standing assumption: ${STANDING_ASSUMPTIONS[ruling.overrides]}`
      : 'An operator ruling for this opp.',
  } as DecisionRow;
}

export interface ApplyOperatorRulingsResult {
  rows: DecisionRow[];
  /** Row ids stamped `human-decided` from a ruling. */
  applied: string[];
  /** `operator-rulings/<id>` refs naming no ruling in the file — left as the producer sent them. */
  unmatched: string[];
}

/**
 * Stamp `human-decided` + `decided_by` / `decided_at` on every row whose
 * `feedback_ref` names a ruling in the file. Pure. A row a reviewer already
 * overrode (`overridden`) or ruled on keeps that status — the later, more
 * specific human act wins over the opp-level ruling.
 */
export function applyOperatorRulings(rows: DecisionRow[], rulings: readonly OperatorRuling[]): ApplyOperatorRulingsResult {
  const byId = new Map(rulings.map((r) => [r.id, r]));
  const applied: string[] = [];
  const unmatched: string[] = [];
  const out = rows.map((row) => {
    if (!isOperatorRulingRef(row.feedback_ref)) return row;
    const r = byId.get(row.feedback_ref!.slice(OPERATOR_RULINGS_REF_SLUG.length + 1));
    if (!r) {
      unmatched.push(row.feedback_ref!);
      return row;
    }
    if (row.status !== 'ai-default') return row;
    applied.push(row.id);
    const next: DecisionRow = { ...row, status: 'human-decided', decided_by: r.decided_by, decided_at: r.decided_at };
    if (next.review_ask !== undefined) {
      delete next.review_ask;
      delete next.confirm_reason;
    }
    return next;
  });
  return { rows: out, applied, unmatched };
}
