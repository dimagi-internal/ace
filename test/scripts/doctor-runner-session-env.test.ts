import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `/ace:doctor` must warn when a canopy runner is paired on this box but the
 * sessions it spawns will not inherit the gog keyring password.
 *
 * ## The failure this pins (measured 2026-10-02, stewari-mbp-cdp)
 *
 * ACE used to run only in the operator's own Claude Code session, where the
 * `/ace:*` skills load the plugin-data `.env`. A canopy **laptop runner** is a
 * new execution context: launchd starts `com.canopy.runner`, which drives
 * emdash over CDP, and emdash spawns Claude Code with the GUI login
 * environment — no `.env`, and no TTY.
 *
 * `GOG_KEYRING_PASSWORD` lives in the plugin-data `.env` and in NO shell
 * profile (see the ace#2358 block in `bin/ace-doctor`), so a spawned session
 * cannot open the gog file keyring. A real caller turn on this box died on:
 *
 *   canopy email read --repo . <thread>
 *   -> could not read thread as ace@dimagi-ai.com: gmail options: read
 *      credentials: read OAuth client secret from keyring: ... no TTY
 *      available for keyring file backend password prompt;
 *      set GOG_KEYRING_PASSWORD
 *
 * The same credential path backs **send**, so agent email is dead both ways on
 * such a box, and `/ace:turn` inbox triage with it. Routing works, the agent
 * then cannot act — which is the worst shape: every green light is on.
 *
 * ## Why gog_auth does not already cover this
 *
 * It cannot, and it should not be changed to. `gog_auth` deliberately exports
 * `GOG_KEYRING_PASSWORD` itself before probing (ace#2358) because NOT doing so
 * produced a false negative that blocked turns on a working mailbox. That
 * export is correct for the question gog_auth asks — "is this mailbox
 * authorized on this machine?" — and it is exactly what makes it blind to this
 * one: doctor proves its OWN process can reach gmail, never that a spawned
 * session can.
 *
 * So this is an ADDITIONAL check, not a change to gog_auth. The two tests must
 * both hold: `doctor-gog-keyring-env.test.ts` pins the export, this pins the
 * warning about what the export does not cover.
 *
 * Asserted on source text rather than by running doctor: the probe shells out
 * and reads machine state, which a unit test should not depend on.
 *
 * ## UPDATE, ace#2844 — the check was right, its probe and its fix were not
 *
 * The warning above is real and still fires for the right reason. What was
 * wrong was everything around it:
 *
 *  - It probed a login shell and `launchctl getenv`, which answers "does this
 *    operator's GUI environment carry the password?" — not "can ACE send
 *    mail?". It therefore flagged TURN-BLOCKING on correctly-configured boxes.
 *  - Its fix hint offered `launchctl setenv` (which `canopy email preflight`
 *    forbids outright) and the runner's LaunchAgent plist (which reaches the
 *    runner daemon only, never the Emdash-spawned session a turn runs in).
 *
 * The remedy is `bin/ace-env`: it loads the keyring pair from the plugin-data
 * `.env` and execs the command, and every mandated gog / canopy email call in
 * the skills now goes through it. `bin/ace-email` and `bin/ace-mark-read` load
 * the same pair in-process. So the probe now asks whether that shim can hand
 * the credential to a child.
 */

const DOCTOR = readFileSync(
  join(__dirname, '..', '..', 'bin', 'ace-doctor'),
  'utf8',
);

describe('ace-doctor checks the runner session environment', () => {
  it('has a runner_session_env check', () => {
    expect(DOCTOR).toMatch(/runner_session_env/);
  });

  it('only fires when a canopy runner is actually paired on this box', () => {
    // A machine with no runner has no spawned-session context to be wrong
    // about; the check must stay silent there rather than nag every operator.
    expect(DOCTOR).toMatch(/\.canopy\/runner\.json/);
  });

  it('is TURN-BLOCKING, because email is dead both ways when it fires', () => {
    // warn_turn flips the verdict to "HEALTHY for runs - BROKEN for turns",
    // which is precisely the state: /ace:run is unaffected, /ace:turn cannot
    // read or send. A plain warn would let `skills/turn` proceed into an inbox
    // pull that cannot work.
    expect(DOCTOR).toMatch(/warn_turn "runner_session_env/);
  });

  it('probes without trusting doctor\'s own env', () => {
    // The whole point: doctor's process has the variable (it exported it).
    // Reading $GOG_KEYRING_PASSWORD here would always pass. The probe must
    // strip it before asking.
    expect(DOCTOR).toMatch(/env -u GOG_KEYRING_PASSWORD/);
  });

  it('probes bin/ace-env — the path ACE actually uses (ace#2844)', () => {
    // Until ace#2844 this probed a login shell and `launchctl getenv`, i.e.
    // "does the operator's GUI environment happen to carry the password?".
    // That is a property of their machine setup, not of whether ACE can send
    // mail, and it reported TURN-BLOCKING on a box where email worked fine.
    // What decides it is whether `bin/ace-env` can hand the credential to a
    // child, because that is what every mandated gog / canopy email call now
    // goes through.
    expect(DOCTOR).toMatch(/bin\/ace-env/);
    expect(DOCTOR).toMatch(/_rse_shim="\$ROOT\/bin\/ace-env"/);
    expect(DOCTOR).toMatch(/\$_rse_shim" printenv GOG_KEYRING_PASSWORD/);
  });

  it('never recommends launchctl setenv or the runner plist', () => {
    // Both were offered as remedies and BOTH are wrong, in different ways:
    //
    //  * `launchctl setenv` reaches a GUI-spawned emdash but hands the
    //    password to every process of this user — `canopy email preflight`
    //    forbids it in terms, so doctor recommending it put the two tools in
    //    direct contradiction in the same session.
    //  * `EnvironmentVariables` in com.canopy.runner.plist reaches the runner
    //    DAEMON and nothing else. Turns run in a session spawned by the Emdash
    //    GUI app, which is not a child of that launchd job. Measured
    //    2026-10-12 on stewari-mbp-cdp: plist correctly populated, daemon
    //    restarted 22s after the edit, `pgrep -P <runner-pid>` zero children,
    //    and the spawned turn still could not make one Gmail call.
    //
    // The second is the dangerous one to leave in a fix hint: it LOOKS like it
    // worked, because the daemon's own mailbox probe starts passing and
    // canopy-web then advertises `mailboxes_readable` for a box where no turn
    // can read mail.
    const start = DOCTOR.indexOf('runner_session_env');
    const block = DOCTOR.slice(start, start + 6000);
    expect(block).not.toMatch(/fix[^"]*launchctl setenv GOG_KEYRING_PASSWORD <the value/);
    // It may NAME them as things not to do; it must not offer them as the fix.
    // Backticks are backslash-escaped in doctor's double-quoted shell strings.
    expect(block).toMatch(/Do NOT use \\?`launchctl setenv/);
    expect(block).toMatch(/reaches the runner DAEMON only/);
  });

  it('stays silent when no file keyring password is configured at all', () => {
    // Nothing to propagate means nothing to warn about - a box on a different
    // gog keyring backend is not broken.
    const block = DOCTOR.slice(
      DOCTOR.indexOf('runner_session_env'),
      DOCTOR.indexOf('runner_session_env') + 3000,
    );
    expect(block).toMatch(/get_env GOG_KEYRING_PASSWORD/);
  });

  it('names the consequence, not just the missing variable', () => {
    // A fix hint that says "set a variable" sends the operator to the wrong
    // layer. The message has to say that agent email is dead both ways and
    // that /ace:turn is included, because that is what makes it turn-blocking.
    //
    // Scoped to the warn_turn LINE, not a byte window around the check: the
    // neighbouring canopy_email_engine check also contains the word "send",
    // so a window wide enough to reach this line would pass on its text
    // instead - a test that cannot fail for the reason it claims.
    const start = DOCTOR.indexOf('warn_turn "runner_session_env');
    expect(start).toBeGreaterThan(-1);
    const line = DOCTOR.slice(start, DOCTOR.indexOf('\n', start));
    expect(line).toMatch(/neither read nor send/);
    expect(line).toMatch(/\/ace:turn/);
  });
});
