import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every ACE call that makes ace-web START A RUN says who the run is for.
 *
 * ## The failure class
 *
 * `ACE_WEB_PAT_TOKEN` is ACE's own ace-web token (`/ace:setup` writes it as
 * ace@dimagi-ai.com). A run started with it is attributed to ACE and nobody
 * else. On 2026-10-01 Jonathan asked an interactive session for a fresh Spark
 * run. It POSTed `seeded-run` with that token, and every record of the run
 * (`spark-facilitator/20261001-2208` run_state `initiated_by`, canopy turn
 * `2727e227…`) named ace@dimagi-ai.com. Nothing said a human had asked.
 *
 * The docs that teach those calls still described the token as a "per-human
 * PAT", which had stopped being true. Following them faithfully produced an
 * unattributed run.
 *
 * ## The rule
 *
 * A doc that POSTs ace-web's `fork` or `seeded-run` action must link the
 * shared contract (`skills/_ace-web-attribution.md`) and name `requested_by`.
 * New call sites are caught by the scan, not by a list someone has to keep.
 *
 * Observed: ace#2572, run spark-facilitator/20261001-2208.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['skills', 'agents', 'commands'];
const CONTRACT = '_ace-web-attribution.md';

// A run-starting ace-web action. The fork route's `/fork/status` poll is a read.
const RUN_STARTING = /actions\/seeded-run|\/opps\/[^\s`"']*\/fork(?!\/status)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const docs = SCAN_DIRS.flatMap((d) => walk(join(REPO_ROOT, d))).filter(
  (f) => !f.endsWith(CONTRACT),
);
const callers = docs.filter((f) => RUN_STARTING.test(readFileSync(f, 'utf8')));

describe('ace-web run attribution', () => {
  it('finds the known run-starting call sites (scan is not vacuous)', () => {
    const rel = callers.map((f) => relative(REPO_ROOT, f));
    expect(rel).toContain('skills/fork-run/SKILL.md');
    expect(rel).toContain('agents/iterate-loop.md');
  });

  it.each(callers.map((f) => [relative(REPO_ROOT, f), f]))(
    '%s links the attribution contract and sends requested_by',
    (_rel, file) => {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(CONTRACT);
      expect(text).toContain('requested_by');
    },
  );

  it('no doc still calls ACE_WEB_PAT_TOKEN a per-human token', () => {
    const offenders = docs
      .filter((f) => !f.endsWith(join('commands', 'ace-web-pat-mint.md')))
      .filter((f) => {
        const t = readFileSync(f, 'utf8');
        return /per-human[^.\n]{0,40}(PAT|token|Personal Access Token)/i.test(t) &&
          t.includes('ACE_WEB_PAT_TOKEN');
      })
      .map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the fork-run POST recipe refuses to send without requested_by', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills/fork-run/SKILL.md'), 'utf8');
    expect(text).toMatch(/\$\{requested_by:\?/);
  });
});
