/**
 * dimagi-internal/ace#1282 + #1325 — one root cause, filed twice.
 *
 * The orchestrator's Step 5b auto-migrate moves every non-folder direct child
 * of the opp root into `inputs/`, and `lib/doctor-drive-layout.ts` flags every
 * opp-root entry outside a four-name whitelist as stray cruft. Both carried
 * their own hand-maintained exemption list, documented as "keep the two in
 * sync", and both listed only `opp.yaml` and `*_comms-log*`.
 *
 * So ACE swept its OWN opp-root files into the Phase 1 evidence pack:
 *
 *  - `open-questions.md` (#1325) — written to the opp root by ACE's own
 *    mandate. Moving it means (a) Phase 1 reads ACE's prior conclusions as
 *    curated source evidence, the `no-inferred-backstory` class through a
 *    self-referential back door, and (b) the ace#1201 durable-questions loop
 *    silently stops finding the file, so contradiction detection never fires
 *    again and the regression looks exactly like pre-#1201 behaviour.
 *  - `iterate-state.yaml` / `iterate-state-legacy-*.yaml` (#1282) —
 *    `/ace:iterate` campaign control state read from the opp ROOT. Moving it
 *    resets the campaign: golden pointer, streak and `kill` switch all lost.
 *
 * `_comms-log` was itself added one incident at a time (ace#929). Enumerating
 * ACE-owned names per incident IS the bug, so the exemption set now lives in
 * ONE registry that both consumers import, and a test asserts the orchestrator
 * doc lists every entry — the sync obligation made structural rather than
 * asserted in prose.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ACE_OWNED_OPP_ROOT,
  classifyOppRootEntry,
  isAceOwnedOppRootEntry,
} from '../../lib/opp-root-files.js';

describe('ACE-owned opp-root registry (#1282, #1325)', () => {
  it('claims every file the two issues named', () => {
    for (const name of [
      'opp.yaml',
      'open-questions.md',
      'iterate-state.yaml',
      'iterate-state-legacy-20260814.yaml',
      'inbox-triage_comms-log',
      'llo-onboarding_comms-log',
    ]) {
      expect(isAceOwnedOppRootEntry(name), name).toBe(true);
    }
  });

  it('claims the opp-root FOLDERS ACE writes, which doctor was flagging as cruft', () => {
    for (const name of ['inputs', 'runs', 'current', 'eval-calibration', 'feedback']) {
      expect(isAceOwnedOppRootEntry(name), name).toBe(true);
    }
  });

  it('does NOT claim operator-dropped source material — that is what 5b exists to migrate', () => {
    for (const name of [
      'bednet brief.docx',
      'idea.md',
      'Programme notes 2026.pdf',
      'open-questions-from-partner.md',
      'iterate.md',
    ]) {
      expect(isAceOwnedOppRootEntry(name), name).toBe(false);
    }
  });

  it('gives each entry an owner and a reason, so the next addition has to justify itself', () => {
    for (const e of ACE_OWNED_OPP_ROOT) {
      expect(e.label, 'label').toBeTruthy();
      expect(e.owner, `${e.label}.owner`).toBeTruthy();
      expect(e.why.length, `${e.label}.why`).toBeGreaterThan(20);
    }
  });

  it('classifies to the entry that explains the exemption', () => {
    expect(classifyOppRootEntry('iterate-state.yaml')?.owner).toMatch(/iterate/i);
    expect(classifyOppRootEntry('nope.docx')).toBeNull();
  });

  it('the orchestrator Step 5b doc lists every registry entry — sync is enforced, not asserted', () => {
    const doc = fs.readFileSync(
      path.join(process.cwd(), 'agents/ace-orchestrator.md'),
      'utf8',
    );
    for (const e of ACE_OWNED_OPP_ROOT) {
      expect(doc, `Step 5b must name ${e.label}`).toContain(e.label);
    }
  });
});

/**
 * dimagi-internal/ace#2112 — the FOURTH instance of the class this file's own
 * header calls the defect: `ACE/spark-facilitator/` carried a top-level doc,
 * "Spark — parked outbound draft for Anne (awaiting sign-off, 2026-09-04)",
 * that no entry matched, so Step 5b would migrate ACE's own unsent email into
 * the Phase 1 evidence pack.
 *
 * The issue proposed the right-shaped fix — gate the migrate on Drive
 * AUTHORSHIP rather than adding a fifth name matcher — and it was measured
 * against the live Drive root on 2026-09-07 and REJECTED. ACE's root is a
 * Shared Drive, so `owners[]` is empty on 68 of 68 opp-root files;
 * `lastModifyingUser` never resolves to a human across 132 files; and 54 of 64
 * operator-dropped files already inside `inputs/` carry the service account as
 * last modifier — the same value the ACE-authored draft carries. A gate on it
 * would decline to migrate the partner's own source documents, silently, in
 * the more damaging direction.
 *
 * So the enumeration stays, and these tests lock the two things that ship
 * instead: the narrow entry, and the LOUD decline that makes a wrong entry
 * visible on the next run rather than invisible forever.
 */
describe('parked outbound drafts + the rejected authorship gate (#2112)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('claims the doc that filed the issue, verbatim', () => {
    expect(
      isAceOwnedOppRootEntry(
        'Spark — parked outbound draft for Anne (awaiting sign-off, 2026-09-04)',
      ),
    ).toBe(true);
    expect(
      classifyOppRootEntry(
        'Spark — parked outbound draft for Anne (awaiting sign-off, 2026-09-04)',
      )?.ref,
    ).toContain('2112');
  });

  it('claims the shape, not just that one filename', () => {
    for (const name of [
      'parked outbound draft — Anne',
      'Parked Outbound Draft',
      'Outbound draft — reply to the LLO',
      'Reply to Enock (parked, awaiting sign-off) DRAFT',
    ]) {
      expect(isAceOwnedOppRootEntry(name), name).toBe(true);
    }
  });

  it('stays narrow — a name registry that ate real source material would be worse', () => {
    // Every one of these is operator-dropped source evidence Phase 1 needs.
    for (const name of [
      'Draft programme notes',
      'draft.md',
      'FCAP Structure (draft).pdf',
      'Spark outbound programme summary',
      'Programme notes 2026.pdf',
    ]) {
      expect(isAceOwnedOppRootEntry(name), name).toBe(false);
    }
  });

  it('Step 5b logs what it DECLINES, not only what it moves', () => {
    const doc = read('agents/ace-orchestrator.md');
    const start = doc.indexOf('**5b. Auto-migrate top-level docs');
    const end = doc.indexOf('**5c.', start);
    expect(start, 'Step 5b block').toBeGreaterThan(-1);
    const step5b = doc.slice(start, end);

    expect(step5b, 'the move line stays').toContain('auto-migrated');
    // The half that was invisible. A skipped file left no trace at all, so a
    // too-broad registry entry could withhold an operator's brief forever.
    expect(step5b, 'a declined move must be logged too').toContain('declined to migrate');
    expect(step5b, 'and must name which entry declined it').toContain('lib/opp-root-files.ts');
  });

  it('the rejected authorship gate is written down where it would be re-proposed', () => {
    // Recording a REFUTED fix is the point: #2112 is the fourth instance of
    // this class, so the next reader will reach for the same idea.
    const lib = read('lib/opp-root-files.ts');
    expect(lib, 'the measurement lives with the registry').toMatch(/shared drive/i);
    expect(lib).toContain('owners');
    expect(lib).toContain('lastModifyingUser');
    expect(lib, 'with the counts, not a summary').toMatch(/68 of 68/);
    expect(lib).toMatch(/54 of 64/);

    const doc = read('agents/ace-orchestrator.md');
    const start = doc.indexOf('**5b. Auto-migrate top-level docs');
    const step5b = doc.slice(start, doc.indexOf('**5c.', start));
    expect(step5b, 'and the executing prose warns against re-proposing it').toMatch(
      /authorship/i,
    );
  });
});
