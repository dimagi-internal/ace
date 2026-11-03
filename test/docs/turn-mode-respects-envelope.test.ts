import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A turn's posture is canopy-web's per-turn decision (`turn_mode.mode` in the caller envelope),
 * not a constant. A hard-coded "every outbound reply is presented for the human's yes" made ACE
 * park a harmless "please share the doc" reply in an `auto` turn nobody was present for, and the
 * verified member got silence. The turn entry points must say the mode decides, default `manual`
 * without an envelope, and keep the mode-independent rails.
 *
 * ace#2389 (same incident class: a verified member of the connect workspace left unanswered).
 */

const ROOT = join(__dirname, '..', '..');
const flat = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
const TURN_DOCS = ['commands/turn.md', 'skills/turn/SKILL.md'];

describe('turn docs do not hard-code a review posture', () => {
  for (const f of TURN_DOCS) {
    it(`${f} has no unconditional "presented for the human's yes"`, () => {
      const t = flat(f);
      expect(t).not.toMatch(/every outbound reply is presented for the human'?s yes/i);
      expect(t).not.toMatch(/turns run in review posture/i);
      expect(t).not.toMatch(/approval-gated outbound/i);
    });
    it(`${f} names turn_mode and the manual default`, () => {
      const t = flat(f);
      expect(t).toContain('turn_mode');
      expect(t).toMatch(/`auto`/);
      expect(t).toMatch(/`manual`/);
    });
  }

  it('skills/turn § Turn mode keeps the mode-independent rails', () => {
    const t = flat('skills/turn/SKILL.md');
    expect(t).toMatch(/No envelope, or `who_is_asking` fails: `manual`/);
    expect(t).toMatch(/Both modes, not mode-dependent/);
    expect(t).toContain('bin/ace-email');
    expect(t).toMatch(/tier = what the sender may STEER; mode = whether a human must approve/);
    expect(t).toMatch(/shared-state changes[^.]*need an \*\*act\*\*-tier sender/);
    expect(t).toMatch(/unknown senders stay read-only/);
    expect(t).toMatch(/profile: full[^.]*unlisted[^.]*trust the envelope/);
  });

  it('inbox-triage keeps the Sophie flow and the unknown-sender rule', () => {
    const t = flat('skills/inbox-triage/SKILL.md');
    expect(t).toMatch(/Sophie-style flow/);
    expect(t).toMatch(/In `auto` still REPLY/);
    expect(t).toMatch(/park only the shared-state implementation/);
    expect(t).toMatch(/Read-only: summarize to the human/);
  });
});
