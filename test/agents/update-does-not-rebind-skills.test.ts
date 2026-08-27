/**
 * dimagi-internal/ace#1729 — `/ace:update` does NOT rebind `Skill()` loads.
 *
 * The defect: `agents/ace-orchestrator.md` § Self-heal sweep's three-action
 * currency table, and the identical sentence in `CLAUDE.md` § "Three actions,
 * only one of which is `/ace:update`", both asserted:
 *
 *     | `/ace:update` | disk + registry; **subsequent `Skill()` loads**
 *       resolve to the new `installPath` | the orchestrator |
 *
 * That is false. Measured on `/ace:run spark-facilitator/20260820-0817`: an
 * update at a phase boundary moved installed 0.13.1003 -> 0.13.1008, and the
 * very next `Skill()` load printed
 *
 *     Base directory for this skill:
 *       .../cache/ace/ace/0.13.1003/skills/demo-data-setup
 *
 * — still 1003, and it stayed there for the rest of the session. Only
 * `/reload-plugins` rebinds skills, and that is the OPERATOR's command; the
 * orchestrator cannot run it.
 *
 * Why it needs a test rather than a corrected paragraph: the false claim is
 * what makes the boundary-currency ritual (rule 3, ace#1500) look complete.
 * If `/ace:update` rebound skills, "took the update at the boundary" would
 * mean the remaining phases run the new code. It does not, so every such run
 * note is partly untrue — and on spark-facilitator that gap came one step
 * from publishing a partner-facing solicitation page stating that work starts
 * ~2 weeks before applications close (the bound `skills/solicitation-create`
 * differed from the fixed copy sitting on disk; ace#1685).
 *
 * It was caught only because the `Skill()` loader happens to print its base
 * directory. That is luck, not a check — so pin the sentence.
 *
 * SCOPE, deliberately narrow. Two assertions, both about ONE claim:
 *
 *   1. NEGATIVE — no doc says `/ace:update` makes `Skill()` loads (or skills
 *      generally) resolve/rebind to the new `installPath`. Matching is
 *      windowed to text near `/ace:update` and requires an affirmative
 *      resolve/rebind verb, so a doc may freely discuss `installPath`,
 *      `Skill()`, or `/reload-plugins` on their own.
 *   2. POSITIVE — the two docs that carried the claim now state the true
 *      behaviour (pre-update path holds until `/reload-plugins`). Without
 *      this half, deleting the sentence silently would pass and the run
 *      would go back to saying nothing, which is the failure mode.
 *
 * Companions: `test/skills/predictive-guard-citation.test.ts`,
 * `test/agent-section-references.test.ts` — same "pin the prose that cost
 * real money" pattern.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Every markdown doc that could carry the claim. */
function docs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  for (const d of ['agents', 'skills', 'commands', 'playbook', 'lib', 'bin']) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) walk(p);
  }
  out.push(path.join(ROOT, 'CLAUDE.md'));
  return out.filter((p) => fs.existsSync(p));
}

const norm = (s: string) => s.replace(/\s+/g, ' ');

/**
 * The claim, as a shape rather than a string: within ~240 chars after a
 * mention of `/ace:update`, an affirmative statement that skills / `Skill()`
 * loads resolve or rebind to the new installPath.
 *
 * The window is TRUNCATED at the next mention of `/reload-plugins`, not
 * skipped when one is present. That distinction is the whole test: in the
 * three-action currency table the `/reload-plugins` row sits ~90 chars after
 * the `/ace:update` row, so a "skip any window containing /reload-plugins"
 * rule silently passes the exact defect this file exists to catch. (It did,
 * on the first draft — caught by running the original sentence back through
 * as a negative control. Do that again before trusting any edit here.)
 */
const UPDATE = /\/ace:update/g;
const REBINDS =
  /(skill\(\)|skills?)[^.]{0,120}?\b(resolve|resolves|rebind|rebinds|re-?bind|point|points|pick up|picks up)\b[^.]{0,120}?(new\s+`?installpath|new\s+install\s*path|updated\s+`?installpath)/i;

describe('/ace:update does not rebind Skill() loads (#1729)', () => {
  it('no doc claims an update makes skills resolve to the new installPath', () => {
    const offenders: string[] = [];

    for (const file of docs()) {
      const text = norm(fs.readFileSync(file, 'utf8').toLowerCase());
      UPDATE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = UPDATE.exec(text)) !== null) {
        let window = text.slice(m.index, m.index + 240);
        // Truncate — do NOT skip — at the next action named. Everything after
        // `/reload-plugins` is attributed to the operator's rebind, which is
        // TRUE and must stay sayable; everything before it is attributed to
        // `/ace:update`. Skipping the whole window instead lets a table whose
        // very next row is `/reload-plugins` smuggle the false claim through.
        const next = window.indexOf('/reload-plugins');
        if (next > 0) window = window.slice(0, next);
        if (REBINDS.test(window)) {
          offenders.push(`${path.relative(ROOT, file)}: "...${window.slice(0, 200)}..."`);
        }
      }
    }

    expect(
      offenders,
      [
        'A doc claims `/ace:update` rebinds skills in the current session.',
        'It does not (ace#1729): skills stay on the pre-update installPath',
        'until an OPERATOR runs /reload-plugins.',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  const CORRECTED: Array<[string, RegExp]> = [
    ['agents/ace-orchestrator.md', /pre-update `installPath`/i],
    ['CLAUDE.md', /pre-update `installPath`/i],
  ];

  it.each(CORRECTED)('%s states the true binding behaviour', (rel, re) => {
    const text = norm(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    expect(re.test(text), `${rel} must say skills keep the pre-update installPath`).toBe(true);
    expect(
      /\/reload-plugins/.test(text),
      `${rel} must name /reload-plugins as what actually rebinds`,
    ).toBe(true);
  });

  it('the orchestrator boundary acts on a mid-run update, not just reports it', () => {
    const orch = norm(
      fs.readFileSync(path.join(ROOT, 'agents/ace-orchestrator.md'), 'utf8'),
    );
    // The fourth outcome must exist and must be actionable — a halt for the
    // operator when a PENDING phase's skills differ. Silence is the failure
    // mode this whole issue is about.
    expect(orch).toMatch(/Bound skills after a mid-run update/i);
    expect(orch).toMatch(/diff -rq/);
    expect(orch).toMatch(/pending phase/i);
  });
});
