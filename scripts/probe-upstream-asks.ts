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
 * Report-only. It never edits a doc — deciding what to retire needs a human
 * reading the issue, and a closed-`not planned` issue often means the
 * constraint is MORE permanent, not less.
 *
 * Usage:
 *   npx tsx scripts/probe-upstream-asks.ts [--json] [--all]
 *
 *   --json  machine-readable output
 *   --all   list every tracked reference, not only the stale ones
 *
 * Requires an authenticated `gh`. Exit codes: 0 nothing stale, 1 usage/tool
 * error, 2 stale citations found (so CI or a turn can gate on it).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRefs,
  findStaleAsks,
  uniqueSlugs,
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

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write('usage: probe-upstream-asks.ts [--json] [--all]\n');
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

if (argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ stale, statuses, scanned: refs.length }, null, 2)}\n`);
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

if (stale.length === 0) {
  process.stdout.write('\nNo stale upstream asks — every closed issue is cited as history.\n');
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
process.exit(2);
