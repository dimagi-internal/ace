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
  /\bclosed\b/i,
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
