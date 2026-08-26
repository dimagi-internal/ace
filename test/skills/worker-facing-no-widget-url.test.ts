/**
 * A WORKER-FACING training skill must not instruct its author to print the OCS
 * widget URL (dimagi-internal/ace#1669, follow-up to #1303).
 *
 * ace#1303 introduced `lib/support-channel-guard.ts` +
 * `skills/_training-template.md § Support channel`: a worker-facing artifact's
 * support line names a HUMAN (LLO coordinator / Partner Trainer) plus the
 * in-app GRM menu — never the `openchatstudio.com` host, the chatbot
 * `public_id`, or the `embed_key`. It fixed the enforcement and the prose
 * contract, but left the § Format blocks of the same three skills still saying
 * to print `<widget_url>` — which IS an `openchatstudio.com` URL carrying a
 * 36-char `public_id`. Each file then told the author to do X in its Format
 * block and forbade X in its Contract block, so compliance depended entirely on
 * the author reading to the bottom and noticing the conflict. Observed live on
 * `hh-poverty-targeting/20260824-1404`, where both worker-facing guides had to
 * disobey their own Format block to pass the guard the same file mandates.
 *
 * The invariant, stated once so a FUTURE fourth worker-facing skill inherits
 * it: the file set is DERIVED by scanning for the guard's own name, never
 * hardcoded. A skill that adopts `checkWorkerFacingSupportChannel` is declaring
 * itself worker-facing, and thereby forfeits every widget-URL instruction.
 *
 * SCOPE: this bans the widget URL and its Phase 5 source artifact by name. It
 * deliberately does NOT ban the bare word "widget" — the § Support channel
 * section legitimately says "Connect has no per-opp widget field" while
 * explaining why the credentials are unusable, and flagging that would make
 * this the always-fires-blocker class (ace#1026). Credentials remain CORRECT in
 * the LLO-facing skills (`training-llo-guide`, `training-onboarding-email`),
 * whose reader is the person doing the embedding — those carry no guard
 * reference and are therefore untouched by this test, by construction.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

/** The guard whose presence in a SKILL.md declares that skill worker-facing. */
const GUARD = 'checkWorkerFacingSupportChannel';

/**
 * Tokens that only ever appear as an instruction to surface the OCS widget URL
 * (or to read the Phase 5 handoff artifact that carries it).
 */
const BANNED: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /widget_url/,
    why: '`widget_url` is an openchatstudio.com URL carrying a 36-char public_id — exactly what the § Support channel contract in this same file forbids',
  },
  {
    pattern: /ocs-setup_widget-handoff/,
    why: 'the Phase 5 widget-handoff artifact exists to carry embed credentials; a worker-facing artifact has no legitimate use for it',
  },
];

function workerFacingSkills(): Array<{ name: string; file: string; body: string }> {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, file: path.join(SKILLS_DIR, e.name, 'SKILL.md') }))
    .filter((s) => fs.existsSync(s.file))
    .map((s) => ({ ...s, body: fs.readFileSync(s.file, 'utf8') }))
    .filter((s) => s.body.includes(GUARD));
}

describe('worker-facing training skills carry no widget-URL instruction', () => {
  const skills = workerFacingSkills();

  it('finds the worker-facing skill set by scanning for the guard (non-vacuous)', () => {
    // If this ever hits zero the suite below silently passes forever. The three
    // known members are training-flw-guide / -quick-reference / -faq; the
    // assertion is on the COUNT being real, not on the names, so a fourth
    // worker-facing skill is covered the moment it adopts the guard.
    expect(skills.length).toBeGreaterThanOrEqual(3);
  });

  it.each(skills.map((s) => [s.name, s] as const))(
    '%s: no widget-URL instruction anywhere in the file',
    (_name, skill) => {
      const offences: string[] = [];
      skill.body.split('\n').forEach((line, i) => {
        for (const { pattern, why } of BANNED) {
          if (pattern.test(line)) {
            offences.push(`  line ${i + 1}: ${line.trim()}\n    → ${why}`);
          }
        }
      });

      expect(
        offences.length,
        [
          `${skill.name}/SKILL.md references ${GUARD} — it is WORKER-FACING —`,
          'but still instructs the author to surface the OCS widget URL:',
          ...offences,
          'Fix: name a HUMAN channel (LLO coordinator / Partner Trainer) plus the',
          "app's own in-app GRM menu, and drop the Phase 5 widget-handoff row from",
          '§ Inputs. Embed credentials belong ONLY in the LLO-facing skills',
          '(training-llo-guide, training-onboarding-email), whose recipient is the',
          'person doing the embedding (dimagi-internal/ace#1303, #1669).',
        ].join('\n'),
      ).toBe(0);
    },
  );
});
