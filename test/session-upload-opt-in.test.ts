/**
 * Session-upload opt-in invariant.
 *
 * `/ace:run` used to enable the ace-web transcript upload IMPLICITLY: step 1a
 * read "if `--ace-web-url` is omitted *and* `ACE_WEB_PAT_TOKEN` is set, default
 * to https://labs.connect.dimagi.com/ace". Since `/ace:setup` provisions that
 * token as a matter of course, every CLI operator who ran setup was silently
 * uploading their full session transcript to a shared server — surprising
 * behaviour nobody opted into (Jonathan, 2026-07-28: "ace cli should NOT
 * automatically upload sessions to ace-web ... it should be off by default and
 * only turned on when CLI users need my help").
 *
 * The invariant: presence of a CREDENTIAL is never consent to UPLOAD. Enabling
 * requires an explicit signal — `--ace-web-url URL` on the invocation, or
 * `ACE_WEB_UPLOAD_SESSIONS=1` in the resolved .env.
 *
 * This is a test rather than a prose rule because the previous rule WAS prose
 * and it read as a helpful convenience ("Smart default"), which is exactly how
 * it survived review. A doc invariant that only exists in prose gets re-added
 * by the next person optimising for convenience.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');
const RUN_CMD = join(REPO_ROOT, 'commands/run.md');
const ENV_TPL = join(REPO_ROOT, '.env.tpl');
const UPLOAD_SKILL = join(REPO_ROOT, 'skills/upload-transcript/SKILL.md');

const OPT_IN_VAR = 'ACE_WEB_UPLOAD_SESSIONS';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('ace-web session upload is opt-in', () => {
  it('commands/run.md documents the opt-in env var', () => {
    expect(read(RUN_CMD)).toContain(OPT_IN_VAR);
  });

  it('.env.tpl declares the opt-in var and ships it disabled', () => {
    const tpl = read(ENV_TPL);
    expect(tpl).toContain(OPT_IN_VAR);
    // Declared, but never shipped enabled: an uncommented `=1` in the template
    // would opt every fresh machine in at `/ace:setup` time.
    expect(tpl).not.toMatch(new RegExp(`^${OPT_IN_VAR}\\s*=\\s*1\\s*$`, 'm'));
  });

  it('does NOT re-introduce a PAT-presence implicit default', () => {
    const doc = read(RUN_CMD);
    // Target the CONSTRUCTION, not mere co-occurrence of the words: a
    // conditional whose trigger is the token being set and whose consequence
    // is enabling/defaulting the upload. Matching on co-occurrence instead
    // would flag the paragraph that *forbids* this, which has to name the
    // token to forbid it.
    // Two calibration notes, both learned by getting it wrong here:
    //  - the window is `[\s\S]`, not `[^.]` — the original rule defaulted to a
    //    URL, and the dots in the hostname let a period-bounded window slip
    //    straight past the very text it was written to catch;
    //  - and it is applied PER PARAGRAPH, because a permissive window run over
    //    the whole file happily joins one paragraph's "if" to the next
    //    paragraph's token mention and reports a phantom.
    const regression =
      /\bif\b[\s\S]{0,160}ACE_WEB_PAT_TOKEN[\s\S]{0,160}\b(is set|non-empty|present)\b[\s\S]{0,220}\b(default|enabl|implicit)/i;
    const offenders = doc.split(/\n\s*\n/).filter((p) => regression.test(p));
    expect(offenders).toEqual([]);
  });

  it('run.md fires the upload on EVERY exit path, not just clean completion', () => {
    const doc = read(RUN_CMD);
    // A run that dies on context budget or an unrecoverable error is the one
    // most worth reviewing; the old wording ("after the orchestrator completes
    // ... or a gate halts") skipped exactly those.
    expect(doc).toMatch(/every exit path/i);
  });

  it('upload-transcript SKILL.md states it is never invoked implicitly', () => {
    expect(read(UPLOAD_SKILL)).toMatch(/opt-in/i);
  });
});
