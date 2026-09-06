import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_PROBE_ATTEMPTS,
  probeStatusFor,
  runGenerationProbeWithRetry,
  shouldRetryGenerationProbe,
  type GenerationProbeClass,
} from '../../lib/ocs-generation-probe.js';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1516 — static gates on the WIRING of the ocs_generation
// probe. The classifier is unit-tested in test/lib/ocs-generation-probe.test.ts;
// what this file protects is the part that has no runtime signal at all: WHERE
// in bin/ace-doctor the probe is invoked.
//
// The issue's own "fix lands here" pointer said `[Auth liveness]`, ~line 1119.
// That pointer is wrong in a load-bearing way: `--preflight` does `exit 0`
// hundreds of lines earlier, so a probe wired only into [Auth liveness] would
// never run inside /ace:run and would leave the timing exactly as blind as
// before the fix. This test makes that mistake impossible to reintroduce.
// ---------------------------------------------------------------------------

const DOCTOR = readFileSync(fileURLToPath(new URL('../../bin/ace-doctor', import.meta.url)), 'utf8');
const SCRIPT = readFileSync(
  fileURLToPath(new URL('../../scripts/doctor-ocs-generation.ts', import.meta.url)),
  'utf8',
);

describe('bin/ace-doctor wires the ocs_generation probe', () => {
  it('invokes scripts/doctor-ocs-generation.ts', () => {
    expect(DOCTOR).toContain('scripts/doctor-ocs-generation.ts');
  });

  it('invokes it from BOTH the preflight (yaml) and the human (lines) surfaces', () => {
    expect(DOCTOR).toContain('doctor-ocs-generation.ts --format=yaml');
    expect(DOCTOR).toContain('doctor-ocs-generation.ts --format=lines');
  });

  it('emits an ocs_generation block into the preflight heredoc', () => {
    expect(DOCTOR).toContain('${PF_OCS_GEN_YAML}');
  });

  it('offers --no-live so `--preflight --no-live` stays instant', () => {
    expect(DOCTOR).toMatch(/--no-live\)\s+NO_LIVE=1/);
  });
});

describe('the preflight invocation runs BEFORE preflight exits (the real fix)', () => {
  /** Index of the `exit 0` that ends the --preflight block. */
  function preflightExitIndex(src: string): number {
    const m = /# Preflight is a machine-facing YAML snapshot: it ends here, unconditionally\./.exec(
      src,
    );
    expect(m, 'the --preflight terminating comment must still exist').not.toBeNull();
    const from = m!.index;
    const exitIdx = src.indexOf('exit 0', from);
    expect(exitIdx, 'preflight must still terminate with exit 0').toBeGreaterThan(-1);
    return exitIdx;
  }

  it('calls the probe at a LOWER line number than the preflight exit 0', () => {
    const invocation = DOCTOR.indexOf('doctor-ocs-generation.ts --format=yaml');
    expect(invocation).toBeGreaterThan(-1);
    const exitIdx = preflightExitIndex(DOCTOR);
    expect(invocation).toBeLessThan(exitIdx);

    // Same assertion stated in line numbers, because that is how the failure
    // reads to a human triaging it.
    const lineOf = (idx: number) => DOCTOR.slice(0, idx).split('\n').length;
    expect(lineOf(invocation)).toBeLessThan(lineOf(exitIdx));
  });

  it('does NOT rely on the [Auth liveness] invocation for /ace:run coverage', () => {
    // [Auth liveness] is unreachable under --preflight; if the yaml invocation
    // ever moves below it, the probe silently stops covering runs.
    const authLiveness = DOCTOR.indexOf('echo "[Auth liveness]"');
    expect(authLiveness).toBeGreaterThan(-1);
    expect(DOCTOR.indexOf('doctor-ocs-generation.ts --format=yaml')).toBeLessThan(authLiveness);
    expect(DOCTOR.indexOf('doctor-ocs-generation.ts --format=lines')).toBeGreaterThan(authLiveness);
  });
});

describe('scripts/doctor-ocs-generation.ts is safe to run in a preflight', () => {
  it('hard-caps its wait well below 30s', () => {
    const m = /const PROBE_TIMEOUT_MS = ([\d_]+);/.exec(SCRIPT);
    expect(m, 'PROBE_TIMEOUT_MS must be a named constant').not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ''));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(30_000);
  });

  it('races the send against that cap rather than inheriting rest.ts’s 120s poll', () => {
    expect(SCRIPT).toContain('Promise.race');
    expect(SCRIPT).toMatch(/withTimeout\(\s*\n?\s*composite\.sendTestMessage/);
  });

  it('always exits 0 so a broken probe never takes doctor down', () => {
    expect(SCRIPT).toMatch(/process\.exit\(0\)/);
  });

  it('guards an unrecoverable session before constructing the session', () => {
    const guard = SCRIPT.indexOf('no live probe possible');
    const construct = SCRIPT.indexOf('new PlaywrightSession');
    expect(guard).toBeGreaterThan(-1);
    expect(construct).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(construct);
  });

  // ── ace#1767: the ace#1338 class, caught structurally ────────────────────
  //
  // The probe reused CompositeBackend and PlaywrightBackend but hand-rolled
  // the ONE part that owns auth: `chromium.newContext({ storageState })`.
  // Playwright silently drops a cookie whose local `expires` stamp has passed,
  // so the context went out anonymous against a server-side session that was
  // still valid; OCS 302'd to /accounts/login/, the transport followed it, and
  // `homeRes.ok` was true for the sign-in page. The scrape then reported a
  // FEATURE FLAG problem, doctor reported `fail, class: unknown`, and `fail`
  // halts /ace:run before Phase 1 (ace#1516).
  //
  // PlaywrightSession already owned both missing halves — an isAuthenticated()
  // that probes with maxRedirects:0, and credential auto-relogin. These gates
  // exist so the divergence cannot be reintroduced by someone reaching for a
  // browser directly; prose asking for it has not been enough anywhere else.
  it('never hand-rolls a browser context — auth belongs to PlaywrightSession', () => {
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('PlaywrightSession');
    expect(code).not.toMatch(/chromium\.launch/);
    expect(code).not.toMatch(/newContext\s*\(/);
    expect(code).not.toMatch(/storageState/);
  });

  it('supplies the response’s final url so a followed 302 is detectable', () => {
    // Without this the backend cannot tell OCS's sign-in page (200) from the
    // page it asked for, which is the whole mechanism of ace#1767.
    expect(SCRIPT).toContain('url: res.url()');
  });

  it('takes the halt/no-halt decision from the shared table, not a local literal', () => {
    // Reporting `fail` for an auth failure is what halted the run. Keeping the
    // mapping in lib/ keeps it unit-testable and single-sourced.
    expect(SCRIPT).toContain('probeStatusFor');
    expect(SCRIPT).not.toMatch(/status:\s*'fail'/);
  });

  it('never lets an env loader write to stdout — the yaml IS the preflight block', () => {
    // Caught live pre-merge: dotenv/dotenvx prints "injected env (43) from …"
    // to STDOUT, and this script's stdout is spliced verbatim into the
    // --preflight YAML. One banner line and the orchestrator's snapshot stops
    // parsing, with no human in the loop to notice.
    // Strip comments first — this file's own prose names the banned call.
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/from ['"]dotenv/);
    expect(code).not.toMatch(/dotenv\.config/);
  });

  it('retries the round-trip through the shared retry policy', () => {
    // ace#1628: the retry decision lives in lib/ocs-generation-probe.ts so it
    // is unit-testable without a live OCS. If the script stops routing through
    // it, the behaviour below stops describing what preflight actually does.
    expect(SCRIPT).toContain('runGenerationProbeWithRetry');
  });

  it('discovers the generation provider instead of reading OCS_LLM_PROVIDER_ID', () => {
    // OCS_LLM_PROVIDER_ID is the EMBEDDINGS provider (378 on connect-ace);
    // generation is 377. Reading env here would name the wrong page.
    expect(SCRIPT).toContain('pickGenerationProviderId');
    expect(SCRIPT).not.toMatch(/process\.env\.OCS_LLM_PROVIDER_ID/);
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1628 — a transient `timeout` must not halt /ace:run.
//
// Observed on bednet-check-2-visit/20260825-1310: preflight reported
// `status: fail, class: timeout, provider_id: 377`, and two immediate re-runs
// of the same script both returned `status: pass, class: ok`. The provider was
// healthy the whole time; the first probe was just slow past the 25s cap. The
// orchestrator halts before Phase 1 on `fail`, so a healthy provider blocked a
// multi-hour run.
//
// These exercise the pure driver the script routes through, so no live OCS is
// needed. The script's status mapping is `class === 'ok' ? pass : fail`, so
// "the last attempt's class" IS the reported status.
// ---------------------------------------------------------------------------

interface FakeResult {
  status: 'pass' | 'fail' | 'skip';
  class: GenerationProbeClass;
}

/**
 * Mirrors the script by CALLING the same mapping it calls, rather than
 * restating it. The old local copy (`cls === 'ok' ? 'pass' : 'fail'`) went
 * stale the moment `no_session` became a `skip` (ace#1767), and a stale mirror
 * in a test is worse than none: it asserts the behaviour the fix removed.
 */
function resultFor(cls: GenerationProbeClass): FakeResult {
  return { status: probeStatusFor(cls), class: cls };
}

/** Drive the real retry loop over a scripted sequence of round-trip outcomes. */
async function driveSequence(sequence: GenerationProbeClass[]): Promise<{
  result: FakeResult;
  attempts: number;
}> {
  let attempts = 0;
  const result = await runGenerationProbeWithRetry<FakeResult>(async (n) => {
    attempts = n;
    const cls = sequence[Math.min(n, sequence.length) - 1];
    return resultFor(cls);
  });
  return { result, attempts };
}

describe('the probe retries a transient timeout exactly once (ace#1628)', () => {
  it('timeout → ok reports pass', async () => {
    const { result, attempts } = await driveSequence(['timeout', 'ok']);
    expect(attempts).toBe(2);
    expect(result.class).toBe('ok');
    expect(result.status).toBe('pass');
  });

  it('timeout → timeout reports fail, exactly as before the fix', async () => {
    const { result, attempts } = await driveSequence(['timeout', 'timeout']);
    expect(attempts).toBe(2);
    expect(result.class).toBe('timeout');
    expect(result.status).toBe('fail');
  });

  it('never spends more than MAX_PROBE_ATTEMPTS round-trips', async () => {
    const { attempts } = await driveSequence(['timeout', 'timeout', 'timeout', 'timeout']);
    expect(MAX_PROBE_ATTEMPTS).toBe(2);
    expect(attempts).toBe(MAX_PROBE_ATTEMPTS);
  });

  it('does NOT retry the definitive dead-provider classes', async () => {
    // A capped provider errors in ~6s (scripts/doctor-ocs-generation.ts) and an
    // auth rejection likewise: these are conclusive, so a retry would only
    // double the latency of a real failure. Pinning that is the point.
    for (const cls of ['provider_capped', 'provider_auth', 'no_channel'] as GenerationProbeClass[]) {
      const { result, attempts } = await driveSequence([cls, 'ok']);
      expect(attempts, `${cls} must not be retried`).toBe(1);
      expect(result.class).toBe(cls);
      expect(result.status).toBe('fail');
    }
  });

  it('does not retry a pass, and does not retry the other non-transient classes', async () => {
    for (const cls of ['ok', 'transport', 'unknown', 'no_session'] as GenerationProbeClass[]) {
      const { attempts } = await driveSequence([cls, 'ok']);
      expect(attempts, `${cls} must not be retried`).toBe(1);
    }
  });

  it('shouldRetryGenerationProbe is timeout-only and attempt-bounded', () => {
    expect(shouldRetryGenerationProbe('timeout', 1)).toBe(true);
    expect(shouldRetryGenerationProbe('timeout', MAX_PROBE_ATTEMPTS)).toBe(false);
    expect(shouldRetryGenerationProbe('provider_capped', 1)).toBe(false);
    expect(shouldRetryGenerationProbe('ok', 1)).toBe(false);
  });
});
