import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ACE's pre-send review must never instruct its own bypass.
 *
 * ## The failure class
 *
 * `skills/agent-turn-review/SKILL.md` is a WRAPPER: it carries the fleet-wide
 * discipline (canopy's §A–§E) plus ACE's own send-path rules (§F — read-backs,
 * capability-denial probes, the synchronous-call ban, the `bin/ace-email` send
 * path). Until 2026-08-27 its opening line read:
 *
 *   "The general discipline is fleet-wide and DRY — **invoke
 *    `canopy:agent-turn-review`** and apply it in full"
 *
 * Read literally that is a direction to call the `Skill` tool on
 * `canopy:agent-turn-review`. Doing so returns the fleet body — which contains
 * ZERO ACE rules (`grep -c 'bin/ace-email\|ace@dimagi-ai.com'` over canopy
 * 0.2.441's copy returns 0) — and reads as "the review ran". Every ACE-specific
 * check is then skipped, silently, on a review that reported itself complete.
 *
 * A wrapper whose first instruction is to call the thing it wraps is not a
 * wrapper. This is cross-agent: hal's copy carries a prose warning against
 * exactly this and `canopy agent-review hal` found it bypassed anyway in the
 * same 26h window, which is why prose is not the fix and this test is.
 *
 * The upstream origin is canopy's own "Adopting it in an agent" section, which
 * tells every agent to write `invoke canopy:agent-turn-review`. ACE deliberately
 * does not follow it; this test keeps it from creeping back.
 */

const ROOT = join(__dirname, '..', '..');

/** Files that tell a reader how to run ACE's pre-send review. */
const REFERRERS = [
  'skills/agent-turn-review/SKILL.md',
  'skills/turn/SKILL.md',
  'skills/inbox-triage/SKILL.md',
  'skills/self-review/SKILL.md',
];

/**
 * Phrasing that reads as "dispatch the review as a Skill". `invoke`/`run`/`call`
 * followed by a skill NAME is the shape; a bare mention of the name (a citation,
 * a promotion-candidate note) is fine and must stay allowed.
 */
const DISPATCH = /\b(invoke|call|dispatch|run)\b[^.\n]{0,40}`?(canopy:)?agent-turn-review`?/i;

/** A negation on or beside the line makes it a prohibition, not an instruction. */
const NEGATED = /\b(not|never|don'?t|instead of|rather than|deliberately does not|no longer)\b/i;

describe('agent-turn-review must not instruct its own bypass', () => {
  it('every referrer states the review is applied INLINE, never dispatched', () => {
    const offenders: string[] = [];
    for (const rel of REFERRERS) {
      const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!DISPATCH.test(line)) return;
        const context = lines.slice(Math.max(0, i - 1), i + 2).join(' ');
        if (NEGATED.test(context)) return;
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders.join('\n') &&
        `These lines read as a Skill-tool dispatch of the pre-send review, which runs the ` +
          `fleet body alone and skips ACE's §F send-path rules. Reword to "apply INLINE" / ` +
          `"read the file":\n${offenders.join('\n')}\n`,
    ).toBe('');
  });

  it('the skill carries an explicit do-not-dispatch prohibition', () => {
    const body = readFileSync(join(ROOT, 'skills/agent-turn-review/SKILL.md'), 'utf8');
    expect(body).toMatch(/Do NOT call the `Skill` tool/);
    expect(body).toMatch(/canopy:agent-turn-review/);
  });

  it("ACE's own specifics are a numbered section of the single path, not an appendix", () => {
    const body = readFileSync(join(ROOT, 'skills/agent-turn-review/SKILL.md'), 'utf8');
    // The header block must name §F so a reader cannot finish the fleet body
    // and believe the review is over.
    const header = body.slice(0, body.indexOf('## F.'));
    expect(header).toMatch(/§F/);
    expect(body).toMatch(/^## F\. ACE specifics/m);
    // Legacy shape: a bare "## ACE-specifics" appendix hanging off the end.
    expect(body).not.toMatch(/^## ACE-specifics\s*$/m);
  });

  it('§F still carries the ACE send-path rules the bypass was dropping', () => {
    const body = readFileSync(join(ROOT, 'skills/agent-turn-review/SKILL.md'), 'utf8');
    const f = body.slice(body.indexOf('## F. ACE specifics'));
    for (const rule of [
      'bin/ace-email', // the sanctioned send path
      'EXTERNAL SYSTEM STATE', // read-back rule
      'PROBE IT', // capability-denial rule
    ]) {
      expect(f).toContain(rule);
    }
  });

  it('a turn-closing report is required to open with the decision', () => {
    const body = readFileSync(join(ROOT, 'skills/agent-turn-review/SKILL.md'), 'utf8');
    expect(body).toMatch(/turn-closing report opens with the DECISION/i);
    // The two questions Jonathan had to ask for explicitly (2026-08-26/27).
    expect(body).toMatch(/open\s+issues needing a decision/i);
    expect(body).toMatch(/session (is )?safe to continue/i);
  });
});
