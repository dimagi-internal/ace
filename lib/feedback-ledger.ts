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

import type {
  DecisionOverrideRow,
  DecisionOverridesFile,
} from './decision-overrides.js';

export const FEEDBACK_LEDGER_SCHEMA_VERSION = 1 as const;

/**
 * The body of a `revisions` feedback item: what the partner actually changed.
 *
 * ace#1335. The ledger modelled feedback as COMMENTS — items keyed on a
 * reviewer's `[a]`/`[b]` anchor with a `verbatim` quote. Co-creation grants
 * partners EDITOR access by default (`share-run-access`,
 * `drive_share_with_person`), so feedback now also arrives as document
 * revisions. A revision has no anchor and no quote, so a partner who improves
 * a PDD by editing it directly produced ZERO ledger rows — and the ledger's
 * completeness property (an item nobody actioned shows up as UNROUTED rather
 * than vanishing) silently did not hold for that channel.
 *
 * The change is the artifact. `before`/`after` are kept verbatim for the same
 * reason a comment's words are: a summary of someone's edit is a paraphrase,
 * and the paraphrase is what drifts.
 */
export const FeedbackChangeSchema = z
  .object({
    before: z.string().describe('The text as ACE published it. Empty string for an insertion.'),
    after: z.string().describe('The text as the partner left it. Empty string for a deletion.'),
    revision_id: z
      .string()
      .optional()
      .describe('Drive revision id the change was observed in — the provenance for this row.'),
    edited_by: z
      .string()
      .optional()
      .describe('Drive `lastModifyingUser` display name or email, when Drive reports one.'),
    edited_at: z.string().optional().describe('Revision `modifiedTime`, ISO.'),
  })
  .strict()
  .refine((c) => c.before !== '' || c.after !== '', {
    message: 'a change with neither before nor after text is not a change',
  });

export type FeedbackChange = z.infer<typeof FeedbackChangeSchema>;

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
      .optional()
      .describe(
        'The reviewer\'s words, unedited. Never paraphrase — the paraphrase is ' +
          'what drifts, and the verbatim text is the whole point of the fact store. ' +
          'Required for every channel EXCEPT `revisions`, where the reviewer left ' +
          'no words at all; use `change` there.',
      ),
    change: FeedbackChangeSchema.optional().describe(
      'For a `revisions` item: the EDIT is the artifact, because a partner who ' +
        'rewrites a paragraph never says anything. Carries the before/after text ' +
        'so the ledger has a body to render and a reviewer can see their edit ' +
        'was seen (ace#1335).',
    ),
    anchor: z
      .string()
      .optional()
      .describe('Where in the artifact it was left (section, field, slide).'),
  })
  .strict()
  .refine((i) => (i.verbatim === undefined) !== (i.change === undefined), {
    message:
      'a feedback item carries EXACTLY one body: `verbatim` (the reviewer said it) ' +
      'or `change` (the reviewer edited it). Both means the record is guessing at ' +
      'words nobody wrote; neither means there is nothing to render.',
  });

export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

/**
 * Ref namespace for EDITS (see the EDITS section below). An edit's ref is
 * `decision-edits/<decision-row-id>`, so a `Feedback-Ref:` trailer citing an
 * edit reads `decision-edits/photo-required` — it names the row it responds
 * to, which is MORE precise than a comment's opaque `[d]`.
 *
 * Declared up here because `FeedbackRecordSchema` REFUSES it as a record
 * slug: the two ref namespaces share one `<slug>/<id>` grammar, so a record
 * allowed to call itself `decision-edits` could shadow every edit ref.
 */
export const EDIT_RECORD_SLUG = 'decision-edits' as const;

export const FeedbackRecordSchema = z
  .object({
    schema_version: z.literal(FEEDBACK_LEDGER_SCHEMA_VERSION),
    /** Filename stem; the first half of every `feedback_ref`. */
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    reviewer: z.string().min(1),
    reviewer_email: z.string().optional(),
    received_at: z.string().min(1),
    channel: z
      .enum([
        'gdoc-comments',
        'email',
        'meeting',
        'board',
        // A reaction left on the PUBLIC per-run summary page — anonymous page,
        // SELF-REPORTED name. Materially different provenance from a comment
        // by a named colleague, and an agent reading the folder should not
        // have to infer it (ace#1362). Before this value existed, the marker
        // was smuggled into the SLUG (`<date>-public-<reviewer>`) and ace-web
        // filtered on it — which made a FILENAME CONVENTION load-bearing for a
        // CONFIDENTIALITY BOUNDARY. See `isPubliclyRepublishable`.
        'public-summary',
        // A partner EDIT, arriving as Drive document revisions rather than
        // comments. Live since co-creation grants editor access by default
        // (`share-run-access`, `drive_share_with_person`). The VALUE exists so
        // such a record can be written at all; deriving items from
        // `revisions.list`, using a diff as the item body in place of
        // `verbatim`, and adding an "accepted the partner's edit as-is"
        // disposition are NOT designed yet — ace#1335 stays open for them.
        'revisions',
        'other',
      ])
      .default('other'),
    artifact: z.string().optional(),
    artifact_url: z.string().optional(),
    /** The run the reviewer was looking at. */
    against_run: z.string().optional(),
    items: z.array(FeedbackItemSchema).min(1),
  })
  .strict()
  .refine((r) => r.slug !== EDIT_RECORD_SLUG, {
    message:
      `slug "${EDIT_RECORD_SLUG}" is reserved for derived decision edits — ` +
      'a record using it would shadow every edit ref',
    path: ['slug'],
  });

export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

/**
 * May this record be republished on a page anyone can open?
 *
 * Only feedback the reviewer left ON a public page. Everything else — a gdoc
 * comment, an email, a meeting note — was given in confidence, and a
 * privately-captured review sitting in the same `ACE/<opp>/feedback/` folder
 * must never surface publicly.
 *
 * This is a FIELD because it used to be a filename. ace-web filtered on the
 * `-public-` marker in the record slug, which meant a naming convention was
 * load-bearing for a confidentiality boundary — one rename away from
 * republishing a private review (ace#1362).
 */
export function isPubliclyRepublishable(record: FeedbackRecord): boolean {
  return record.channel === 'public-summary';
}

/**
 * A Drive revision, as `revisions.list` reports it. Only the fields the
 * derivation needs — the caller does the API call.
 */
export interface DriveRevision {
  id: string;
  modifiedTime?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

export interface DeriveRevisionItemsArgs {
  /** The revision that produced `after`. */
  revision: DriveRevision;
  /** Artifact text as ACE published it. */
  before: string;
  /** Artifact text after the partner's edit. */
  after: string;
  /**
   * Editors whose changes are ACE's own and must NOT become feedback items.
   * Matched case-insensitively against display name and email. Without this,
   * every ACE write to a shared doc would file feedback against itself.
   */
  ignoreEditors?: readonly string[];
}

/**
 * Turn one Drive revision into feedback items — one per changed block.
 *
 * ace#1335. Deliberately a LINE-BLOCK diff rather than a word diff: the ledger
 * row exists so a partner can see their edit was seen, and a block of changed
 * prose is what a person recognises as "my edit". A word-level diff would
 * shatter one rewritten paragraph into a dozen unrouted rows, each of which
 * would then read as its own ignored piece of feedback.
 *
 * Returns [] when the editor is ours or nothing changed, so a caller can run
 * it over every revision unconditionally.
 */
export function deriveRevisionItems(args: DeriveRevisionItemsArgs): FeedbackItem[] {
  const { revision, before, after } = args;
  const who = [
    revision.lastModifyingUser?.displayName,
    revision.lastModifyingUser?.emailAddress,
  ].filter((x): x is string => !!x);
  const ignore = (args.ignoreEditors ?? []).map((e) => e.toLowerCase());
  if (who.some((w) => ignore.includes(w.toLowerCase()))) return [];

  const blocks = diffBlocks(before.split('\n'), after.split('\n'));
  return blocks.map((b, i) => ({
    // Stable and traceable: same revision + same block index => same id, so
    // re-deriving does not mint new unrouted rows on every pass.
    id: `rev-${revision.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i + 1}`.replace(/-+/g, '-'),
    change: {
      before: b.before.join('\n'),
      after: b.after.join('\n'),
      revision_id: revision.id,
      ...(who[0] !== undefined ? { edited_by: who[0] } : {}),
      ...(revision.modifiedTime !== undefined ? { edited_at: revision.modifiedTime } : {}),
    },
    ...(b.anchor !== undefined ? { anchor: b.anchor } : {}),
  }));
}

interface DiffBlock {
  before: string[];
  after: string[];
  /** Nearest preceding markdown heading, so a row says WHERE it happened. */
  anchor?: string;
}

/**
 * Minimal line-block diff. Common prefix and suffix are stripped and whatever
 * remains in the middle is ONE block — sufficient because the consumer is a
 * human reading "here is what they changed", not a merge tool.
 */
function diffBlocks(a: readonly string[], b: readonly string[]): DiffBlock[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const before = a.slice(start, endA + 1);
  const after = b.slice(start, endB + 1);
  if (before.length === 0 && after.length === 0) return [];

  let anchor: string | undefined;
  for (let i = start - 1; i >= 0; i--) {
    const m = /^#{1,6}\s+(.*)$/.exec(a[i]);
    if (m) {
      anchor = m[1].trim();
      break;
    }
  }
  return [{ before, after, ...(anchor !== undefined ? { anchor } : {}) }];
}

/** Where a feedback item ended up. Collected from the stores that own it. */
export type DispositionKind =
  | 'skill-fix' // a generalizable defect -> GitHub issue + PR
  | 'decision' // ACE chose; a human wants different -> decisions.yaml
  | 'open-question' // needs a human answer -> open-questions.md
  // A partner's EDIT kept as they wrote it (ace#1335). Needed because the
  // other four kinds all describe ACE doing something in response, and the
  // correct response to a good edit is to do NOTHING and say so. Without this,
  // accepting an edit had no shape: it either went unrouted — reading to the
  // partner as "we ignored you", the intended loud failure — or got
  // mislabelled `decision`, which claims ACE chose when the partner did.
  | 'accepted-edit'
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

/**
 * The quotable body of an item, whichever channel it came from.
 *
 * A comment quotes the reviewer. A `revisions` item has no words to quote —
 * the EDIT is what the reviewer said — so it renders as the change (ace#1335).
 * Every consumer that used to reach for `.verbatim` goes through here, so a
 * revision item can never render blank.
 */
export function itemBody(item: FeedbackItem): string {
  if (item.verbatim !== undefined) return item.verbatim;
  const c = item.change;
  if (c === undefined) return '';
  if (c.before === '') return `They ADDED:\n${c.after}`;
  if (c.after === '') return `They DELETED:\n${c.before}`;
  return `They CHANGED:\n- ${c.before}\n+ ${c.after}`;
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
  'accepted-edit': 'kept your edit',
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
  if (record.channel === 'public-summary') {
    lines.push(
      '_Left on the public run summary — the reviewer\'s name is **self-reported** and unverified. ' +
        'Weigh these items accordingly._',
    );
  }
  if (record.channel === 'revisions') {
    lines.push(
      '_Arrived as document **revisions**, not comments — the change itself is the feedback ' +
        '(dimagi-internal/ace#1335)._',
    );
  }
  lines.push('');
  lines.push(
    `**${coverage.total} comments — ${coverage.shipped} shipped, ` +
      `${coverage.awaitingHuman} need a human, ${coverage.unrouted} unrouted.**`,
  );
  lines.push('');

  for (const row of rows) {
    lines.push(`## [${row.item.id}] ${row.item.anchor ?? ''}`.trimEnd());
    lines.push('');
    lines.push(`> ${itemBody(row.item).replace(/\n/g, '\n> ')}`);
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

// ───────────────────────────────────────────────────────────────────────
// EDITS — the other half of a reviewer's engagement
//
// A reviewer who edits a decision instead of commenting on it used to get an
// EMPTY "where did my comment go?" view: the ledger read `feedback/*.yaml`
// and nothing else, while their edit landed in
// `ACE/<opp>/inputs/decision-overrides.yaml` (the same file the Workbench's
// authenticated editor and the public run summary both write, bound by the
// plugin on the next run — ace#933, `lib/decision-overrides.ts`).
//
// Operator ruling (Jonathan, 2026-08-14): a reviewer should not have to know
// or care WHICH store their input landed in — comment or edit, the
// experience and the visibility should be the same.
//
// The fix is a DERIVATION, never a double-write. An edit must not also write
// a feedback record: two stores holding the same fact drift, and this
// module's whole premise is that the ledger is a derived view whose only
// write-side obligation is the stamp. So the ledger now reads
// `decision-overrides.yaml` as a SECOND SOURCE and joins it into the same
// per-person view. One write path per act; one unified read.
//
// An edit carries strictly MORE than a comment for routing purposes — it
// names the decision id, the old value, the new value, who, and when — so
// its ref is at least as precise as a comment's.
// ───────────────────────────────────────────────────────────────────────


export function formatEditRef(decisionId: string): string {
  return formatFeedbackRef(EDIT_RECORD_SLUG, decisionId);
}

export function isEditRef(ref: string): boolean {
  return parseFeedbackRef(ref)?.slug === EDIT_RECORD_SLUG;
}

// ── Identity ───────────────────────────────────────────────────────────
//
// Two spellings of the same human: a feedback record has `reviewer` (+
// optional `reviewer_email`); an override row has `decided_by` (email),
// `decided_by_name`, and `decided_by_verified`.
//
// The join rule, and the one thing it must never do:
//
//   A SELF-REPORTED NAME IS NEVER TREATED AS A VERIFIED IDENTITY.
//
// Anyone can type "Sophie Feintuch" into the public run summary's name box.
// So verification is baked into the identity KEY itself — `verified:<email>`
// vs `self-reported:<name>` — which makes it structurally impossible for an
// unverified act to be filed under a verified person's bucket, rather than
// leaving it to a caller to remember. Names are only ever joined to names,
// within the unverified tier, where the display always says so.

export interface ReviewerIdentity {
  /** `verified:<email>` | `verified:name:<slug>` | `self-reported:<slug>` */
  key: string;
  name: string;
  email?: string;
  /** True only for an AUTHENTICATED identity. Never inferred from a name. */
  verified: boolean;
}

function slugifyName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'unknown';
}

function makeIdentity(
  name: string,
  email: string | undefined,
  verified: boolean,
): ReviewerIdentity {
  const cleanEmail = email?.trim().toLowerCase() || undefined;
  const display = name.trim() || cleanEmail || 'Unknown';
  // An unverified actor's email is as self-asserted as their name, so it is
  // NOT a join key — only a verified email is.
  const key = verified
    ? cleanEmail
      ? `verified:${cleanEmail}`
      : `verified:name:${slugifyName(display)}`
    : `self-reported:${slugifyName(display)}`;
  return verified
    ? { key, name: display, email: cleanEmail, verified: true }
    : { key, name: display, verified: false };
}

/**
 * Identity behind a feedback record.
 *
 * `public-summary` is the one channel whose name is self-reported (an
 * anonymous page with a name box — see the channel enum). Every other
 * channel is a review ACE captured itself from a known counterpart, so the
 * attribution is as good as ACE's own record-keeping.
 */
export function identityOfRecord(record: FeedbackRecord): ReviewerIdentity {
  const verified = record.channel !== 'public-summary';
  return makeIdentity(record.reviewer, record.reviewer_email, verified);
}

/** Identity behind one saved decision edit. */
export function identityOfEditRow(row: DecisionOverrideRow): ReviewerIdentity {
  const verified = row.decided_by_verified === true;
  return makeIdentity(
    row.decided_by_name || row.decided_by || '',
    row.decided_by,
    verified,
  );
}

// ── Entries ────────────────────────────────────────────────────────────

/**
 * Did the edit reach a run yet?
 *
 * `applied` — a run raised that decision id and recorded this value.
 * `pending` — parked in `inputs/decision-overrides.yaml`, binds by
 *   construction when a run next raises the id. NOT a routing failure:
 *   nothing was dropped, so it must never render as UNROUTED.
 */
export type EditBinding = 'applied' | 'pending';

export interface EditEntry {
  kind: 'edit';
  /** `decision-edits/<decision-id>` — stampable, like a comment ref. */
  ref: string;
  decisionId: string;
  question?: string;
  phase?: string;
  /** The value ACE proposed (`ai_default`). */
  from?: string;
  /** The value the reviewer asserted. */
  to: string;
  /** The reviewer's OWN words about the change, if they gave any. */
  reasoning?: string;
  at?: string;
  identity: ReviewerIdentity;
  binding: EditBinding;
  /** They put ACE's own default back. Still an act; still shown. */
  revert: boolean;
  /** How many earlier values this row buried (its `history` depth). */
  supersedes: number;
  /** Downstream work that cites this edit. Separate from the edit landing. */
  dispositions: Disposition[];
}

export interface CommentEntry {
  kind: 'comment';
  ref: string;
  item: FeedbackItem;
  at?: string;
  identity: ReviewerIdentity;
  dispositions: Disposition[];
  unrouted: boolean;
}

export type EngagementEntry = CommentEntry | EditEntry;

export interface EngagementCoverage {
  comments: number;
  commentsShipped: number;
  commentsUnrouted: number;
  awaitingHuman: number;
  edits: number;
  editsApplied: number;
}

export interface Engagement {
  identity: ReviewerIdentity;
  /** Comments and edits interleaved, oldest first. One list, one person. */
  entries: EngagementEntry[];
  coverage: EngagementCoverage;
}

/** Audience a rendered engagement is destined for. */
export type LedgerAudience = 'internal' | 'public';

/**
 * May a derived EDIT appear on a page anyone can open?
 *
 * Yes — and the reason is worth stating rather than assuming. Override rows
 * carry no public/private marker at all (`lib/decision-overrides.ts`), so
 * this cannot be read off the row. It is a POLICY, already shipped on the
 * other side: ace-web's unauthenticated per-run summary serves
 * `decision_edits` for every row in the file, with the reviewer's NAME,
 * their reasoning, and the full history — withholding only the email
 * (`apps/opps/decision_overrides.py: project_override(include_email=False)`).
 * Attribution IS the safety model there ("safety here is visibility and
 * reversibility, not permission"), so hiding it would defeat it.
 *
 * A function, not an inlined `true`, because this is the exact spot a future
 * private-edit surface would have to change, and because it makes the
 * asymmetry with {@link isPubliclyRepublishable} testable rather than tacit.
 */
export function isEditPubliclyRepublishable(_entry: EditEntry): boolean {
  return true;
}

/**
 * Derive one edit entry per saved override row.
 *
 * `boundValues` maps decision id -> the override value a run's
 * `decisions.yaml` actually recorded. Absent, EVERY edit is `pending`: we do
 * not claim an edit landed without evidence that it did.
 */
export function deriveEditEntries(
  source: DecisionOverridesFile | readonly DecisionOverrideRow[],
  opts: {
    boundValues?: ReadonlyMap<string, string>;
    dispositions?: readonly Disposition[];
  } = {},
): EditEntry[] {
  const rows: readonly DecisionOverrideRow[] = Array.isArray(source)
    ? (source as readonly DecisionOverrideRow[])
    : (source as DecisionOverridesFile).overrides;

  const byRef = new Map<string, Disposition[]>();
  for (const d of opts.dispositions ?? []) {
    const list = byRef.get(d.feedbackRef) ?? [];
    list.push(d);
    byRef.set(d.feedbackRef, list);
  }

  return rows.map((row) => {
    const ref = formatEditRef(row.id);
    const isRevert =
      row.ai_default !== undefined &&
      row.override === row.ai_default &&
      !row.override_reasoning;
    const entry: EditEntry = {
      kind: 'edit',
      ref,
      decisionId: row.id,
      to: row.override,
      identity: identityOfEditRow(row),
      binding:
        opts.boundValues?.get(row.id) === row.override ? 'applied' : 'pending',
      revert: isRevert,
      supersedes: row.history?.length ?? 0,
      dispositions: byRef.get(ref) ?? [],
    };
    if (row.question) entry.question = row.question;
    if (row.phase) entry.phase = row.phase;
    if (row.ai_default !== undefined) entry.from = row.ai_default;
    if (row.override_reasoning) entry.reasoning = row.override_reasoning;
    if (row.decided_at) entry.at = row.decided_at;
    return entry;
  });
}

function timeOf(entry: EngagementEntry): number {
  const t = entry.at ? Date.parse(entry.at) : NaN;
  // Undated entries sort last, in input order — never silently first.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Group every act by the person who performed it, and order each person's
 * acts into ONE list.
 *
 * `audience: 'public'` applies the confidentiality boundary AT THE JOIN,
 * which is the point: each source already filters itself, but a view whose
 * job is to MERGE them can reintroduce the leak the sources each avoided. A
 * privately-captured review (`channel: gdoc-comments`) merged with a public
 * edit is still private, and the merged document is publishable only if
 * every entry in it is.
 */
export function buildEngagements(input: {
  records?: readonly FeedbackRecord[];
  edits?: readonly EditEntry[];
  dispositions?: readonly Disposition[];
  /** Default `internal` — the ledger gdoc is an opp artifact, not a page. */
  audience?: LedgerAudience;
}): { engagements: Engagement[]; orphans: Disposition[] } {
  const audience = input.audience ?? 'internal';
  const records = (input.records ?? []).filter(
    (r) => audience === 'internal' || isPubliclyRepublishable(r),
  );
  const edits = (input.edits ?? []).filter(
    (e) => audience === 'internal' || isEditPubliclyRepublishable(e),
  );
  const dispositions = input.dispositions ?? [];

  const byRef = new Map<string, Disposition[]>();
  for (const d of dispositions) {
    const list = byRef.get(d.feedbackRef) ?? [];
    list.push(d);
    byRef.set(d.feedbackRef, list);
  }

  const claimed = new Set<string>();
  const buckets = new Map<string, Engagement>();
  const bucketOf = (identity: ReviewerIdentity): Engagement => {
    let b = buckets.get(identity.key);
    if (!b) {
      b = {
        identity,
        entries: [],
        coverage: {
          comments: 0,
          commentsShipped: 0,
          commentsUnrouted: 0,
          awaitingHuman: 0,
          edits: 0,
          editsApplied: 0,
        },
      };
      buckets.set(identity.key, b);
    }
    return b;
  };

  for (const record of records) {
    const identity = identityOfRecord(record);
    const bucket = bucketOf(identity);
    for (const item of record.items) {
      const ref = formatFeedbackRef(record.slug, item.id);
      const ds = byRef.get(ref) ?? [];
      if (ds.length > 0) claimed.add(ref);
      const entry: CommentEntry = {
        kind: 'comment',
        ref,
        item,
        identity,
        dispositions: ds,
        unrouted: ds.length === 0,
      };
      if (record.received_at) entry.at = record.received_at;
      bucket.entries.push(entry);
    }
  }

  for (const edit of edits) {
    if (edit.dispositions.length > 0) claimed.add(edit.ref);
    // An edit's ref may also be stamped by a disposition the caller passed
    // here rather than into deriveEditEntries — merge, never double-count.
    const extra = (byRef.get(edit.ref) ?? []).filter(
      (d) => !edit.dispositions.includes(d),
    );
    if (extra.length > 0) claimed.add(edit.ref);
    const merged: EditEntry =
      extra.length > 0
        ? { ...edit, dispositions: [...edit.dispositions, ...extra] }
        : edit;
    bucketOf(edit.identity).entries.push(merged);
  }

  for (const bucket of buckets.values()) {
    bucket.entries = bucket.entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => timeOf(a.e) - timeOf(b.e) || a.i - b.i)
      .map(({ e }) => e);
    const c = bucket.coverage;
    for (const entry of bucket.entries) {
      if (entry.kind === 'comment') {
        c.comments += 1;
        if (entry.unrouted) c.commentsUnrouted += 1;
        else if (entry.dispositions.every((d) => d.status === 'shipped')) {
          c.commentsShipped += 1;
        }
      } else {
        c.edits += 1;
        if (entry.binding === 'applied') c.editsApplied += 1;
      }
      if (entry.dispositions.some((d) => d.status === 'awaiting-human')) {
        c.awaitingHuman += 1;
      }
    }
  }

  const orphans = dispositions.filter((d) => !claimed.has(d.feedbackRef));
  return { engagements: Array.from(buckets.values()), orphans };
}

// ── Rendering ──────────────────────────────────────────────────────────
//
// A comment and an edit are DIFFERENT ACTS and the view says so — a comment
// RAISES something (and can therefore be dropped, hence UNROUTED); an edit
// ASSERTS a value (and cannot be dropped, because it already changed the
// next run's input). But they render in ONE list, in one order, under one
// person, because to the reviewer they were one conversation.

function renderComment(entry: CommentEntry, lines: string[]): void {
  lines.push(`## [${entry.item.id}] ${entry.item.anchor ?? ''}`.trimEnd());
  lines.push('');
  lines.push(`> ${itemBody(entry.item).replace(/\n/g, '\n> ')}`);
  lines.push('');
  if (entry.unrouted) {
    lines.push(
      '- **UNROUTED** — nothing references this comment yet. Either it was ' +
        'missed, or its disposition is missing a `Feedback-Ref` stamp.',
    );
  } else {
    for (const d of entry.dispositions) renderDisposition(d, lines);
  }
  lines.push('');
}

function renderDisposition(d: Disposition, lines: string[]): void {
  const link = d.link ? ` — ${d.link}` : '';
  const run = d.landedInRun ? ` _(run ${d.landedInRun})_` : '';
  lines.push(
    `- **${STATUS_LABEL[d.status]}** · ${KIND_LABEL[d.kind]} — ${d.summary}${link}${run}`,
  );
}

function renderEdit(entry: EditEntry, lines: string[]): void {
  lines.push(`## [edit] ${entry.question ?? entry.decisionId}`);
  lines.push('');
  if (entry.revert) {
    lines.push(`**You put it back to** \`${entry.to}\` _(ACE's own default)_`);
  } else if (entry.from !== undefined) {
    lines.push(`**You changed it** \`${entry.from}\` → \`${entry.to}\``);
  } else {
    lines.push(`**You set it to** \`${entry.to}\``);
  }
  lines.push('');
  if (entry.reasoning) {
    lines.push(`> ${entry.reasoning.replace(/\n/g, '\n> ')}`);
    lines.push('');
  }
  // An edit is SELF-ROUTING for its own value: it changed the input the next
  // run reads, so it can never be UNROUTED. What it can be is not-yet-bound.
  if (entry.binding === 'applied') {
    lines.push(
      `- **APPLIED** · edit — \`${entry.decisionId}\` is your answer, not ACE's.`,
    );
  } else {
    lines.push(
      `- **PENDING NEXT RUN** · edit — saved to \`inputs/decision-overrides.yaml\`; ` +
        `binds automatically the next time a run raises \`${entry.decisionId}\`.`,
    );
  }
  if (entry.supersedes > 0) {
    lines.push(
      `- _Replaced ${entry.supersedes} earlier value${entry.supersedes === 1 ? '' : 's'} — ` +
        'every one is still recoverable.',
    );
  }
  // Downstream consequences are a SEPARATE question from whether the value
  // landed, and they still need a stamp — see the skill.
  for (const d of entry.dispositions) renderDisposition(d, lines);
  lines.push('');
}

/**
 * Render one person's whole engagement — comments and edits, one list.
 */
export function renderEngagementMarkdown(
  engagement: Engagement,
  orphans: readonly Disposition[] = [],
): string {
  const { identity, entries, coverage } = engagement;
  const lines: string[] = [];

  lines.push(`# Where your input went — ${identity.name}`);
  lines.push('');
  if (!identity.verified) {
    lines.push(
      '_Identity **self-reported** — these acts were performed on a public page ' +
        'where the name was typed in, not authenticated. Weigh them accordingly._',
    );
    lines.push('');
  }
  const parts: string[] = [];
  if (coverage.comments > 0) {
    parts.push(
      `${coverage.comments} comment${coverage.comments === 1 ? '' : 's'} — ` +
        `${coverage.commentsShipped} shipped, ${coverage.commentsUnrouted} unrouted`,
    );
  }
  if (coverage.edits > 0) {
    parts.push(
      `${coverage.edits} edit${coverage.edits === 1 ? '' : 's'} — ` +
        `${coverage.editsApplied} applied`,
    );
  }
  parts.push(`${coverage.awaitingHuman} need a human`);
  lines.push(`**${parts.join(' · ')}.**`);
  lines.push('');

  for (const entry of entries) {
    if (entry.kind === 'comment') renderComment(entry, lines);
    else renderEdit(entry, lines);
  }

  if (orphans.length > 0) {
    lines.push('## Broken stamps');
    lines.push('');
    lines.push(
      'These reference a feedback item or edit that does not exist — likely a ' +
        'typo in a `Feedback-Ref` trailer:',
    );
    lines.push('');
    for (const o of orphans) {
      lines.push(`- \`${o.feedbackRef}\` — ${o.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
