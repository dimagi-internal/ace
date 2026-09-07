/**
 * Finds the ACE issues ACE has told a COUNTERPART are live limitations, so a
 * probe can check whether they have since closed.
 *
 * ## Why this exists, and why it is not `lib/upstream-asks.ts`
 *
 * `scripts/probe-upstream-asks.ts` (ace#1764) covers the docs: an upstream repo
 * grants a request, the workaround keeps working, and nothing prompts a re-read
 * of the premise. Its corpus is repo files, which are re-read every session, and
 * the cost of a stale line lands on a run.
 *
 * This is the correspondence half, and it is strictly worse (ace#1896). **Nobody
 * ever re-reads a sent email.** A limitation asserted in one never expires by
 * itself, and the cost lands on a person who is sequencing their own work around
 * it. The canonical instance:
 *
 *   - 2026-08-21T17:56Z, thread `19f86579142e6ba5`, to an external reviewer:
 *     *"I filed that as ace#1549 and deliberately left it unfixed: telling
 *     'retired by a design change' apart from 'not raised because the run
 *     stopped early' needs a rule I would rather get right than guess at."*
 *   - ace#1549 closed COMPLETED **43 minutes later**, and the discriminator it
 *     needed shipped (`lib/feedback-ledger.ts`, `EditBinding`).
 *   - 11 days passed. She was told by hand, and only because someone happened to
 *     re-read the thread.
 *
 * ## The corpus is Gmail, NOT the comms-log
 *
 * ace#1896's filed remedy proposed scanning the routed runs' comms-logs. That
 * was executed and **refuted**: comms-logs do not store outbound bodies. The
 * 2026-08-21 message appears in
 * `ACE/hh-poverty-targeting/runs/20260819-1435/1-design/inbox-triage_comms-log.md`
 * as exactly one table row —
 * `| 2026-08-21 | 1a025772ae8df982 | Cost of a case-model change; ledger vs PDD
 * precedence |` — and `skills/email-communicator` step 7 requires only
 * `thread_id` + `message_id` + recipients + date. The citing sentence exists
 * nowhere in Drive. A comms-log scan would have found nothing for the very
 * instance the issue was filed over.
 *
 * So the sent message is the corpus, and the comms-log keeps the job it already
 * has: it is the ROUTING index that says which opp and run a thread belongs to.
 *
 * ## Why this module is pure, and where the judgement lives
 *
 * No I/O, no network, no throwing. The probe supplies decoded messages and issue
 * states; this module decides what is worth telling someone. Two rules carry the
 * whole design, and both were chosen against the real thread above rather than
 * invented:
 *
 *   1. **Recall over precision on the claim.** A false positive costs a human one
 *      glance at a thread. A false negative leaves a counterpart planning around
 *      a constraint that no longer exists and not knowing to ask. Only a CLOSED
 *      issue can ever produce a finding, so the volume stays small regardless.
 *   2. **A later ACE message that names the same issue as history RETIRES the
 *      finding.** That is the same acknowledgement suppression `classifyLine`
 *      uses, moved from "the next few lines" to "the rest of the thread" —
 *      because in correspondence the correction is not an annotation, it IS the
 *      fix. Sending it must stop the probe reporting, or the probe nags forever
 *      about work that is done. Verified against the real correction on that
 *      thread (`1a063761004267e4`, 2026-09-02: *"That was true when I wrote it
 *      and stopped being true forty-three minutes later. It was fixed and closed
 *      the same afternoon."*).
 */

/** One ACE-authored outbound message, as the probe decodes it from Gmail. */
export interface OutboundMessage {
  /** Gmail message id. */
  id: string;
  /** Gmail thread id — the routing key `inbox-triage` matches comms-logs on. */
  threadId: string;
  /** `From` header. Only ACE-authored messages are scanned; see {@link isAuthoredBy}. */
  from: string;
  /** `To` recipients, already split. */
  to?: string[];
  /** `Cc` recipients, already split. */
  cc?: string[];
  /** ISO date, when the probe could read one. */
  date?: string;
  subject?: string;
  /** Decoded `text/plain` body. */
  body: string;
}

/** A citation of an ACE issue inside an ACE-authored outbound message. */
export interface CounterpartRef {
  /** Canonical `ace#<n>`. An owner prefix (`dimagi-internal/`) is normalised away. */
  slug: string;
  number: number;
  messageId: string;
  threadId: string;
  date?: string;
  subject?: string;
  /** `to` + `cc`, deduped and lowercased — who now believes the claim. */
  recipients: string[];
  /** The citing SENTENCE, verbatim, so a human adjudicates the real words. */
  sentence: string;
  /** True when the sentence presents the issue as a CURRENT limitation. */
  claimsLiveConstraint: boolean;
}

export type IssueState = 'OPEN' | 'CLOSED' | 'UNKNOWN';

export interface IssueStatus {
  slug: string;
  state: IssueState;
  closedAt?: string | null;
  /** `completed` | `not planned`, when the host reports it. */
  reason?: string | null;
  title?: string;
}

export interface StaleCounterpartClaim {
  slug: string;
  title?: string;
  closedAt?: string | null;
  reason?: string | null;
  /** Every unacknowledged live-constraint citation, oldest first. */
  citations: CounterpartRef[];
  /**
   * Days the recipients have held a claim that was already false — measured
   * from the later of (the citation, the close) to `now`. This is the number
   * ace#1896 is about: on the canonical instance it read 11.
   */
  daysUncorrected: number | null;
  /**
   * True when ACE asserted the limitation AFTER the issue had already closed.
   * A different and worse error than the one this module was built for — not
   * "the world moved under a true statement" but "we said something already
   * false" — so it is surfaced separately rather than folded into the count.
   */
  assertedAfterClose: boolean;
}

/**
 * `ace#1549`, `dimagi-internal/ace#1549`, `jjackson/ace#1549`.
 *
 * Scoped to ACE's own tracker on purpose. An upstream ref told to a counterpart
 * has the same failure mode, but resolving it needs a repo mapping the probe
 * would have to guess at, and `lib/upstream-asks.ts` already owns that
 * vocabulary. See the residual in `scripts/probe-counterpart-asks.ts`.
 */
const REF_RE = /(?:[A-Za-z0-9][\w.-]*\/)?\bace#(\d+)\b/g;

/**
 * Phrases that present an issue as a CURRENT limitation, in the register ACE
 * actually writes to people — which is not the register its docs use. The docs
 * say "blocked on" and "removal criteria"; a letter says "I left it unfixed"
 * and "there is no state for that". Both lists are needed; neither substitutes.
 */
const LIVE_CLAIM_MARKERS: readonly RegExp[] = [
  /\bleft it (?:un)?fixed\b/i,
  /\bdeliberately (?:left|did not|have not|haven't)\b/i,
  /\b(?:have not|haven't|did not|didn't) fixed\b/i,
  /\bnot fixed\b/i,
  /\bstill (?:open|unfixed|a (?:gap|hazard|limitation|problem))\b/i,
  /\b(?:honest|known|real) limitation\b/i,
  /\bthere is no\b/i,
  /\bno (?:state|way|support|api|atom|mechanism|path) (?:for|to)\b/i,
  /\bcannot\b/i,
  /\bcan(?:'|’)t\b/i,
  /\bdoes\s?n(?:o|'|’)t\s+(?:support|expose|exist|have|work)\b/i,
  /\bis not (?:yet )?(?:supported|available|possible|implemented)\b/i,
  /\bwon(?:'|’)t\b/i,
  /\bwill not\b/i,
  /\bblocked (?:on|by)\b/i,
  /\bwait(?:ing)? (?:on|for)\b/i,
  /\bfor now\b/i,
  /\bworkaround\b/i,
  /\bopen (?:defect|issue|bug)\b/i,
  /\btracked (?:at|as)\b/i,
];

/**
 * Phrases that mark a citation as HISTORY. Read from the sentence for the
 * citation's own classification, and from the whole later message for thread
 * acknowledgement — an ACE message that says "that has since been fixed" about
 * the same issue retires the finding.
 */
const HISTORICAL_MARKERS: readonly RegExp[] = [
  /\bstopped being true\b/i,
  /\bwas true when\b/i,
  /\b(?:was|has been|is now|got) fixed\b/i,
  /\bhas since\b/i,
  /\bsince (?:closed|shipped|fixed|landed)\b/i,
  /\bno longer\b/i,
  /\bnow (?:renders|reads|works|shows|does|tells)\b/i,
  /\ba correction\b/i,
  /\bcorrecting\b/i,
  /\bi (?:got|had) (?:that|this|it) wrong\b/i,
  /\bthat is (?:now )?resolved\b/i,
  /\bclosed (?:as )?(?:completed|not[-\s]planned)\b/i,
  /\bclosed the same\b/i,
  /\bit (?:is|'s) (?:now )?(?:fixed|closed|done)\b/i,
  /\bused to\b/i,
  /\bpreviously\b/i,
  /\bsuperseded\b/i,
  // NOT a bare /\bretired\b/. ACE's decisions vocabulary uses "retired" for a
  // decision the model dropped, and the canonical stale claim is *about* that:
  // "There is no state for 'retired.' I filed that as ace#1549 and deliberately
  // left it unfixed." A bare marker suppressed the one sentence this module
  // exists to catch. Same shape as ace#1798, where a bare /\bclosed\b/
  // suppressed every row of the table the upstream probe most needed to read.
  // Match only phrasing that says the ISSUE is history.
  /\b(?:issue|ticket|defect|bug|it|that|this)\s+(?:was|is|has been|got)\s+retired\b/i,
];

/** Is this message from the given mailbox? Tolerates `Name <addr>` forms. */
export function isAuthoredBy(message: OutboundMessage, mailbox: string): boolean {
  return message.from.toLowerCase().includes(mailbox.toLowerCase());
}

/**
 * Split prose into sentences.
 *
 * The claim lives in a SENTENCE, not a line — a real outbound body wraps its
 * paragraphs into single very long lines, so the line-based window
 * `lib/upstream-asks.ts` uses would take a whole paragraph as context and let
 * one unrelated "fixed" elsewhere in it suppress the claim. Splitting on
 * terminal punctuation keeps the unit of judgement the same size as the unit of
 * assertion.
 *
 * A COLON is deliberately not a terminator. `"…deliberately left it unfixed:
 * telling X apart from Y needs a rule…"` is one claim, and splitting it severs
 * the assertion from its subject. Terminal punctuation may be followed by a
 * closing quote — `'no state for "retired."'` — so the lookbehind allows one.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[.!?]["'”’]?)\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * How many following sentences an in-message acknowledgement may occupy.
 *
 * The sibling `lib/upstream-asks.ts` uses `ACK_WINDOW_LINES = 4` over a
 * markdown file. The same asymmetry applies here — live markers are read from
 * the CLAIM, historical markers from the claim plus a short window after it —
 * but the window must be SENTENCES, not the whole message. Measured against the
 * real 5,257-character send: a whole-body window suppressed the claim outright,
 * because a long letter discusses several things and any one of them may
 * legitimately be described in the past tense.
 */
export const ACK_WINDOW_SENTENCES = 4;

/**
 * True when the text asserts a current limitation rather than recounting one.
 *
 * `context` defaults to the sentence itself; callers pass the sentence plus the
 * next {@link ACK_WINDOW_SENTENCES}. Writing the retraction under the claim
 * therefore retires it — which is exactly what a correction paragraph looks
 * like: *"…I had deliberately left it unfixed… That was true when I wrote it
 * and stopped being true forty-three minutes later."*
 */
export function classifySentence(sentence: string, context: string = sentence): boolean {
  if (HISTORICAL_MARKERS.some((r) => r.test(context))) return false;
  return LIVE_CLAIM_MARKERS.some((r) => r.test(sentence));
}

const recipientsOf = (m: OutboundMessage): string[] =>
  [...new Set([...(m.to ?? []), ...(m.cc ?? [])].map((r) => r.trim().toLowerCase()).filter(Boolean))].sort();

/** Every ACE-issue citation in one outbound message. */
export function extractCounterpartRefs(message: OutboundMessage): CounterpartRef[] {
  const out: CounterpartRef[] = [];
  const recipients = recipientsOf(message);
  const sentences = splitSentences(message.body);
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const claims = classifySentence(
      sentence,
      sentences.slice(i, i + 1 + ACK_WINDOW_SENTENCES).join(' '),
    );
    const seen = new Set<string>();
    for (const m of sentence.matchAll(REF_RE)) {
      const number = Number(m[1]);
      const slug = `ace#${number}`;
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({
        slug,
        number,
        messageId: message.id,
        threadId: message.threadId,
        date: message.date,
        subject: message.subject,
        recipients,
        sentence,
        claimsLiveConstraint: claims,
      });
    }
  }
  return out;
}

/** Every distinct `ace#n` in a reference set, sorted numerically for stable output. */
export function uniqueSlugs(refs: CounterpartRef[]): string[] {
  return [...new Set(refs.map((r) => r.slug))].sort(
    (a, b) => Number(a.slice(4)) - Number(b.slice(4)),
  );
}

const ts = (iso?: string): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Has ACE already told this recipient, on this thread, that the issue is history?
 *
 * Requires both the same slug and a historical marker in an ACE-authored message
 * that is not EARLIER than the citation. Naming the issue is what makes the
 * retirement checkable rather than guessed — a correction that only says "that
 * limitation is gone", without the number, deliberately does NOT suppress. That
 * is the conservative direction: it costs a second glance, where the other
 * direction costs the silence this module exists to break.
 *
 * This handles LATER messages only. An acknowledgement inside the citing
 * message itself is handled at extraction time by
 * {@link ACK_WINDOW_SENTENCES} — which is the case that actually occurs, since
 * a correction opens by restating what it corrects (*"…that I had filed it as
 * ace#1549, and that I had deliberately left it unfixed…"*) and only the next
 * sentence says *"That was true when I wrote it and stopped being true
 * forty-three minutes later."* Widening THIS check to the citing message's whole
 * body instead was tried and is wrong: measured against the real 5,257-character
 * send, it suppressed the claim outright, because a long letter discusses
 * several things and any one of them may legitimately be in the past tense.
 */
export function isAcknowledgedInThread(
  ref: CounterpartRef,
  messages: readonly OutboundMessage[],
  mailbox: string,
): boolean {
  const at = ts(ref.date);
  return messages.some((m) => {
    if (m.threadId !== ref.threadId) return false;
    if (m.id === ref.messageId) return false;
    if (!isAuthoredBy(m, mailbox)) return false;
    if (ts(m.date) < at) return false;
    const body = m.body;
    REF_RE.lastIndex = 0;
    const namesIt = [...body.matchAll(REF_RE)].some((x) => Number(x[1]) === ref.number);
    if (!namesIt) return false;
    return HISTORICAL_MARKERS.some((r) => r.test(body));
  });
}

const DAY_MS = 86_400_000;

/**
 * The report: issues ACE told a counterpart were live limitations, which have
 * since CLOSED, and which no later message on that thread has corrected.
 *
 * A `not planned` close is included. It means the constraint is more permanent
 * rather than less, so a person told "I filed it and will fix it" is just as
 * wrong, in the other direction, and just as entitled to hear so.
 */
export function findStaleCounterpartClaims(
  refs: readonly CounterpartRef[],
  statuses: readonly IssueStatus[],
  messages: readonly OutboundMessage[],
  mailbox: string,
  /** Injected so the report is deterministic under test. */
  now: number = Date.now(),
): StaleCounterpartClaim[] {
  const bySlug = new Map(statuses.map((s) => [s.slug, s]));
  const grouped = new Map<string, CounterpartRef[]>();

  for (const ref of refs) {
    if (!ref.claimsLiveConstraint) continue;
    const status = bySlug.get(ref.slug);
    if (!status || status.state !== 'CLOSED') continue;
    if (isAcknowledgedInThread(ref, messages, mailbox)) continue;
    const list = grouped.get(ref.slug) ?? [];
    list.push(ref);
    grouped.set(ref.slug, list);
  }

  return [...grouped.entries()]
    .map(([slug, citations]) => {
      const s = bySlug.get(slug)!;
      const sorted = citations.slice().sort((a, b) => ts(a.date) - ts(b.date));
      const first = ts(sorted[0]?.date);
      const closed = ts(s.closedAt ?? undefined);
      return {
        slug,
        title: s.title,
        closedAt: s.closedAt ?? null,
        reason: s.reason ?? null,
        citations: sorted,
        daysUncorrected:
          first && closed ? Math.round(((now - Math.max(first, closed)) / DAY_MS) * 10) / 10 : null,
        assertedAfterClose: closed > 0 && sorted.some((c) => ts(c.date) > closed),
      };
    })
    .sort((a, b) => Number(a.slug.slice(4)) - Number(b.slug.slice(4)));
}
