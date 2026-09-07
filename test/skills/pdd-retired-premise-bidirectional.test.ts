import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ace#1924 — Step 4a's must-not-assert check must run BOTH ways.
 *
 * The forward direction (a mechanism the PDD is about to assert, checked
 * against the LIVE rows of `_app-component-library.md § Mechanisms a PDD must
 * not assert`) has been enforced since ace#1213. The inverse never was: a
 * SOURCE-STATED constraint or fixture pin whose justifying premise is a row
 * that has since been RETIRED. A retired row is history, so it never trips the
 * forward check — the source sentence leaning on it goes unexamined, and the
 * fallback it pins silently degrades the design (the live case pinned
 * `entity_id` on the `voidcraft-labs/commcare-nova#458` closure that Table A retired
 * 2026-08-29, falling back to the `atomic-visit` grain).
 *
 * `scripts/probe-upstream-asks.ts` is the repo-side tripwire for this class but
 * walks SCAN_DIRS/SCAN_FILES only, so it cannot see Drive-resident opp inputs.
 * Until that half ships, Step 4a's prose IS the rail — this test keeps it from
 * being edited away, and pins the three obligations rather than one sentence.
 */

const REPO = join(__dirname, '..', '..');
const SKILL = readFileSync(join(REPO, 'skills', 'idea-to-pdd', 'SKILL.md'), 'utf8');
const LIBRARY = readFileSync(join(REPO, 'skills', '_app-component-library.md'), 'utf8');

/** The block Step 4a's bidirectional rule lives in, bounded by the next bullet. */
function bidirectionalBlock(): string {
  const start = SKILL.search(/ALSO check the RETIRED rows/i);
  expect(start, 'Step 4a must carry the bidirectional check').toBeGreaterThan(-1);
  const rest = SKILL.slice(start);
  const end = rest.search(/\n\s*- \*\*Capture fidelity\.\*\*/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('Step 4a checks retired premises, not only live ones', () => {
  it('says the check is bidirectional and names the RETIRED rows', () => {
    const block = bidirectionalBlock();
    expect(block).toMatch(/bidirectional/i);
    expect(block).toMatch(/RETIRED/);
    expect(block).toMatch(/_app-component-library\.md/);
  });

  it('scopes the inverse to SOURCE-stated claims, not asserted mechanisms', () => {
    // Without this the rule collapses back into the forward check it extends.
    const block = bidirectionalBlock();
    expect(block).toMatch(/source material|source-stated|source is authoritative/i);
  });

  it('pins all three obligations when the premise is retired', () => {
    // Any one alone is insufficient: recording the conflict without demoting
    // the pin still makes a later phase's correct build read as a deviation,
    // and demoting without an open question loses the re-mint.
    const block = bidirectionalBlock();
    expect(block, 'conflicting decisions row').toMatch(/`conflicting`|conflict_signals/);
    expect(block, 'demote to advisory mechanism').toMatch(/advisory mechanism/i);
    expect(block, 'open question naming the re-mint').toMatch(/open question/i);
  });

  it('states why the repo-side probe cannot cover it', () => {
    const block = bidirectionalBlock();
    expect(block).toMatch(/probe-upstream-asks/);
    expect(block).toMatch(/SCAN_DIRS|SCAN_FILES/);
  });

  it('the premise it rests on is real: the probe walks repo dirs only', () => {
    const probe = readFileSync(join(REPO, 'scripts', 'probe-upstream-asks.ts'), 'utf8');
    expect(probe).toMatch(/const SCAN_DIRS\s*=/);
    expect(probe).toMatch(/const SCAN_FILES\s*=/);
    // No Drive/opp-inputs pass exists yet — if one lands, revisit this rule.
    expect(probe).not.toMatch(/resolve_opp_path|drive_list_folder/);
  });

  it('the component library actually carries at least one RETIRED row', () => {
    // The rule is meaningless if the retired class does not exist in the file
    // it points at.
    expect(LIBRARY).toMatch(/RETIRED \d{4}-\d{2}-\d{2}/);
  });
});
