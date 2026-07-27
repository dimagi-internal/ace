/**
 * fork-run → phase-registry drift detector.
 *
 * `skills/fork-run/SKILL.md` names the values an operator may pass as
 * `fork_at_phase`. ace-web resolves that value with `_resolve_phase_ordinal`
 * (`apps/opps/opp_forker.py:504`), which looks it up in the agent registry —
 * the `phase:` frontmatter key of `agents/*.md`. Anything else raises
 * `unknown-phase` and the fork fails.
 *
 * The doc drifted badly enough to be 100% non-functional (ace#985): it
 * documented SKILL names as fork points, which are the wrong vocabulary
 * entirely. A follow-up fix (ace#978) corrected one row of that skill-name
 * table without noticing the table itself was wrong — the docs got more
 * confident while staying broken. Prose review missed it twice; this test
 * would not have.
 *
 * Approach: extract every `fork_at_phase` value the SKILL's table offers,
 * and assert each is a real `phase:` in `agents/*.md`.
 *
 * Deliberately one-directional: a phase MAY exist without appearing in the
 * doc (partnership-video has no ordinal and isn't part of the linear
 * lifecycle). The failure we care about is the doc naming something that
 * does not resolve.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');
const AGENTS_DIR = join(REPO_ROOT, 'agents');
const SKILL_PATH = join(REPO_ROOT, 'skills/fork-run/SKILL.md');

/** Every `phase:` declared in agent frontmatter — the registry ace-web reads. */
function registeredPhases(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(AGENTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const text = readFileSync(join(AGENTS_DIR, f), 'utf8');
    const m = text.match(/^phase:\s*(\S+)\s*$/m);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Fork points the SKILL offers. They live in a markdown table whose rows are
 * `| <ordinal> | \`<phase>\` |` — scoped to that table so prose mentions of
 * a phase name (e.g. the § History section explaining the old bug) don't
 * register as offered values.
 */
function documentedForkPoints(): { phase: string; line: number }[] {
  const lines = readFileSync(SKILL_PATH, 'utf8').split('\n');
  const out: { phase: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\|\s*(\d+)\s*\|\s*`([a-z][a-z0-9-]*)`\s*\|/);
    if (m) out.push({ phase: m[2], line: i + 1 });
  }
  return out;
}

describe('fork-run SKILL.md ↔ agent phase registry', () => {
  it('documents at least one fork point (guards against a silently-empty parse)', () => {
    // Without this, a table reformat would make every assertion below vacuous
    // and the suite would go green on a doc it no longer checks.
    expect(documentedForkPoints().length).toBeGreaterThanOrEqual(5);
  });

  it('every documented fork_at_phase resolves in the agent registry', () => {
    const registry = registeredPhases();
    expect(registry.size).toBeGreaterThan(0);

    const bad = documentedForkPoints().filter((p) => !registry.has(p.phase));
    expect(
      bad,
      bad.length
        ? `skills/fork-run/SKILL.md offers fork_at_phase values that ace-web ` +
            `cannot resolve (it would raise unknown-phase):\n` +
            bad.map((b) => `  line ${b.line}: "${b.phase}"`).join('\n') +
            `\n\nValid values are the \`phase:\` keys in agents/*.md:\n  ` +
            [...registry].sort().join('\n  ')
        : '',
    ).toEqual([]);
  });

  it('does not offer SKILL names as fork points (the ace#985 / #978 regression)', () => {
    // The original doc listed app-test-cases, app-screenshot-capture,
    // connect-program-setup, ocs-agent-setup, solicitation-create. Those are
    // skills inside phases; ace-web trims by whole phase folder and rejects
    // them. Named explicitly so a revert reads as a deliberate regression.
    const skillNames = new Set(
      readdirSync(join(REPO_ROOT, 'skills'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    );
    const registry = registeredPhases();

    const offending = documentedForkPoints().filter(
      (p) => skillNames.has(p.phase) && !registry.has(p.phase),
    );
    expect(
      offending,
      offending.length
        ? `fork points must be PHASE names, not skill names. Found:\n` +
            offending.map((o) => `  line ${o.line}: "${o.phase}"`).join('\n')
        : '',
    ).toEqual([]);
  });
});
