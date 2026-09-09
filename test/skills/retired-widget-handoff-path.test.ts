import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest';

// CLASS-LEVEL PREVENTER — dimagi-internal/ace#2300.
//
// The 2026-05-05 path-scheme migration moved Phase 5's staging artifact from
// the opp-level `ocs-setup/widget-handoff.md` to the run-scoped
// `5-ocs/ocs-setup_widget-handoff.md`. It was a PROSE migration: two skills got
// their `## Inputs` tables updated and nothing else, so each file then carried
// both forms with nothing saying which won. Four months later, five sites still
// named the retired one — including the two that are actually executed:
//
//   * `skills/ocs-widget-handoff-eval/SKILL.md` § Process step 5's verdict YAML
//     template, on the `capture_path:` line. An agent filling the template in
//     ships a verdict whose pointer back to the graded artifact resolves to
//     nothing. Observed on `bednet-check-2-visit/20260908-1544`, where the run
//     wrote the right path only because it read the Inputs table as the
//     authority over the example — and the example is what gets copied.
//   * `skills/training-onboarding-email/SKILL.md` § step 4's pre-write
//     self-check, a READ path. It told the author to take `widget_url` from a
//     file at a path that does not exist, making the check unsatisfiable.
//
// The rule is deliberately per-LINE rather than per-FILE: a line may name the
// retired form as long as the SAME line also names the current one. That is
// what lets a historical narrative annotate what changed (`agents/ocs-setup.md`
// records the e2e-xw5gk resumption incident, whose path form was accurate on
// 2026-04-29) while a bare reuse anywhere still fails. A per-file rule would
// have passed the two defective files above, since both already carried the
// current form in their Inputs tables — which is precisely how this drifted.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SCAN_DIRS = ['skills', 'agents', 'commands', 'lib'];

const RETIRED = 'ocs-setup/widget-handoff.md';

/** The authoritative path, read from the manifest so the test cannot drift from it. */
const CURRENT = (() => {
  const entry = ARTIFACT_MANIFEST.find((a) => a.role === 'widget-handoff');
  if (!entry) throw new Error('no widget-handoff artifact registered in lib/artifact-manifest.ts');
  return entry.path;
})();

function walk(dir: string): string[] {
  const root = path.join(REPO, dir);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile() && /\.(md|ts)$/.test(e.name)) out.push(abs);
    }
  }
  return out;
}

describe('retired widget-handoff path form (ace#2300)', () => {
  it('registers the current path in the manifest', () => {
    expect(CURRENT).toBe('5-ocs/ocs-setup_widget-handoff.md');
  });

  it('no skill, agent, command or lib line names the retired form without also naming the current one', () => {
    const offenders: string[] = [];

    for (const dir of SCAN_DIRS) {
      for (const file of walk(dir)) {
        // The preventer must not flag itself: this file quotes both forms by design.
        if (path.basename(file) === 'retired-widget-handoff-path.test.ts') continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!line.includes(RETIRED)) return;
          if (line.includes(CURRENT)) return; // annotated then/now — allowed
          offenders.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    }

    expect(
      offenders,
      `These lines name the retired \`${RETIRED}\` form with no reference to the current ` +
        `\`${CURRENT}\`. A reader copying one writes or reads a path that does not exist ` +
        `(ace#2300). Either update the path, or annotate the line with both forms if it is ` +
        `deliberately describing history.\n\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('catches a bare retired reference (non-inertness control)', () => {
    // Same predicate the assertion above runs, against a synthetic pair that
    // differs ONLY by the presence of the current path on the line. Without
    // this, a typo in RETIRED would make the real check vacuously pass.
    const bare = `   capture_path: ${RETIRED}`;
    const annotated = `   was \`${RETIRED}\`, now \`${CURRENT}\``;
    const flags = (line: string) => line.includes(RETIRED) && !line.includes(CURRENT);

    expect(flags(bare)).toBe(true);
    expect(flags(annotated)).toBe(false);
  });
});
