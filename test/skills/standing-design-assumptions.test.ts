import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Standing operator directive (Jonathan, 2026-09-26): ACE ASSUMES every FLW has a
// Connect-capable smartphone with data, and designs the Connect app as the system
// of record. Neither is ever an open question, a go/no-go, or a solicitation ask.
// Observed on spark-facilitator/20260925-1536: the PDD made smartphones a go/no-go
// and 'instead of or in addition to' an open question, and both reached the partner email draft.
// This pins the rule into the two skills that used to raise both, so a later
// edit cannot quietly drop it.
const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('standing design assumptions', () => {
  it('idea-to-pdd declares both assumptions as not-open', () => {
    const s = read('skills/idea-to-pdd/SKILL.md');
    expect(s).toContain('## Standing design assumptions');
    expect(s).toMatch(/smartphone that runs Connect, with a data connection/);
    expect(s).toMatch(/SYSTEM OF RECORD/);
  });

  it('solicitation-create never asks the LLO to confirm devices or dual filing', () => {
    const s = read('skills/solicitation-create/SKILL.md');
    expect(s).toMatch(/Devices, data and system of record are ASSUMED, never asked/);
  });
});
