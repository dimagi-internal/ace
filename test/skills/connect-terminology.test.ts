import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The platform is "Connect", never "CommCare Connect" — in anything a human reads.
 *
 * ## The failure class
 *
 * The rule already existed. `skills/pdd-to-work-order/references/writing-style.md`
 * has carried a terminology table with `Connect | CommCare Connect | Use the
 * product name` for as long as work orders have been generated, and
 * `pdd-to-work-order-eval § Terminology` grades against it. But both were
 * scoped to ONE producer, so the rule held for the contract and nowhere else.
 *
 * Meanwhile `templates/training-deck/_common/platform-setup.yaml` — the common
 * module every FLW training deck opens with — asked:
 *
 *   title: "What is CommCare Connect?"
 *   body:  "CommCare Connect matches you with paid work opportunities:"
 *
 * So the very first sentence a Frontline Worker ever read from ACE used a name
 * the organisation had retired, while the contract signed above them used the
 * current one. A rule enforced on one producer is not a terminology rule; it is
 * a local preference that happens to be written down.
 *
 * ## Why this test scopes itself to `templates/`
 *
 * "CommCare Connect" is NOT universally wrong in this repo, and a blanket ban
 * would be a worse bug than the one it fixes. The phrase legitimately names a
 * code-level concept in several places — the marker set
 * (`<learn:deliver>` / `<learn:module>` / `<learn:assessment>`), the
 * `dimagi/commcare-connect` upstream repo, the `commcare_connect` identifier —
 * and the Nova prompt cues in `pdd-to-learn-app` / `pdd-to-deliver-app` are
 * tuned to that exact wording to make Nova emit the right markers. Rewriting
 * those to satisfy a prose rule would change behaviour to fix spelling.
 *
 * `templates/` is different: everything in it is content destined for a human,
 * so the phrase is unconditionally wrong there. That makes this a check with no
 * allowlist, which is the only kind that does not rot.
 *
 * Dated records under `docs/learnings/**` and `docs/superpowers/{plans,specs}/**`
 * keep the old name deliberately — they record what was said at the time, and
 * editing them to match today's naming falsifies the record.
 *
 * Rule: `skills/_terminology.md`.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const TEMPLATES = join(REPO_ROOT, 'templates');

const TEXTUAL = /\.(md|yaml|yml|json|txt|ts|html)$/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Binary asset trees carry no prose.
      if (entry === 'assets' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (TEXTUAL.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('Connect terminology in generated content', () => {
  const files = walk(TEMPLATES);

  it('finds template files to check (guards against the walk silently matching nothing)', () => {
    // A check that scans zero files passes forever. Pin a floor so a future
    // refactor of `templates/` cannot turn this suite into a no-op.
    expect(files.length).toBeGreaterThan(5);
  });

  it('never says "CommCare Connect" anywhere under templates/', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      if (!/CommCare\s+Connect/i.test(body)) continue;
      const lines = body.split('\n');
      lines.forEach((line, i) => {
        if (/CommCare\s+Connect/i.test(line)) {
          offenders.push(`${file.replace(REPO_ROOT + '/', '')}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `The platform is "Connect", never "CommCare Connect", in content a human reads.\n` +
        `Drop the "CommCare " prefix at each site below. If you believe an occurrence names\n` +
        `the CODE concept (the marker set, the upstream repo, an identifier) rather than the\n` +
        `platform, it does not belong in templates/ — move it to the skill that owns it.\n` +
        `Rule: skills/_terminology.md\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('has not collaterally scrubbed CommCare-the-mobile-app from the deck', () => {
    // The counter-ratchet. The fix for the above is a targeted removal of one
    // phrase, NOT `s/CommCare//` — the FLW deck legitimately walks a worker
    // through installing CommCare from the Play Store, and CommCare, CommCare
    // HQ and "a CommCare app" are all live, correct product names. A blanket
    // substitution would produce slides telling an FLW to install nothing.
    const platformSetup = readFileSync(
      join(TEMPLATES, 'training-deck', '_common', 'platform-setup.yaml'),
      'utf8',
    );
    expect(platformSetup).toMatch(/Download CommCare/);
    expect(platformSetup).toMatch(/search 'CommCare'/);
  });
});
