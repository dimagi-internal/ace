/**
 * Tests for `lib/maestro-failure-class.ts` — parses Maestro stderr +
 * exit code into a 6-class failure taxonomy so eval/retry logic can
 * act on the signal instead of looking at strings and guessing.
 *
 * The string patterns are taken from real production stderr captured
 * in the mobile learnings docs (UNAVAILABLE: io exception, shell
 * timeout, etc.) and from Maestro's source-of-truth exception names
 * (StepExecutionException, appCrashed).
 */
import { describe, it, expect } from 'vitest';
import { classifyMaestroFailure } from '../../lib/maestro-failure-class.js';

describe('classifyMaestroFailure — driver / gRPC class', () => {
  it('classifies UNAVAILABLE: io exception as driver', () => {
    const r = classifyMaestroFailure({
      stderr: 'maestro hierarchy exit 1: UNAVAILABLE: io exception',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('driver');
  });

  it('classifies probe1 shell timeout as driver', () => {
    const r = classifyMaestroFailure({
      stderr: 'probe1: shell timeout: maestro --host=localhost --port=5557 hierarchy',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('driver');
  });

  it('classifies RESOURCE_EXHAUSTED as driver', () => {
    const r = classifyMaestroFailure({
      stderr: 'io.grpc.StatusRuntimeException: RESOURCE_EXHAUSTED',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('driver');
  });

  it('classifies dadb broken pipe as driver', () => {
    const r = classifyMaestroFailure({
      stderr: 'java.io.IOException: Broken pipe',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('driver');
  });
});

describe('classifyMaestroFailure — app-crash class', () => {
  it('classifies appCrashed as app-crash', () => {
    const r = classifyMaestroFailure({
      stderr: 'AssertionFailure: appCrashed: org.commcare.dalvik',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('app-crash');
  });

  it('classifies "Application has stopped" as app-crash', () => {
    const r = classifyMaestroFailure({
      stderr: 'Maestro detected: Application has stopped',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('app-crash');
  });

  it('classifies ANR as app-crash', () => {
    const r = classifyMaestroFailure({
      stderr: 'ANR detected in org.commcare.dalvik',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('app-crash');
  });
});

describe('classifyMaestroFailure — selector-not-found class', () => {
  it('classifies "assertion failed: not visible" as selector-not-found', () => {
    const r = classifyMaestroFailure({
      stderr: 'Assertion failed: id "tv_learn_modules_list" not visible',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('selector-not-found');
  });

  it('classifies "Element not found" as selector-not-found', () => {
    const r = classifyMaestroFailure({
      stderr: 'Element not found: text "Start Learning"',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('selector-not-found');
  });

  it('classifies extendedWaitUntil timeout on a selector as selector-not-found', () => {
    const r = classifyMaestroFailure({
      stderr: 'extendedWaitUntil timed out after 15000ms waiting for visible element',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('selector-not-found');
  });

  it('classifies "No element found with id" as selector-not-found', () => {
    const r = classifyMaestroFailure({
      stderr: 'No element found with id "nav_btn_next"',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('selector-not-found');
  });
});

describe('classifyMaestroFailure — test-logic class', () => {
  it('classifies YAML parse error as test-logic', () => {
    const r = classifyMaestroFailure({
      stderr: 'Failed to parse recipe: expected <block end>',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('test-logic');
  });

  it('classifies "Sorry, this response is required" warning as test-logic', () => {
    // This is the form-advance-without-answer-tap symptom: the recipe
    // tried to advance past a required-input form field without
    // tapping an answer.
    const r = classifyMaestroFailure({
      stderr: 'visible: Sorry, this response is required!',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('test-logic');
  });

  it('classifies "unknown step key" as test-logic', () => {
    const r = classifyMaestroFailure({
      stderr: 'RecipeValidationError: unknown step key: tapOnText',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('test-logic');
  });
});

describe('classifyMaestroFailure — timeout class', () => {
  it('classifies generic "Timed out" (not bound to a selector) as timeout', () => {
    const r = classifyMaestroFailure({
      stderr: 'Timed out after 10 minutes',
      stdout: '',
      exitCode: 124, // POSIX timeout exit code
    });
    expect(r.failureClass).toBe('timeout');
  });

  it('classifies "command timed out" with no other signal as timeout', () => {
    const r = classifyMaestroFailure({
      stderr: 'maestro test command timed out',
      stdout: '',
      exitCode: 124,
    });
    expect(r.failureClass).toBe('timeout');
  });
});

describe('classifyMaestroFailure — network class', () => {
  it('classifies "Connection refused" as network', () => {
    const r = classifyMaestroFailure({
      stderr: 'java.net.ConnectException: Connection refused',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('network');
  });

  it('classifies "Unknown host" as network', () => {
    const r = classifyMaestroFailure({
      stderr: 'java.net.UnknownHostException: api.maestro.mobile.dev',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('network');
  });
});

describe('classifyMaestroFailure — pass + unknown', () => {
  it('returns "pass" sentinel when exitCode is 0', () => {
    const r = classifyMaestroFailure({ stderr: '', stdout: '', exitCode: 0 });
    expect(r.failureClass).toBe('pass');
  });

  it('returns "unknown" for unrecognized stderr on non-zero exit', () => {
    const r = classifyMaestroFailure({
      stderr: 'something weird that has never been seen before',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('unknown');
  });

  it('precedence: app-crash beats selector-not-found when both appear', () => {
    // If the app crashed mid-flow, that's the root cause, not "selector
    // not found" (which is a downstream symptom of the app no longer
    // rendering).
    const r = classifyMaestroFailure({
      stderr: 'AssertionFailure: appCrashed: org.commcare.dalvik\nElement not found: text "Sync"',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('app-crash');
  });

  it('precedence: driver beats everything else when present', () => {
    // If the driver itself is UNAVAILABLE, all downstream messages are
    // unreliable — the recipe never ran in the first place.
    const r = classifyMaestroFailure({
      stderr:
        'UNAVAILABLE: io exception\nAssertionFailure: appCrashed: org.commcare.dalvik',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('driver');
  });
});

describe('classifyMaestroFailure — excerpt + stageReached', () => {
  it('returns a bounded stderr excerpt (<=240 chars) for the caller to display', () => {
    const longErr = 'x'.repeat(2000);
    const r = classifyMaestroFailure({ stderr: longErr, stdout: '', exitCode: 1 });
    expect(r.stderrExcerpt.length).toBeLessThanOrEqual(240);
  });

  it('extracts stage_reached from "Running flow: <name>" stderr breadcrumbs', () => {
    const r = classifyMaestroFailure({
      stderr:
        'Running flow: connect-claim-opp.yaml\n[OK] launchApp\n[OK] tapOn id=action_sync\n[FAIL] Element not found: text "Start Learning"',
      stdout: '',
      exitCode: 1,
    });
    expect(r.failureClass).toBe('selector-not-found');
    expect(r.stageReached).toBe('connect-claim-opp.yaml');
  });

  it('stageReached is undefined when no breadcrumb present', () => {
    const r = classifyMaestroFailure({
      stderr: 'Element not found: text "x"',
      stdout: '',
      exitCode: 1,
    });
    expect(r.stageReached).toBeUndefined();
  });
});
