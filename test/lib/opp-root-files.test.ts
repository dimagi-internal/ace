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
