import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `/ace:doctor` must hand the gog file keyring its password before probing
 * Gmail — otherwise its most severe verdict is a false negative (ace#2358).
 *
 * ## The failure this pins
 *
 * `GOG_KEYRING_PASSWORD` lives in the plugin-data `.env` and in no shell
 * profile, so a plain `/ace:doctor` runs with it unset. gog cannot open the
 * keyring (`no TTY available for keyring file backend password prompt`), so
 * the scope probes and `canopy email preflight` both fail — and `gog_auth`
 * reported that as "cannot call Gmail … [TURN-BLOCKING]".
 *
 * That is worse than a cosmetic wrong answer:
 *
 *  - it is indistinguishable from a genuinely dead token, so it cannot be
 *    triaged by reading the output;
 *  - `skills/turn` treats any `[TURN-BLOCKING]` item as "do NOT proceed to
 *    the inbox pull", so a working mailbox is refused a turn; and
 *  - the printed remedy is an interactive browser OAuth, which does not fix
 *    it — measured 2026-09-10, a fresh verified-good canopy login still
 *    produced the warning, sending the operator in a circle.
 *
 * Same-baseline A/B on that date, clean env, working mailbox:
 *   unpatched -> WARN gog_auth … [TURN-BLOCKING] / "BROKEN for turns"
 *   patched   -> PASS gog_auth … / "HEALTHY"
 *
 * Asserted on source ORDER rather than by running doctor: the probes are live
 * network calls against a real mailbox, which a unit test must not require.
 */

const DOCTOR = readFileSync(
  join(__dirname, '..', '..', 'bin', 'ace-doctor'),
  'utf8',
);

describe('ace-doctor supplies the gog keyring password', () => {
  it('exports both keyring vars', () => {
    expect(DOCTOR).toMatch(/export GOG_KEYRING_BACKEND=/);
    expect(DOCTOR).toMatch(/export GOG_KEYRING_PASSWORD=/);
  });

  it('reads them from the resolved .env via get_env, not a hardcoded path', () => {
    expect(DOCTOR).toMatch(/get_env GOG_KEYRING_BACKEND/);
    expect(DOCTOR).toMatch(/get_env GOG_KEYRING_PASSWORD/);
  });

  it('only fills what the caller has not already exported', () => {
    // An explicit env must still win — doctor is also run from shells that
    // deliberately set a different keyring.
    const guard = /if \[ -z "\$\{GOG_KEYRING_PASSWORD:-\}" \]; then/;
    expect(DOCTOR).toMatch(guard);
    expect(DOCTOR).toMatch(/if \[ -z "\$\{GOG_KEYRING_BACKEND:-\}" \]; then/);
  });

  it('exports BEFORE canopy email preflight is invoked', () => {
    // The ordering is the whole fix: an export after the call changes nothing.
    const exportAt = DOCTOR.indexOf('export GOG_KEYRING_PASSWORD=');
    const preflightAt = DOCTOR.indexOf('canopy email preflight --repo');
    expect(exportAt, 'export GOG_KEYRING_PASSWORD not found').toBeGreaterThan(-1);
    expect(preflightAt, 'canopy email preflight call not found').toBeGreaterThan(-1);
    expect(
      exportAt,
      'the keyring password must be exported BEFORE `canopy email preflight`, ' +
        'or the preflight cannot open the keyring and reports a working mailbox as bad',
    ).toBeLessThan(preflightAt);
  });

  it('exports BEFORE the _gog probe helper is defined', () => {
    // The live scope probes go through `_gog` and need the keyring too, so the
    // export has to precede that helper as well as the preflight.
    const exportAt = DOCTOR.indexOf('export GOG_KEYRING_PASSWORD=');
    const gogHelperAt = DOCTOR.indexOf('_gog() { if [ -n "$GOG_TO_BIN" ]');
    expect(gogHelperAt, '_gog helper not found').toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(gogHelperAt);
  });
});
