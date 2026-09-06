#!/usr/bin/env npx tsx
/**
 * Report upstream issues ACE's docs still cite as LIVE CONSTRAINTS but which
 * have since been CLOSED.
 *
 * ## Why
 *
 * ACE integrates with five systems it does not own and files issues against
 * them. When one of those repos GRANTS a request, nothing here notices: the
 * workaround keeps working, so no failure ever prompts a re-read of the
 * premise. `voidcraft-labs/nova-plugin#8` closed 2026-06-03 and ACE went on
 * documenting a 471-line workaround as the path for ~3 months — shipping apps
 * with no menu icons and no picture-choice options, and losing their media on
 * every rebuild (ace#1764).
 *
 * `skills/upstream-regression-triage` covers the loud inverse ("what worked
 * now fails"). This probe covers the silent one.
 *
 * ## Two tiers, and why the second one cannot raise the exit code
 *
 * The CLOSED check above is EXACT — a lifecycle state either changed or it did
 * not. Its sibling case has no machine-readable event at all: the request was
 * refused or unanswered, the diagnosis was simply WRONG, and the correction
 * landed in a COMMENT while the issue stayed open (ace#1792;
 * `voidcraft-labs/nova-plugin#52` is the canonical instance — mechanism
 * retracted by its own author in comment 3 of 3, issue still open today, four
 * ACE surfaces shipping the disproved remedy for three days).
 *
 * Reading a comment is a reading of prose, so that tier is HEURISTIC and is
 * reported separately, below the definite findings, WITHOUT raising the exit
 * code. Gating CI on a regex over someone's paragraph would make this probe a
 * thing people disable, which costs more than the blind spot it closes.
 *
 * Report-only in both tiers. It never edits a doc — deciding what to retire
 * needs a human reading the issue, and a closed-`not planned` issue often
 * means the constraint is MORE permanent, not less.
 *
 * Usage:
 *   npx tsx scripts/probe-upstream-asks.ts [--json] [--all] [--no-comments]
 *
 *   --json         machine-readable output
 *   --all          list every tracked reference, not only the stale ones
 *   --no-comments  skip the heuristic corrected-but-open tier entirely
 *
 * Requires an authenticated `gh`. Exit codes: 0 nothing stale (advisory
 * findings included), 1 usage/tool error, 2 CLOSED-but-cited-as-live citations
 * found (so CI or a turn can gate on the exact tier only).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRefs,
  findCorrectedOpenAsks,
  findStaleAsks,
  uniqueSlugs,
  type IssueComment,
  type IssueStatus,
  type UpstreamRef,
} from '../lib/upstream-asks.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Docs that describe how ACE works. CHANGELOG is history by definition. */
const SCAN_DIRS = ['skills', 'agents', 'playbook', 'commands', 'docs/learnings'];
const SCAN_FILES = ['CLAUDE.md', 'README.md'];

function die(msg: string, code = 1): never {
  process.stderr.write(`probe-upstream-asks: ${msg}\n`);
  process.exit(code);
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (e.endsWith('.md')) acc.push(full);
  }
  return acc;
}

function collectRefs(): UpstreamRef[] {
  const files = [
    ...SCAN_DIRS.flatMap((d) => walk(join(REPO, d))),
    ...SCAN_FILES.map((f) => join(REPO, f)),
  ];
  const refs: UpstreamRef[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    refs.push(...extractRefs(relative(REPO, f), content));
  }
  return refs;
}

/** One `gh issue view` per slug. Unreachable issues resolve to UNKNOWN. */
function fetchStatus(slug: string): IssueStatus {
  const [repo, num] = slug.split('#');
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'view', num, '-R', repo, '--json', 'state,closedAt,stateReason,title'],
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
    // A 404 (private repo, wrong slug, moved issue) must NOT read as "open".
    // UNKNOWN is excluded from the report, and named under --all.
    return { slug, state: 'UNKNOWN' };
  }
}

/**
 * Comments for ONE issue, as a second call.
 *
 * Deliberately not folded into `fetchStatus`'s field list. Comment bodies are
 * the largest thing on an issue and the vast majority of tracked slugs never
 * need them: only an OPEN issue that ACE STILL cites as a live constraint can
 * produce a finding, which on a healthy repo is the empty set. Fetching them
 * up front would pay for every slug to serve none of them.
 *
 * A failure here is not an error — the heuristic tier simply reports nothing
 * for that slug, exactly as it did before this tier existed.
 */
function fetchComments(slug: string): IssueComment[] {
  const [repo, num] = slug.split('#');
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'view', num, '-R', repo, '--json', 'comments'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const d = JSON.parse(out) as {
      comments?: { author?: { login?: string }; body?: string; createdAt?: string; url?: string }[];
    };
    return (d.comments ?? []).map((c) => ({
      author: c.author?.login,
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url,
    }));
  } catch {
    return [];
  }
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write('usage: probe-upstream-asks.ts [--json] [--all] [--no-comments]\n');
  process.exit(0);
}

try {
  execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
} catch {
  die('`gh` is not authenticated — run `gh auth login`.');
}

const refs = collectRefs();
const slugs = uniqueSlugs(refs);
if (slugs.length === 0) {
  process.stdout.write('No upstream issue references found.\n');
  process.exit(0);
}

process.stderr.write(`Resolving ${slugs.length} upstream issue(s)…\n`);
const statuses = slugs.map(fetchStatus);
const stale = findStaleAsks(refs, statuses);

// The heuristic tier. Only OPEN issues ACE still cites as a LIVE constraint can
// produce a finding, so the gate runs before the fetch: on a repo whose docs
// have already absorbed every correction this costs zero extra API calls.
const corrected = (() => {
  if (argv.includes('--no-comments')) return [];
  const candidates = new Set(
    refs.filter((r) => r.claimsLiveConstraint).map((r) => r.slug),
  );
  const withComments = statuses.map((s) =>
    s.state === 'OPEN' && candidates.has(s.slug) ? { ...s, comments: fetchComments(s.slug) } : s,
  );
  return findCorrectedOpenAsks(refs, withComments);
})();

if (argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify({ stale, corrected, statuses, scanned: refs.length }, null, 2)}\n`,
  );
  process.exit(stale.length > 0 ? 2 : 0);
}

if (argv.includes('--all')) {
  process.stdout.write('\nEvery tracked upstream reference:\n');
  for (const s of statuses) {
    const cites = refs.filter((r) => r.slug === s.slug);
    const live = cites.filter((c) => c.claimsLiveConstraint).length;
    process.stdout.write(
      `  ${s.state.padEnd(7)} ${s.slug}  (${cites.length} citation(s), ${live} as live constraint)\n`,
    );
  }
}

/** The heuristic tier. Printed after the exact one; never changes the exit code. */
function reportCorrected(): void {
  if (corrected.length === 0) return;
  process.stdout.write(
    `\n${corrected.length} OPEN upstream issue(s) whose thread may have CORRECTED the cited\n` +
      'mechanism (HEURISTIC — a human decides, and the exit code is unaffected):\n',
  );
  for (const c of corrected) {
    process.stdout.write(`\n  ${c.slug} — still OPEN\n`);
    if (c.title) process.stdout.write(`    ${c.title}\n`);
    for (const sig of c.signals) {
      const who = sig.author ? `@${sig.author}` : 'a commenter';
      const when = sig.createdAt ? sig.createdAt.slice(0, 10) : 'unknown date';
      process.stdout.write(`    retraction-shaped line — ${who}, ${when}\n`);
      process.stdout.write(`      "${sig.excerpt}"\n`);
      if (sig.url) process.stdout.write(`      ${sig.url}\n`);
    }
    process.stdout.write('    still cited as a live constraint at:\n');
    for (const cite of c.citations) {
      process.stdout.write(`      ${cite.file}:${cite.line}\n        ${cite.text.slice(0, 150)}\n`);
    }
  }
  process.stdout.write(
    '\nRead the thread, not this summary — the match is a regex over prose. If the\n' +
      'correction is real, fix the doc; if it is not, or you have already absorbed it,\n' +
      'say so in the citation (or within the following few lines) and this stops\n' +
      'reporting — the same acknowledgement suppression the CLOSED tier uses, and it\n' +
      'shows up in the diff so it cannot be done quietly.\n',
  );
}

if (stale.length === 0) {
  process.stdout.write('\nNo stale upstream asks — every closed issue is cited as history.\n');
  reportCorrected();
  process.exit(0);
}

process.stdout.write(
  `\n${stale.length} upstream issue(s) CLOSED but still cited as a live constraint:\n`,
);
for (const s of stale) {
  const when = s.closedAt ? s.closedAt.slice(0, 10) : 'unknown date';
  process.stdout.write(`\n  ${s.slug} — closed ${when}${s.reason ? ` (${s.reason})` : ''}\n`);
  if (s.title) process.stdout.write(`    ${s.title}\n`);
  for (const c of s.citations) {
    process.stdout.write(`    ${c.file}:${c.line}\n      ${c.text.slice(0, 150)}\n`);
  }
}
process.stdout.write(
  '\nRe-read each issue before acting: a `completed` close may mean the workaround\n' +
    'can be retired; a `not planned` close means the constraint is permanent and the\n' +
    'doc should say so. This probe never edits anything.\n',
);
reportCorrected();
process.exit(2);
