/**
 * Upstream repo slugs must be real (dimagi-internal/ace#1492).
 *
 * `skills/upstream-regression-triage` turns "an integration that used to work
 * now fails" into "read what merged upstream in the window". That procedure has
 * exactly one hard dependency: the repo slug. And a wrong slug does not fail
 * loudly — `gh pr list --repo <bad-slug>` errors, an unattended agent reads the
 * empty result as **"no upstream changes in the window"**, and the triage
 * concludes the opposite of the truth.
 *
 * That is not hypothetical. Two dead slugs were already sitting in the repo when
 * this test was written:
 *
 *   - `dimagi/commcare-nova`   — Nova lives at voidcraft-labs/commcare-nova
 *   - `dimagi/connect-labs`    — labs lives at dimagi-internal/connect-labs
 *                                (playbook/integrations/connect-api.md:8)
 *
 * The skill's own § Process step 3 table is the single source of truth for these,
 * and it is what this test enforces against the rest of the docs.
 *
 * SCOPE: offline and deterministic on purpose. This asserts slug CONSISTENCY,
 * not reachability — a network call would make CI flaky and depend on ambient
 * `gh` auth. All five slugs in the table were verified reachable by hand on
 * 2026-08-18; re-verify by hand if one starts 404ing.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = path.join(REPO_ROOT, 'skills/upstream-regression-triage/SKILL.md');

/** Slugs observed dead. A doc naming one of these sends a triage to a 404. */
const KNOWN_DEAD: Record<string, string> = {
  'dimagi/commcare-nova': 'voidcraft-labs/commcare-nova',
  'dimagi-internal/commcare-nova': 'voidcraft-labs/commcare-nova',
  'dimagi/connect-labs': 'dimagi-internal/connect-labs',
};

/**
 * Every markdown doc an agent might read a slug out of, mid-incident.
 *
 * The triage skill itself is EXCLUDED: it names the dead slugs deliberately, to
 * warn against them ("`dimagi/commcare-nova` does not exist"). Its own table is
 * covered by the two table assertions above, so nothing is unguarded — this
 * scan is for docs that would hand a slug to a triage as if it were live.
 */
const SCAN_EXCLUDES = new Set(['skills/upstream-regression-triage/SKILL.md']);

function docs(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const add = (rel: string) => {
    if (SCAN_EXCLUDES.has(rel)) return;
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) out.push({ rel, text: fs.readFileSync(abs, 'utf8') });
  };
  add('CLAUDE.md');
  const pb = path.join(REPO_ROOT, 'playbook/integrations');
  for (const f of fs.readdirSync(pb).filter((f) => f.endsWith('.md'))) {
    add(`playbook/integrations/${f}`);
  }
  for (const d of fs.readdirSync(path.join(REPO_ROOT, 'skills'))) {
    add(`skills/${d}/SKILL.md`);
  }
  return out;
}

/** The `| System | Repo | ACE surface |` table in § Process step 3. */
function slugTable(): string[] {
  const text = fs.readFileSync(SKILL, 'utf8');
  return [...text.matchAll(/\|\s*`([a-z0-9-]+\/[a-z0-9-]+)`\s*\|/g)].map((m) => m[1]);
}

describe('upstream-regression-triage repo slugs', () => {
  const table = slugTable();

  it('names every upstream ACE integrates with', () => {
    expect(table).toEqual(
      expect.arrayContaining([
        'dimagi/open-chat-studio',
        'dimagi/commcare-connect',
        'dimagi/commcare-hq',
        'voidcraft-labs/commcare-nova',
        'dimagi-internal/connect-labs',
      ]),
    );
  });

  it('the table itself contains no known-dead slug', () => {
    const dead = table.filter((s) => s in KNOWN_DEAD);
    expect(dead).toEqual([]);
  });

  it.each(Object.entries(KNOWN_DEAD))(
    'no doc points an incident triage at the dead slug %s',
    (dead, live) => {
      const offenders = docs()
        .filter(({ text }) => new RegExp(`(?<![a-z0-9-])${dead}(?![a-z0-9-])`).test(text))
        .map(({ rel }) => rel);
      expect(
        offenders,
        `These docs name \`${dead}\`, which does not resolve. Use \`${live}\`. ` +
          'A 404 here reads as "no upstream changes in the window", which is the ' +
          'opposite of the truth and is how ace#1492 stayed unexplained.',
      ).toEqual([]);
    },
  );
});
