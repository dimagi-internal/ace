/**
 * Private (demonstration) solicitations, optional step `private_solicitation`
 * (spec docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md § B, PR2).
 *
 * Two things are pinned.
 *
 * 1. `solicitation-create` publishes `is_public: false` + the demonstration
 *    banner ONLY when `optional_steps.private_solicitation` is on, and records
 *    `visibility` in the products block.
 *
 * 2. The INVERTED read rule. The plan originally asked this test to require
 *    `program_id` on every `get_solicitation` / `list_responses`. The live labs
 *    schema refutes that (2026-10-18, via tools/list): get_solicitation,
 *    list_responses, get_response, update_solicitation and award_response all
 *    describe `program_id` as "Accepted for compatibility; not needed".
 *    Unlisted calls are "readable by their owner and by anyone who responded"
 *    (connect-labs#2567 moved authorization to owning-org membership). So the
 *    claim that a private call 404s without `program_id` is false. It would
 *    send a reader debugging a not-found to the wrong cause (ownership is the
 *    real one). These skills must not make that claim, and must not pass
 *    `program_id` in those read call blocks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const FILES = [
  'skills/solicitation-create/SKILL.md',
  'skills/solicitation-monitor/SKILL.md',
  'skills/solicitation-review/SKILL.md',
  'playbook/integrations/connect-labs.md',
];

// Phrasings of the refuted rule: "program_id is required/mandatory to read a
// private call", "without program_id it filters to is_public=true".
const REFUTED = [
  /filters\s+to\s+`?is_public=true`?/i,
  /program_id`?\s+is\s+mandatory/i,
  /must\s+thread\s+`?program_id/i,
  /always\s+pass\s+`?program_id`?\s+on\s+read/i,
  /reads\s+then\s+need\s+its\s+`?program_id/i,
];

/**
 * Call blocks `mcp__connect-labs__<atom>(...)` in a file. A multi-line block
 * runs to the first line that is only `)` (its comments may contain parens);
 * a single-line call runs to the end of its line.
 */
function callBlocks(src: string, atom: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`mcp__connect-labs__${atom}\\(`, 'g');
  for (const m of src.matchAll(re)) {
    const rest = src.slice((m.index ?? 0) + m[0].length);
    if (rest.startsWith('\n')) {
      const end = rest.search(/\n\s*\)/);
      out.push(end === -1 ? rest : rest.slice(0, end));
    } else {
      out.push(rest.split('\n')[0]);
    }
  }
  return out;
}

describe('private solicitation reads need no program_id (live schema, spec § B amended)', () => {
  for (const f of FILES) {
    it(`${f} does not claim a private call needs program_id to be read`, () => {
      const src = read(f);
      for (const re of REFUTED) expect(src, `${f} matches refuted rule ${re}`).not.toMatch(re);
    });
  }

  for (const f of FILES.filter((p) => p.startsWith('skills/'))) {
    it(`${f}: get_solicitation / list_responses / get_response call blocks pass no program_id`, () => {
      const src = read(f);
      for (const atom of ['get_solicitation', 'list_responses', 'get_response']) {
        for (const block of callBlocks(src, atom)) {
          expect(block, `${f} ${atom}(...) passes program_id`).not.toMatch(/program_id/);
        }
      }
    });
  }
});

describe('solicitation-create gates visibility on optional_steps.private_solicitation', () => {
  const src = read('skills/solicitation-create/SKILL.md');

  it('the publish call does not hardcode is_public: true', () => {
    const blocks = callBlocks(src, 'create_solicitation');
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b).not.toMatch(/is_public:\s*true\s*,/);
    expect(blocks.some((b) => /is_public:[^\n]*private_solicitation/.test(b))).toBe(true);
  });

  it('carries the demonstration banner verbatim', () => {
    expect(src).toContain(
      '> **[Demonstration — not a live call.]** Created by ACE to exercise the Labs workflow; responses are synthetic.',
    );
  });

  it('records visibility in the products block', () => {
    expect(src).toMatch(/visibility:\s*<public \| private>/);
  });
});

describe('solicitation-review', () => {
  const src = read('skills/solicitation-review/SKILL.md');

  it('no award_response call block passes the retired amount arg (ace#3146)', () => {
    for (const b of callBlocks(src, 'award_response')) expect(b).not.toMatch(/^\s*amount\s*:/m);
  });

  it('writes selected_llo.synthetic_winner only for the ace_winner optional step', () => {
    expect(src).toContain('synthetic_winner: true');
    expect(src).toMatch(/ace_winner/);
  });
});
