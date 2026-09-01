/**
 * An `-eval` skill's verdict-filename prose must not tell you to use the
 * PRODUCER skill's name (dimagi-internal/ace#1815).
 *
 * The 0.12.0 Option-α rule, stated in `agents/ace-orchestrator.md § Per-Step
 * Eval Hook`, is that an `-eval` skill keeps `-eval` in its verdict filename:
 *
 *     runs/<run-id>/<phase>/<producer-skill>[-eval]_verdict[-<mode>].yaml
 *
 * The Workbench attributes the score to the producer row via the `eval_skill:`
 * pairing in the phase agent's frontmatter, NOT by parsing the filename. The
 * migration that introduced this updated `lib/artifact-manifest.ts` and every
 * declared path, but left the explanatory prose in seven `-eval` skills saying
 * the opposite — most sharply in `ocs-widget-handoff-eval`, where the producer
 * (`ocs-agent-setup`) shares no stem with the eval skill, so the same sentence
 * gave the right path and then emphatically instructed the wrong one.
 *
 * The failure mode is silent: an agent that follows the prose writes
 * `ocs-agent-setup_verdict.yaml`, nothing errors, and `verify_phase_artifacts`
 * reports a missing artifact while a correctly-graded verdict sits beside it
 * under a name nothing reads. Same class as ace#712 / ace#619 / ace#786.
 *
 * SCOPE: prose-only and deterministic. This checks what the skill TELLS the
 * agent to name the file. The declared paths themselves are covered by
 * `artifact-manifest.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

/**
 * Phrasings that instruct the producer name for a verdict filename. Each is
 * matched only in a sentence that is also talking about the verdict file, so
 * unrelated uses of the word "producer" are left alone.
 */
const BANNED = [
  /uses\s+the\s+\*\*producer\*\*\s+skill\s+name/i,
  /uses\s+the\s+producer\s+skill\s+name/i,
  /NOT\s+this\s+skill'?s\s+name/i,
];

function evalSkillDirs(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-eval'))
    .map((d) => d.name)
    .sort();
}

describe('-eval skills state the Option-α verdict-filename rule correctly', () => {
  const dirs = evalSkillDirs();

  it('finds the -eval skills to check', () => {
    expect(dirs.length).toBeGreaterThan(10);
  });

  for (const dir of dirs) {
    const file = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;

    it(`${dir}: does not instruct the producer skill name for the verdict file`, () => {
      const text = fs.readFileSync(file, 'utf8');
      const offenders = BANNED.filter((re) => re.test(text)).map((re) => re.source);
      expect(
        offenders,
        `skills/${dir}/SKILL.md instructs the producer skill name for its verdict filename. ` +
          `Per the 0.12.0 Option-α rule an -eval skill keeps -eval in the filename ` +
          `(${dir}_verdict[-<mode>].yaml); see agents/ace-orchestrator.md § Per-Step Eval Hook.`,
      ).toEqual([]);
    });

    it(`${dir}: every verdict filename it names carries its own -eval stem`, () => {
      const text = fs.readFileSync(file, 'utf8');
      const named = [...text.matchAll(/([A-Za-z0-9_-]+)_verdict(-[a-z]+)?\.yaml/g)].map((m) => m[1]);
      // Only assert on verdict files this skill claims to WRITE — i.e. ones whose
      // stem is a REAL eval-skill directory. A skill may legitimately reference a
      // sibling producer's verdict as an input, and generic templates such as
      // `<skill>-eval_verdict.yaml` are documentation, not a filename.
      const evalDirs = new Set(dirs);
      const own = named.filter((stem) => evalDirs.has(stem));
      for (const stem of own) {
        expect(
          stem,
          `skills/${dir}/SKILL.md names ${stem}_verdict.yaml; an -eval skill writes ` +
            `only its own ${dir}_verdict[-<mode>].yaml`,
        ).toBe(dir);
      }
    });
  }
});
