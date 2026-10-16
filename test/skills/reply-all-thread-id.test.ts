/**
 * A reply-all names the THREAD, never `--reply-to-message-id` (ace#2391).
 *
 * The canopy email engine has two reply-all modes. `--thread-id` derives To/Cc
 * from the thread's LATEST non-self message — the mode its own `--help` calls
 * "preferred for --reply-all". `--reply-to-message-id` replies to THAT message.
 *
 * In Gmail a thread id IS the id of the thread's first message, and the engine
 * 404s a bare message id on a multi-message thread with "pass a THREAD id". So
 * a caller following that error passes the thread id into
 * `--reply-to-message-id` and gets message mode on the thread HEAD:
 *
 *   thread 1a07309c2de673be (ACE opened it):  to: ace@dimagi-ai.com
 *                                              cc: aking@dimagi.com, jjackson@dimagi.com
 *   thread 19f86579142e6ba5 (Neal opened it): to: nlesh@dimagi.com — the actual
 *     correspondent (Sophie, latest non-self) demoted to Cc, stewari dropped.
 *
 * Observed on poverty-graduation/20260915-1518. Both were caught only by
 * agent-turn-review's recipient check. The skill docs steered to the broken
 * pair (`skills/email-communicator/SKILL.md` step 4, `bin/ace-email` usage),
 * so this rail bans it wherever an agent reads a command from.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Lines that combine `--reply-all` with `--reply-to-message-id`. A line that
 * warns against the pair ("Never ...") is the rule itself, not a use of it.
 */
function brokenReplyAllLines(text: string): number[] {
  const hits: number[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.includes('--reply-all') || !line.includes('--reply-to-message-id')) return;
    if (/\bnever\b/i.test(line)) return;
    hits.push(i + 1);
  });
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const SCANNED = [
  ...walk(path.join(REPO_ROOT, 'skills')),
  ...walk(path.join(REPO_ROOT, 'commands')),
  ...walk(path.join(REPO_ROOT, 'agents')),
  path.join(REPO_ROOT, 'bin/ace-email'),
];

describe('reply-all uses --thread-id (ace#2391)', () => {
  it('detector flags the broken pair (negative control)', () => {
    expect(
      brokenReplyAllLines(
        '- **Prefer `--reply-all`:** `bin/ace-email --reply-all --reply-to-message-id <message_id> --subject "Re: x"`',
      ),
    ).toEqual([1]);
    expect(brokenReplyAllLines('      --body-file body.txt [--reply-to-message-id <id>] [--reply-all] [--dry-run]')).toEqual([1]);
  });

  it('detector passes the thread-id form and the warning (positive control)', () => {
    expect(brokenReplyAllLines('bin/ace-email --reply-all --thread-id <thread_id> --subject "Re: x"')).toEqual([]);
    expect(brokenReplyAllLines('- **Never `--reply-all --reply-to-message-id <thread id>`** (ace#2391).')).toEqual([]);
  });

  it('no skill, command, agent doc or the ace-email usage steers to --reply-all --reply-to-message-id', () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      for (const line of brokenReplyAllLines(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(REPO_ROOT, file)}:${line}`);
      }
    }
    expect(offenders, 'use `--reply-all --thread-id <thread_id>` — a thread id passed as --reply-to-message-id replies to the thread HEAD').toEqual([]);
  });

  it('email-communicator documents the --thread-id form', () => {
    const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills/email-communicator/SKILL.md'), 'utf8');
    expect(skill).toContain('--reply-all --thread-id <thread_id>');
  });
});
