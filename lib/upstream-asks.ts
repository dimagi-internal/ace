/**
 * Finds the upstream issues ACE's own docs cite as live constraints, so a
 * probe can check whether they are still open.
 *
 * ## Why this exists
 *
 * ACE integrates with five systems it does not own, and files issues against
 * them. `skills/upstream-regression-triage` covers the case where something
 * that WORKED starts failing — a loud failure that forces someone to look
 * upstream.
 *
 * The inverse case is silent. When an upstream repo GRANTS a request ACE
 * filed, the workaround keeps working, so nothing ever prompts a re-read of
 * the premise. `voidcraft-labs/nova-plugin#8` closed 2026-06-03; ACE went on
 * documenting a 471-line workaround as the path for ~3 months, shipping apps
 * with no menu icons and no picture-choice options the whole time, and losing
 * its media on every rebuild (ace#1764).
 *
 * A skill's own "removal criteria" section does not solve this: it is only
 * read by someone already editing that skill, which is precisely who is not
 * looking.
 *
 * Pure and total — no I/O, no network, no throwing. The probe supplies issue
 * states; this module decides what is worth reporting.
 */

/** An upstream issue reference found in an ACE doc. */
export interface UpstreamRef {
  owner: string;
  repo: string;
  number: number;
  /** `owner/repo#number`, the canonical key. */
  slug: string;
  /** Repo-relative path of the doc citing it. */
  file: string;
  /** 1-indexed line. */
  line: number;
  /** The full line, trimmed — context for the report. */
  text: string;
  /**
   * True when the surrounding text presents the issue as a CURRENT limitation
   * rather than as history. Only these are worth alerting on when closed.
   */
  claimsLiveConstraint: boolean;
}

export type IssueState = "OPEN" | "CLOSED" | "UNKNOWN";

export interface IssueStatus {
  slug: string;
  state: IssueState;
  closedAt?: string | null;
  /** `completed` | `not planned`, when the host reports it. */
  reason?: string | null;
  title?: string;
  /**
   * Thread comments, when the probe fetched them. Only populated for OPEN
   * issues ACE still cites as a live constraint — see `findCorrectedOpenAsks`
   * below for why that gate comes before the fetch, not after.
   */
  comments?: IssueComment[];
}

export interface StaleAsk {
  slug: string;
  title?: string;
  closedAt?: string | null;
  reason?: string | null;
  /** Every live-constraint citation still standing in the repo. */
  citations: UpstreamRef[];
}

/**
 * Upstream repos ACE actually files against. Anything else matching the
 * `owner/repo#n` shape is ignored — the docs are full of `ace#1234`
 * self-references and unrelated links, and alerting on those is noise.
 */
export const UPSTREAM_REPOS = [
  "voidcraft-labs/nova-plugin",
  "voidcraft-labs/commcare-nova",
  "voidcraft-labs/nova-marketplace",
  "dimagi/commcare-connect",
  "dimagi/commcare-hq",
  "dimagi/open-chat-studio",
  "jjackson/connect-labs",
  "dimagi-internal/connect-labs",
  "anthropics/claude-code",
] as const;

/**
 * Phrases that present an issue as a CURRENT constraint. Deliberately narrow:
 * a false positive costs a human a glance, but a false NEGATIVE recreates the
 * exact 3-month blind spot this module exists to close, so the list favours
 * the plain ways ACE actually writes about upstream gaps.
 */
const LIVE_CONSTRAINT_MARKERS: RegExp[] = [
  /\bblocked\s+(?:on|by)\b/i,
  /\bwait(?:ing)?\s+(?:on|for)\b/i,
  /\buntil\b[^.]*\bships?\b/i,
  /\bnot\s+(?:yet\s+)?(?:supported|available|possible|implemented)\b/i,
  /\bno\s+(?:schema|support|atom|api|way)\b/i,
  /\bhas\s+no\b/i,
  /\bdoes\s?n[o']t\s+(?:support|expose|exist|have)\b/i,
  /\bworkaround\b/i,
  /\bupstream\s+(?:bug|gap|limitation|constraint)\b/i,
  /\bopen\s+upstream\b/i,
  /\btracked\s+at\b/i,
  /\bremoval\s+criteria\b/i,
  /\bcannot\b/i,
  /\bunable\s+to\b/i,
  // Vocabulary Table A actually uses to assert a permanent platform closure.
  // Without these the highest-value rows in the repo match no live marker at all.
  /\bare\s+rejected\b/i,
  /\bis\s+rejected\b/i,
  /\bwrite-only\b/i,
  /\bnot\s+requestable\b/i,
  /\bno\s+path\b/i,
  /\bclosed\s+at\s+the\s+platform\s+surface\b/i,
  /\bclosed\s+on\s+all\s+\w+\s+surfaces\b/i,
];

/**
 * Phrases that mark a reference as HISTORY — a changelog line, a resolved
 * note, a "do not cite this as live" warning. These suppress the alert even
 * when a live-constraint marker also matches, because ACE's docs routinely
 * describe a past constraint in order to say it is over.
 */
const HISTORICAL_MARKERS: RegExp[] = [
  /\bfixed\b/i,
  /\bshipped\b/i,
  // NOT a bare /\bclosed\b/ — ACE's docs use "closed" for two opposite things.
  // `_app-component-library.md` Table A is titled "closed at the platform surface"
  // and its rows open "Closed on all three surfaces", where closed means the
  // CONSTRAINT is permanent, i.e. maximally live. A bare marker suppressed every
  // row in the one table this probe most needs to read (ace#1798). Match only
  // phrasing that says the ISSUE closed.
  /\bclosed\s+(?:as\s+)?(?:completed|not[-\s]planned)\b/i,
  /\bclosed\s+(?:on\s+)?\d{4}-\d{2}-\d{2}/i,
  /\b(?:issue|bug|ticket|upstream|request|it|which|that)\s+closed\b/i,
  /\b(?:now|since|already|was|has)\s+closed\b/i,
  /\bclosed\s+upstream\b/i,
  /\bresolved\b/i,
  /\bsuperseded\b/i,
  /\bretired\b/i,
  /\bdisproved\b/i,
  /\bno longer\b/i,
  /\bused to\b/i,
  /\bformerly\b/i,
  /\bpreviously\b/i,
  /\bdo not cite\b/i,
  /\bwas never\b/i,
];

const REF_RE = /\b([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)#(\d+)\b/g;

function isTracked(owner: string, repo: string): boolean {
  return (UPSTREAM_REPOS as readonly string[]).includes(`${owner}/${repo}`);
}

/**
 * True when the text reads as a current limitation rather than as history.
 *
 * `context` is the citing line plus a few lines after it. Live-constraint
 * markers are read from the LINE — that is where the claim is made — while
 * historical markers are read from the whole window, so an explicit
 * acknowledgement placed just below a stale sentence suppresses the alert.
 *
 * That asymmetry is deliberate. The blind spot this module closes is a doc
 * that is stale AND SILENT about it; once someone has written "closed
 * COMPLETED, retirement candidate, needs a live build to confirm" underneath,
 * the staleness is tracked work rather than a trap, and continuing to report
 * it every run trains people to ignore the probe. The acknowledgement is
 * visible in the diff, so suppressing this way cannot be done quietly.
 */
export function classifyLine(text: string, context = text): boolean {
  if (HISTORICAL_MARKERS.some((r) => r.test(context))) return false;
  return LIVE_CONSTRAINT_MARKERS.some((r) => r.test(text));
}

/** How many following lines an acknowledgement may occupy. */
export const ACK_WINDOW_LINES = 4;

/** Extract every tracked upstream reference from one document. */
export function extractRefs(file: string, content: string): UpstreamRef[] {
  const out: UpstreamRef[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    for (const m of text.matchAll(REF_RE)) {
      const [, owner, repo, num] = m;
      if (!isTracked(owner, repo)) continue;
      out.push({
        owner,
        repo,
        number: Number(num),
        slug: `${owner}/${repo}#${num}`,
        file,
        line: i + 1,
        text: text.trim(),
        claimsLiveConstraint: classifyLine(
          text,
          lines.slice(i, i + 1 + ACK_WINDOW_LINES).join("\n"),
        ),
      });
    }
  }
  return out;
}

/** Every distinct `owner/repo#n` in a reference set, sorted for stable output. */
export function uniqueSlugs(refs: UpstreamRef[]): string[] {
  return [...new Set(refs.map((r) => r.slug))].sort();
}

/**
 * The report: closed upstream issues that ACE docs still cite as live
 * constraints. An issue closed `not planned` is included — it was refused, so
 * a doc still saying "blocked on it" is just as wrong, only in the other
 * direction.
 */
export function findStaleAsks(
  refs: UpstreamRef[],
  statuses: IssueStatus[],
): StaleAsk[] {
  const byslug = new Map(statuses.map((s) => [s.slug, s]));
  const grouped = new Map<string, UpstreamRef[]>();

  for (const ref of refs) {
    if (!ref.claimsLiveConstraint) continue;
    const status = byslug.get(ref.slug);
    if (!status || status.state !== "CLOSED") continue;
    const list = grouped.get(ref.slug) ?? [];
    list.push(ref);
    grouped.set(ref.slug, list);
  }

  return [...grouped.entries()]
    .map(([slug, citations]) => {
      const s = byslug.get(slug)!;
      return {
        slug,
        title: s.title,
        closedAt: s.closedAt ?? null,
        reason: s.reason ?? null,
        citations: citations.sort((a, b) =>
          a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
        ),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/* ------------------------------------------------------------------------ *
 * Corrected-but-OPEN asks (ace#1792)
 *
 * The block above catches the CLOSED half: the request was granted, the state
 * changed, and nothing prompted a re-read. Its sibling is silent in a way that
 * is strictly worse — the request was NOT granted, the diagnosis was simply
 * wrong, and the correction landed in a COMMENT while the issue stayed open.
 * There is no machine-readable event at all.
 *
 * Canonical case: `voidcraft-labs/nova-plugin#52`. Its own author disproved the
 * mechanism in the thread's third comment on 2026-08-25 ("Correcting my comment
 * above — it is **not** stored-credential precedence"). ACE had written that
 * mechanism into four operator-facing surfaces, each terminating at a remedy
 * that is a no-op by construction, and kept prescribing it for three days. The
 * issue is still OPEN today, so `findStaleAsks` above sees nothing.
 *
 * ## Why this tier is HEURISTIC and the CLOSED tier is not
 *
 * `state === 'CLOSED'` is a fact. "This comment retracts the mechanism" is a
 * reading of prose, and a comment SPECULATING about a mechanism is not a
 * correction. Three things keep that from becoming noise:
 *
 *   1. Gated on a live-constraint citation. An issue ACE's own docs already
 *      describe as history is never considered, so the existing acknowledgement
 *      suppression (see `classifyLine`) applies IDENTICALLY here — writing the
 *      correction under the citation retires the finding, and the annotation is
 *      visible in the diff.
 *   2. Retraction-SHAPED markers, not topic words. `disprove`, `I had this
 *      wrong`, `correcting my <earlier thing>` are things a person writes only
 *      when withdrawing a claim.
 *   3. A hedged line is dropped. "I cannot tell", "both fit the data", "might
 *      be" are the vocabulary of an open question, not a retraction.
 *
 * The probe reports this tier separately and does NOT raise its exit code: a
 * heuristic must never gate CI, and a probe that nags is a probe people turn
 * off. The output prompts a human to re-read one thread. It decides nothing.
 * ------------------------------------------------------------------------ */

/** One comment on an upstream issue, as the probe fetches it. */
export interface IssueComment {
  author?: string;
  body: string;
  createdAt?: string;
  url?: string;
}

/** A single retraction-shaped line, kept verbatim so a human can adjudicate. */
export interface CorrectionSignal {
  author?: string;
  createdAt?: string;
  url?: string;
  /** The matching line, trimmed. Quoted in the report — never paraphrased. */
  excerpt: string;
}

export interface CorrectedAsk {
  slug: string;
  title?: string;
  signals: CorrectionSignal[];
  /** Every live-constraint citation still standing in the repo. */
  citations: UpstreamRef[];
}

/**
 * Lines that WITHDRAW a claim.
 *
 * Deliberately shaped, not topical. The remedy filed on ace#1792 proposed the
 * bare word list `correction | disproved | I had this wrong | superseded | not
 * the cause`; run against the real thread it was derived from, three of those
 * five behaved differently than filed:
 *
 *   - `correction` MISSES the actual retraction heading, which reads
 *     "### Correcting my comment above".
 *   - `disproved` MISSES "The client logs disprove that".
 *   - `not the cause` fires on "The OAuth cascade is a *symptom*, not the
 *     cause" — a line of ordinary diagnostic prose in a comment that happens
 *     also to be a retraction. Any debugging thread eliminating a suspect
 *     writes that sentence, so it is dropped here: it is a claim ABOUT a
 *     mechanism, not a withdrawal of one.
 */
const CORRECTION_MARKERS: RegExp[] = [
  // "Correcting my comment above", "Correction to this issue's evidence".
  /\bcorrect(?:ing|ion|ions|ed)\b[^.\n]{0,40}\b(?:my|the|this|that|above|earlier|previous|prior|issue)\b/i,
  /\bfinal correction\b/i,
  /\bdisprov(?:e|es|ed|en|ing)\b/i,
  /\bI (?:had|got) (?:this|that|it) wrong\b/i,
  /\bI was wrong\b/i,
  /\bwrong (?:mechanism|diagnosis|premise|attribution)\b/i,
  /\bretract(?:s|ed|ing|ion)?\b/i,
  /\bsupersed(?:e|es|ed|ing)\b/i,
  /\bmis(?:diagnosed|attributed|read|identified)\b/i,
  /\bthat (?:inference|reading|claim|assertion|explanation) does not hold\b/i,
  /\b(?:this|that|it) (?:was|is) never (?:the|a) (?:cause|bug|mechanism|problem)\b/i,
  /\bno longer (?:the|our|a) (?:cause|mechanism|explanation|premise)\b/i,
];

/**
 * Lines that pose an open question rather than settle one. A correction marker
 * on a hedged line is dropped.
 *
 * Kept to first-person uncertainty and modal hedging. "theory" and
 * "hypothesis" are NOT here on purpose: retrospective retractions routinely
 * open "this was filed on the theory that …" before demolishing it.
 */
const SPECULATION_MARKERS: RegExp[] = [
  /\bI cannot tell\b/i,
  /\bI can'?t tell\b/i,
  /\bnot sure\b/i,
  /\bunclear\b/i,
  /\bunsure\b/i,
  /\bmight\b/i,
  /\bmay be\b/i,
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bpossibly\b/i,
  /\bI suspect\b/i,
  /\bcould be\b/i,
  /\bboth fit\b/i,
  /\bif (?:it|this|that|the) .{0,30}\bturns out\b/i,
  /\bwould (?:mean|imply|suggest)\b/i,
  /\bwant(?:ed)? to (?:confirm|check|rule out)\b/i,
];

/**
 * Every retraction-shaped line in one comment. Empty when the comment reads as
 * ordinary progress, hedging, or a fresh report.
 *
 * Line-scoped on purpose: a hedge three paragraphs away must not suppress a
 * flat retraction, and a flat retraction must not launder a hedge on its own
 * line. The excerpt is what gets quoted, so it has to be the matching line.
 */
export function findCorrectionSignals(comment: IssueComment): CorrectionSignal[] {
  const out: CorrectionSignal[] = [];
  for (const raw of (comment.body ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (SPECULATION_MARKERS.some((r) => r.test(line))) continue;
    if (!CORRECTION_MARKERS.some((r) => r.test(line))) continue;
    out.push({
      author: comment.author,
      createdAt: comment.createdAt,
      url: comment.url,
      excerpt: line.length > 200 ? `${line.slice(0, 197)}…` : line,
    });
  }
  return out;
}

/**
 * The advisory report: OPEN upstream issues ACE still cites as a live
 * constraint, whose thread contains a retraction-shaped comment.
 *
 * An issue with no live-constraint citation is skipped even when its thread is
 * one long retraction — the docs have already absorbed it, and re-reporting
 * acknowledged work is how a probe teaches people to ignore it.
 */
export function findCorrectedOpenAsks(
  refs: UpstreamRef[],
  statuses: IssueStatus[],
): CorrectedAsk[] {
  const byslug = new Map(statuses.map((s) => [s.slug, s]));
  const grouped = new Map<string, UpstreamRef[]>();

  for (const ref of refs) {
    if (!ref.claimsLiveConstraint) continue;
    const status = byslug.get(ref.slug);
    if (!status || status.state !== "OPEN") continue;
    const list = grouped.get(ref.slug) ?? [];
    list.push(ref);
    grouped.set(ref.slug, list);
  }

  const out: CorrectedAsk[] = [];
  for (const [slug, citations] of grouped) {
    const s = byslug.get(slug)!;
    const signals = (s.comments ?? []).flatMap(findCorrectionSignals);
    if (signals.length === 0) continue;
    out.push({
      slug,
      title: s.title,
      signals,
      citations: citations.sort((a, b) =>
        a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
      ),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
