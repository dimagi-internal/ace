#!/usr/bin/env npx tsx
/**
 * Report ACE issues that ACE has told a COUNTERPART are live limitations, and
 * which have since CLOSED without anyone going back to say so.
 *
 * ## Why
 *
 * `scripts/probe-upstream-asks.ts` covers ACE's DOCS. Its corpus is re-read
 * every session and the cost of a stale line lands on a run. This is the
 * correspondence half (ace#1896), and it is strictly worse: **nobody ever
 * re-reads a sent email**, so a limitation asserted in one never expires by
 * itself, and the cost lands on a person sequencing their own work around it.
 *
 * Canonical instance — thread `19f86579142e6ba5`, 2026-08-21T17:56Z, to an
 * external reviewer: *"I filed that as ace#1549 and deliberately left it
 * unfixed."* ace#1549 closed COMPLETED 43 minutes later. Eleven days passed
 * before she was told, and only because a human happened to re-read the thread.
 *
 * ## Corpus: Gmail, not the comms-log
 *
 * ace#1896 proposed scanning the routed runs' comms-logs. Executed and refuted —
 * comms-logs record `thread_id` + `message_id` + recipients + date and a
 * one-line gist, never the body (`skills/email-communicator` step 7). The
 * citing sentence above appears in the comms-log as a single table cell reading
 * "Cost of a case-model change; ledger vs PDD precedence". A comms-log scan
 * finds nothing for the instance the issue was filed over.
 *
 * The comms-log keeps its own job: it is the routing index that maps a thread
 * back to an opp and run, which is what a turn needs once this probe names one.
 *
 * ## Report-only, and it never sends anything
 *
 * The correction is a letter to a person; deciding whether and how to send it is
 * `skills/inbox-triage` + the approval gate, never a probe. This prints threads.
 *
 * Usage:
 *   npx tsx scripts/probe-counterpart-asks.ts [--json] [--all] [--max N] [--query Q]
 *
 *   --json     machine-readable output
 *   --all      list every citation found, not only the stale ones
 *   --max N    Gmail threads to scan (default 100)
 *   --query Q  override the Gmail search (default: ACE-authored mail)
 *
 * Requires an authenticated `gh` and a live `gog` session for the ACE mailbox.
 * Exit codes: 0 nothing stale · 1 usage/tool error · 2 stale claims found.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCounterpartRefs,
  findStaleCounterpartClaims,
  isAuthoredBy,
  uniqueSlugs,
  type CounterpartRef,
  type IssueStatus,
  type OutboundMessage,
} from '../lib/counterpart-asks.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function die(msg: string, code = 1): never {
  process.stderr.write(`probe-counterpart-asks: ${msg}\n`);
  process.exit(code);
}

/**
 * Identity from `config/agent.json` — the SINGLE source (CLAUDE.md). Never from
 * `$ACE_GMAIL_ACCOUNT`, which was retired and expands to EMPTY in a shell, and
 * never from a guessed client: the gog client is the SHARED fleet client, and
 * what is per-agent is the mailbox (jjackson/ace#1147, #1338).
 */
function identity(): { mailbox: string; client: string } {
  try {
    const cfg = JSON.parse(readFileSync(join(REPO, 'config/agent.json'), 'utf8')) as {
      email?: string;
      gog_client?: string;
    };
    if (!cfg.email) die('config/agent.json has no `email`.');
    return { mailbox: cfg.email, client: cfg.gog_client || 'canopy' };
  } catch (e) {
    return die(`cannot read config/agent.json: ${(e as Error).message}`);
  }
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(
    'usage: probe-counterpart-asks.ts [--json] [--all] [--max N] [--query Q]\n',
  );
  process.exit(0);
}
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const { mailbox, client } = identity();
const MAX = Number(flagValue('--max') ?? 100);
const QUERY = flagValue('--query') ?? `from:${mailbox}`;

function gog(args: string[]): unknown {
  const out = execFileSync('gog', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/** Gmail's nested MIME tree, flattened. */
interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

function* walkParts(p: GmailPart): Generator<GmailPart> {
  yield p;
  for (const c of p.parts ?? []) yield* walkParts(c);
}

function header(p: GmailPart | undefined, name: string): string {
  return (p?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function plainBody(payload: GmailPart): string {
  let out = '';
  for (const part of walkParts(payload)) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      out += Buffer.from(part.body.data, 'base64url').toString('utf8');
    }
  }
  return out;
}

const addrs = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim())
    .filter(Boolean);

function threadMessages(threadId: string): OutboundMessage[] {
  let data: { thread?: { messages?: { id: string; payload: GmailPart; internalDate?: string }[] } };
  try {
    data = gog([
      'gmail',
      'thread',
      'get',
      threadId,
      '-a',
      mailbox,
      '--client',
      client,
      '--full',
      '-j',
    ]) as typeof data;
  } catch {
    return [];
  }
  return (data.thread?.messages ?? []).map((m) => ({
    id: m.id,
    threadId,
    from: header(m.payload, 'From'),
    to: addrs(header(m.payload, 'To')),
    cc: addrs(header(m.payload, 'Cc')),
    date: m.internalDate
      ? new Date(Number(m.internalDate)).toISOString()
      : new Date(header(m.payload, 'Date')).toISOString(),
    subject: header(m.payload, 'Subject'),
    body: plainBody(m.payload),
  }));
}

/** One `gh issue view` per slug. Unreachable issues resolve to UNKNOWN, never OPEN. */
function fetchStatus(slug: string): IssueStatus {
  const num = slug.slice(4);
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'view', num, '-R', 'dimagi-internal/ace', '--json', 'state,closedAt,stateReason,title'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const d = JSON.parse(out) as {
      state?: string;
      closedAt?: string | null;
      stateReason?: string | null;
      title?: string;
    };
    const state = d.state === 'CLOSED' ? 'CLOSED' : d.state === 'OPEN' ? 'OPEN' : 'UNKNOWN';
    return { slug, state, closedAt: d.closedAt, reason: d.stateReason, title: d.title };
  } catch {
    return { slug, state: 'UNKNOWN' };
  }
}

try {
  execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
} catch {
  die('`gh` is not authenticated — run `gh auth login`.');
}

process.stderr.write(`Searching ${mailbox} for "${QUERY}" (max ${MAX})…\n`);
let hits: { id?: string; threadId?: string }[];
try {
  const res = gog([
    'gmail',
    'search',
    QUERY,
    '-a',
    mailbox,
    '--client',
    client,
    '--max',
    String(MAX),
    '-j',
  ]);
  // gog returns `{ threads: [{ id, subject, … }] }` — THREADS, keyed by `id`.
  // Measured 2026-09-06; an earlier draft of this script guessed `messages` and
  // silently read 0 threads while the mailbox had plenty, which is the exact
  // shape of failure CLAUDE.md's "close the loop to the source of truth" rule
  // is about. The other two shapes are tolerated rather than assumed.
  const bag = res as { threads?: unknown[]; messages?: unknown[] };
  hits = (Array.isArray(res) ? res : (bag.threads ?? bag.messages ?? [])) as typeof hits;
} catch (e) {
  die(
    `gog search failed — is the mailbox authenticated? ` +
      `\`gog login ${mailbox} --client ${client} --services gmail\`\n${(e as Error).message}`,
  );
}

const threadIds = [...new Set(hits.map((h) => h.threadId ?? h.id).filter(Boolean) as string[])];
process.stderr.write(`Reading ${threadIds.length} thread(s)…\n`);

const messages: OutboundMessage[] = [];
for (const t of threadIds) messages.push(...threadMessages(t));

const refs: CounterpartRef[] = messages
  .filter((m) => isAuthoredBy(m, mailbox))
  .flatMap(extractCounterpartRefs);

if (refs.length === 0) {
  process.stdout.write('No ACE-issue citations found in outbound mail.\n');
  process.exit(0);
}

const slugs = uniqueSlugs(refs);
process.stderr.write(`Resolving ${slugs.length} issue(s)…\n`);
const statuses = slugs.map(fetchStatus);
const stale = findStaleCounterpartClaims(refs, statuses, messages, mailbox);

if (argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify({ stale, statuses, scanned: { threads: threadIds.length, refs: refs.length } }, null, 2)}\n`,
  );
  process.exit(stale.length > 0 ? 2 : 0);
}

if (argv.includes('--all')) {
  process.stdout.write('\nEvery ACE-issue citation in outbound mail:\n');
  for (const s of statuses) {
    const cites = refs.filter((r) => r.slug === s.slug);
    const live = cites.filter((c) => c.claimsLiveConstraint).length;
    process.stdout.write(
      `  ${s.state.padEnd(7)} ${s.slug}  (${cites.length} citation(s), ${live} as a live limitation)\n`,
    );
  }
}

if (stale.length === 0) {
  process.stdout.write(
    '\nNo stale counterpart claims — every closed issue ACE cited has been corrected on its thread.\n',
  );
  process.exit(0);
}

process.stdout.write(
  `\n${stale.length} issue(s) ACE told a counterpart were LIVE limitations and which have since CLOSED:\n`,
);
for (const s of stale) {
  const when = s.closedAt ? s.closedAt.slice(0, 10) : 'unknown date';
  process.stdout.write(`\n  ${s.slug} — closed ${when}${s.reason ? ` (${s.reason})` : ''}\n`);
  if (s.title) process.stdout.write(`    ${s.title}\n`);
  if (s.daysUncorrected !== null) {
    process.stdout.write(`    ${s.daysUncorrected} day(s) uncorrected\n`);
  }
  if (s.assertedAfterClose) {
    process.stdout.write(`    ⚠ asserted AFTER the issue had already closed\n`);
  }
  for (const c of s.citations) {
    process.stdout.write(
      `    thread ${c.threadId} · message ${c.messageId} · ${c.date?.slice(0, 10) ?? '?'}\n`,
    );
    process.stdout.write(`      to: ${c.recipients.join(', ') || '(none read)'}\n`);
    process.stdout.write(`      "${c.sentence.slice(0, 300)}"\n`);
  }
}
process.stdout.write(
  '\nRead the thread before writing anything — the match is a regex over prose, and a\n' +
    '`not planned` close means the constraint got MORE permanent, not less. Route the\n' +
    "thread to its opp/run through the comms-log, then correct it through\n" +
    '`skills/inbox-triage` under the normal approval gate. Naming the issue number in\n' +
    'the correction is what retires this finding — a correction that omits it keeps\n' +
    'reporting, deliberately.\n',
);
process.exit(2);
