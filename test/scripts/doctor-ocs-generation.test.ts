import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  it('guards a missing session file before launching chromium', () => {
    const guard = SCRIPT.indexOf('no live probe possible');
    const launch = SCRIPT.indexOf('chromium.launch');
    expect(guard).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(launch);
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

  it('discovers the generation provider instead of reading OCS_LLM_PROVIDER_ID', () => {
    // OCS_LLM_PROVIDER_ID is the EMBEDDINGS provider (378 on connect-ace);
    // generation is 377. Reading env here would name the wrong page.
    expect(SCRIPT).toContain('pickGenerationProviderId');
    expect(SCRIPT).not.toMatch(/process\.env\.OCS_LLM_PROVIDER_ID/);
  });
});
