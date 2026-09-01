import { describe, it, expect } from 'vitest';
import { classifyTeardownFailure, teardownWarning } from '../../lib/maestro-teardown.js';

/**
 * dimagi-internal/ace#1822 — bednet-check-2-visit/20260828-0629.
 *
 * A Learn leg that had already submitted (Connect flipped
 * `learn_complete: true`, 35 non-zero PNGs, zero `*-FAILURE.*` forensics) was
 * reported as a failure because the JVM printed a teardown stack on the way
 * out. `Broken pipe` is a `driver` pattern, and `driver` is the one class the
 * heal-and-retry envelope acts on.
 *
 * The classifier's whole job is to be CONSERVATIVE: a teardown stack must
 * never rescue a walk that genuinely broke.
 */

// The verbatim stack from the incident.
const TEARDOWN_STACK = [
  'Exception in thread "Thread-5" java.net.SocketException: Broken pipe',
  '\tat dadb.AdbWriter.writeClose(AdbWriter.kt:60)',
  '\tat dadb.AdbStreamImpl.close(AdbStream.kt:130)',
  '\tat maestro.drivers.AndroidDriver.close(AndroidDriver.kt:184)',
  '\tat maestro.Maestro.close(Maestro.kt:500)',
  '\tat maestro.cli.session.MaestroSessionManager$MaestroSession.close(MaestroSessionManager.kt:467)',
  '\tat maestro.cli.session.MaestroSessionManager.newSession$lambda$2(MaestroSessionManager.kt:128)',
  '\tat kotlin.concurrent.ThreadsKt$thread$thread$1.run(Thread.kt:30)',
].join('\n');

const CLEAN_STEP_LOG = [
  'Running on emulator-5558',
  ' ||',
  ' ==> tapOn: id=nav_btn_next  COMPLETED',
  ' ==> takeScreenshot: journey-learn-posttest-result  COMPLETED',
].join('\n');

describe('classifyTeardownFailure — the incident shape', () => {
  it('recognises the verbatim 20260828-0629 teardown stack as teardown-only', () => {
    const r = classifyTeardownFailure({
      stdout: CLEAN_STEP_LOG,
      stderr: TEARDOWN_STACK,
      exitCode: 1,
    });
    expect(r.teardownOnly).toBe(true);
    expect(r.excerpt).toContain('Broken pipe');
    expect(r.excerpt).toContain('MaestroSessionManager');
  });

  it('produces a warning line that names the walk as the real result', () => {
    const r = classifyTeardownFailure({ stdout: '', stderr: TEARDOWN_STACK, exitCode: 1 });
    const w = teardownWarning(r.excerpt);
    expect(w).toMatch(/teardown threw AFTER the last step completed/);
    expect(w).toMatch(/Broken pipe/);
  });
});

describe('classifyTeardownFailure — a genuine failure is never absorbed', () => {
  it('exit 0 is not a teardown case', () => {
    const r = classifyTeardownFailure({ stdout: '', stderr: TEARDOWN_STACK, exitCode: 0 });
    expect(r.teardownOnly).toBe(false);
    expect(r.reason).toMatch(/exit 0/);
  });

  it('refuses a Broken pipe with NO teardown frames — that is a mid-walk transport death', () => {
    const r = classifyTeardownFailure({
      stdout: '',
      stderr: 'Exception in thread "Thread-5" java.net.SocketException: Broken pipe\n\tat dadb.AdbWriter.write(AdbWriter.kt:41)',
      exitCode: 1,
    });
    expect(r.teardownOnly).toBe(false);
    expect(r.reason).toMatch(/teardown frames/);
  });

  it('refuses a teardown stack on the MAIN thread', () => {
    const r = classifyTeardownFailure({
      stdout: '',
      stderr: TEARDOWN_STACK.replace('"Thread-5"', '"main"'),
      exitCode: 1,
    });
    expect(r.teardownOnly).toBe(false);
    expect(r.reason).toMatch(/non-main-thread/);
  });

  // The disqualifier set is the whole safety property: each of these means
  // something went wrong while steps were RUNNING, and a clean teardown
  // stack in the same output must not excuse it.
  it.each([
    ['Not able to reach the gRPC server while processing deviceInfo command', /gRPC unreachable/],
    ['io.grpc.StatusRuntimeException: UNAVAILABLE: io exception', /UNAVAILABLE/],
    ['Element not found: id=rvJobList', /element not found/],
    ['Assertion is false: id=nav_btn_finish is visible', /assertion failed/],
    ['[Failed] Tap on id: nav_btn_next', /\[Failed\]/],
    ['appCrashed: org.commcare.dalvik', /app crashed/],
    ['extendedWaitUntil timed out after 30000ms', /timed out/],
    ['Flow file does not exist: connect-login.yaml', /missing flow file/],
  ])('refuses when the output also carries %s', (evidence, reasonPattern) => {
    const r = classifyTeardownFailure({
      stdout: `${CLEAN_STEP_LOG}\n${evidence}`,
      stderr: TEARDOWN_STACK,
      exitCode: 1,
    });
    expect(r.teardownOnly).toBe(false);
    expect(r.reason).toMatch(reasonPattern);
  });

  it('refuses a plain non-zero exit with no exception banner at all', () => {
    const r = classifyTeardownFailure({ stdout: CLEAN_STEP_LOG, stderr: '', exitCode: 1 });
    expect(r.teardownOnly).toBe(false);
  });
});
