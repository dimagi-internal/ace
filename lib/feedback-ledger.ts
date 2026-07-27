//
// Feedback ledger — "for my N comments, where did each one go?"
//
// The ledger is a DERIVED VIEW, not a store. It joins three things ACE
// already keeps (GitHub issues/PRs, a run's decisions.yaml, an opp's
// open-questions.md) against one small new fact store: the verbatim
// inbound review record.
//
// Why derived. Sophie Feintuch's 2026-07-27 review of hh-poverty-targeting
// produced 9 items that resolved into three different KINDS — generalizable
// skill defects, per-run decisions, and open questions for a human. Every
// kind already had a home. What was missing was the ability to ask one
// question across them. Building a second hand-maintained changelog next to
// `decisions.yaml` would have created exactly the drift problem ACE avoids
// elsewhere (cf. `docs/generated/playbook.md` — derived, explicitly not a
// source of truth). A computed view cannot drift from its sources, because
// it reads them.
//
// Why NOT fold everything into the decisions log. A defect is not a
// decision. ACE never weighed options and picked "ask visit_outcome first";
// it simply got it wrong. Recording that as a decision row fabricates a
// deliberation that never happened and corrupts the one store whose value
// depends on honestly recording what ACE actually considered (Jon, 2026-07-27:
// "not everything can be constituted as a decision").
//
// The completeness property. The inbound record is the DENOMINATOR: every
// item is listed whether or not anything happened to it. An item nobody
// routed renders as UNROUTED rather than silently vanishing — so the view
// doubles as an audit that no reviewer comment was dropped. A hand-written
// changelog omits silently; this one accuses.
//

import { z } from 'zod';
import yaml from 'yaml';

export const FEEDBACK_LEDGER_SCHEMA_VERSION = 1 as const;

/** One verbatim comment from an external reviewer. Append-only: facts. */
export const FeedbackItemSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
        message: 'item id must be kebab-case (e.g. `d`, `gps-accuracy`)',
      })
      .describe(
        'Stable id, ideally the reviewer\'s own anchor (a gdoc comment marker like "d").',
      ),
    verbatim: z
      .string()
      .min(1)
      .describe(
        'The reviewer\'s words, unedited. Never paraphrase — the paraphrase is ' +
          'what drifts, and the verbatim text is the whole point of the fact store.',
      ),
    anchor: z
      .string()
      .optional()
      .describe('Where in the artifact it was left (section, field, slide).'),
  })
  .strict();

export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export const FeedbackRecordSchema = z
  .object({
    schema_version: z.literal(FEEDBACK_LEDGER_SCHEMA_VERSION),
    /** Filename stem; the first half of every `feedback_ref`. */
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    reviewer: z.string().min(1),
    reviewer_email: z.string().optional(),
    received_at: z.string().min(1),
    channel: z
      .enum(['gdoc-comments', 'email', 'meeting', 'board', 'other'])
      .default('other'),
    artifact: z.string().optional(),
    artifact_url: z.string().optional(),
    /** The run the reviewer was looking at. */
    against_run: z.string().optional(),
    items: z.array(FeedbackItemSchema).min(1),
  })
  .strict();

export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

/** Where a feedback item ended up. Collected from the stores that own it. */
export type DispositionKind =
  | 'skill-fix' // a generalizable defect -> GitHub issue + PR
  | 'decision' // ACE chose; a human wants different -> decisions.yaml
  | 'open-question' // needs a human answer -> open-questions.md
  | 'declined'; // considered and not actioned, with a reason

export type DispositionStatus =
  | 'shipped'
  | 'pending'
  | 'awaiting-human'
  | 'declined';

export interface Disposition {
  /** `<record slug>/<item id>` — the provenance stamp. */
  feedbackRef: string;
  kind: DispositionKind;
  /** One line: what actually changed. */
  summary: string;
  /** Issue/PR URL, decision row id, or open-question anchor. */
  link?: string;
  status: DispositionStatus;
  /** The run in which the change first appears. */
  landedInRun?: string;
}

export interface LedgerRow {
  item: FeedbackItem;
  ref: string;
  dispositions: Disposition[];
  /** True when nothing anywhere claims this item. */
  unrouted: boolean;
}

export interface LedgerCoverage {
  total: number;
  routed: number;
  unrouted: number;
  shipped: number;
  awaitingHuman: number;
}

export interface Ledger {
  record: FeedbackRecord;
  rows: LedgerRow[];
  coverage: LedgerCoverage;
}

/** `20260727-sophie-feintuch` + `d` -> `20260727-sophie-feintuch/d`. */
export function formatFeedbackRef(slug: string, itemId: string): string {
  return `${slug}/${itemId}`;
}

export function parseFeedbackRef(
  ref: string,
): { slug: string; itemId: string } | null {
  const m = ref.trim().match(/^([a-z0-9-]+)\/([a-z0-9-]+)$/);
  return m ? { slug: m[1], itemId: m[2] } : null;
}

/**
 * The trailer collectors look for in a GitHub issue/PR body. Kept as one
 * exported constant so the skill, the issue template, and the parser cannot
 * drift apart.
 */
export const FEEDBACK_TRAILER = 'Feedback-Ref:';

/** Extract every `Feedback-Ref: <slug>/<id>` trailer from free text. */
export function extractFeedbackRefs(body: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${FEEDBACK_TRAILER}\\s*([a-z0-9-]+/[a-z0-9-]+)`, 'gi');
  for (const m of body.matchAll(re)) {
    const parsed = parseFeedbackRef(m[1]);
    if (parsed) out.push(formatFeedbackRef(parsed.slug, parsed.itemId));
  }
  return Array.from(new Set(out));
}

export function parseFeedbackRecord(text: string): FeedbackRecord {
  return FeedbackRecordSchema.parse(yaml.parse(text));
}

/**
 * Join dispositions onto the inbound record.
 *
 * Dispositions whose ref matches no item are returned as `orphans` by
 * {@link buildLedgerWithOrphans} — a stamp pointing at a nonexistent item is
 * a typo, and silently dropping it would hide a broken link.
 */
export function buildLedger(
  record: FeedbackRecord,
  dispositions: Disposition[],
): Ledger {
  return buildLedgerWithOrphans(record, dispositions).ledger;
}

export function buildLedgerWithOrphans(
  record: FeedbackRecord,
  dispositions: Disposition[],
): { ledger: Ledger; orphans: Disposition[] } {
  const byRef = new Map<string, Disposition[]>();
  for (const d of dispositions) {
    const list = byRef.get(d.feedbackRef) ?? [];
    list.push(d);
    byRef.set(d.feedbackRef, list);
  }

  const claimed = new Set<string>();
  const rows: LedgerRow[] = record.items.map((item) => {
    const ref = formatFeedbackRef(record.slug, item.id);
    const ds = byRef.get(ref) ?? [];
    if (ds.length > 0) claimed.add(ref);
    return { item, ref, dispositions: ds, unrouted: ds.length === 0 };
  });

  const orphans = dispositions.filter((d) => !claimed.has(d.feedbackRef));

  const flat = rows.flatMap((r) => r.dispositions);
  const coverage: LedgerCoverage = {
    total: rows.length,
    routed: rows.filter((r) => !r.unrouted).length,
    unrouted: rows.filter((r) => r.unrouted).length,
    // An item counts as shipped only when EVERY disposition on it shipped —
    // a half-fixed item is not a fixed item.
    shipped: rows.filter(
      (r) =>
        !r.unrouted && r.dispositions.every((d) => d.status === 'shipped'),
    ).length,
    awaitingHuman: rows.filter((r) =>
      r.dispositions.some((d) => d.status === 'awaiting-human'),
    ).length,
  };

  return { ledger: { record, rows, coverage }, orphans };
}

const STATUS_LABEL: Record<DispositionStatus, string> = {
  shipped: 'SHIPPED',
  pending: 'IN FLIGHT',
  'awaiting-human': 'NEEDS YOU',
  declined: 'DECLINED',
};

const KIND_LABEL: Record<DispositionKind, string> = {
  'skill-fix': 'skill fix',
  decision: 'decision',
  'open-question': 'open question',
  declined: 'declined',
};

/**
 * Render the reviewer-facing view. Ordered so the reviewer's own words come
 * first — they should recognise their comment before reading what we did
 * about it.
 */
export function renderLedgerMarkdown(
  ledger: Ledger,
  orphans: Disposition[] = [],
): string {
  const { record, rows, coverage } = ledger;
  const lines: string[] = [];

  lines.push(`# Feedback ledger — ${record.reviewer}, ${record.received_at}`);
  lines.push('');
  if (record.artifact) {
    lines.push(
      record.artifact_url
        ? `Reviewed: [${record.artifact}](${record.artifact_url})`
        : `Reviewed: ${record.artifact}`,
    );
  }
  if (record.against_run) lines.push(`Against run: \`${record.against_run}\``);
  lines.push('');
  lines.push(
    `**${coverage.total} comments — ${coverage.shipped} shipped, ` +
      `${coverage.awaitingHuman} need a human, ${coverage.unrouted} unrouted.**`,
  );
  lines.push('');

  for (const row of rows) {
    lines.push(`## [${row.item.id}] ${row.item.anchor ?? ''}`.trimEnd());
    lines.push('');
    lines.push(`> ${row.item.verbatim.replace(/\n/g, '\n> ')}`);
    lines.push('');
    if (row.unrouted) {
      lines.push(
        '- **UNROUTED** — nothing references this comment yet. Either it was ' +
          'missed, or its disposition is missing a `Feedback-Ref` stamp.',
      );
    } else {
      for (const d of row.dispositions) {
        const link = d.link ? ` — ${d.link}` : '';
        const run = d.landedInRun ? ` _(run ${d.landedInRun})_` : '';
        lines.push(
          `- **${STATUS_LABEL[d.status]}** · ${KIND_LABEL[d.kind]} — ${d.summary}${link}${run}`,
        );
      }
    }
    lines.push('');
  }

  if (orphans.length > 0) {
    lines.push('## Broken stamps');
    lines.push('');
    lines.push(
      'These reference a feedback item that does not exist — likely a typo ' +
        'in a `Feedback-Ref` trailer:',
    );
    lines.push('');
    for (const o of orphans) {
      lines.push(`- \`${o.feedbackRef}\` — ${o.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
