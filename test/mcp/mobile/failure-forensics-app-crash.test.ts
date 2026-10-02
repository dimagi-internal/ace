/**
 * Regression guard for dimagi-internal/ace#2584.
 *
 * `captureFailureForensics` captured a ui-dump, a screenshot and the stderr
 * excerpt, but never the device's crash buffer. On
 * spark-facilitator/20261001-2208 Phase 6 CommCare threw a FATAL
 * `IllegalArgumentException` ~2s after the Start tap, restarted onto the
 * first-start screen, and the recipe waited out its 180s and failed an
 * `assertVisible(nsv_home_screen)` — reported as a selector/nav failure and
 * labelled `issue629`. Nothing in the result said the app had died; the crash
 * was found by hand with `adb logcat -d -b crash`.
 *
 * The invariant: a CommCare FATAL that happened DURING the failed recipe sets
 * `failureForensics.appCrash`; a system-app crash, an empty buffer, or a
 * CommCare crash that was already in the buffer before the recipe started
 * does not.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MobileClient,
  commcareCrashBlocks,
  newCommcareCrash,
} from '../../../mcp/mobile/client.js';
import type { RecipeRunResult } from '../../../mcp/mobile/types.js';

process.env.ACE_SCREENSHOT_ROOT = os.tmpdir();
// Local backend only: the crash buffer is read over adb. Pinned for the same
// worker-sharing reason as client-recording.test.ts.
process.env.ACE_MOBILE_BACKEND = 'local';

// Verbatim shape of the live crash buffer (issue body), plus the two
// system-app crashes that were on the same buffer in that run.
const SYSTEM_CRASHES = [
  '--------- beginning of crash',
  '10-01 18:40:02.101  1201  1201 E AndroidRuntime: FATAL EXCEPTION: main',
  '10-01 18:40:02.101  1201  1201 E AndroidRuntime: Process: com.google.android.configupdater, PID: 1201',
  '10-01 18:40:02.101  1201  1201 E AndroidRuntime: java.lang.SecurityException: not allowed',
  '10-01 18:41:10.500  1388  1388 E AndroidRuntime: FATAL EXCEPTION: main',
  '10-01 18:41:10.500  1388  1388 E AndroidRuntime: Process: com.google.android.permissioncontroller, PID: 1388',
  '10-01 18:41:10.500  1388  1388 E AndroidRuntime: java.lang.IllegalStateException: boom',
].join('\n');

const COMMCARE_CRASH = [
  '10-01 18:59:31.766  8179  8179 E AndroidRuntime: FATAL EXCEPTION: main',
  '10-01 18:59:31.766  8179  8179 E AndroidRuntime: Process: org.commcare.dalvik, PID: 8179',
  '10-01 18:59:31.766  8179  8179 E AndroidRuntime: java.lang.IllegalArgumentException: Navigation action/destination org.commcare.dalvik:id/action_connect_job_intro_fragment_to_connect_downloading_fragment cannot be found from the current destination Destination(org.commcare.dalvik:id/connect_downloading_fragment)',
  '10-01 18:59:31.766  8179  8179 E AndroidRuntime: \tat org.commcare.fragments.connect.ConnectJobIntroFragment$1.onSuccess(ConnectJobIntroFragment.java:161)',
].join('\n');

function failResult(dir: string): RecipeRunResult {
  return {
    status: 'fail', exitCode: 1, stdout: '',
    stderr: 'Assertion is false: id: org.commcare.dalvik:id/nsv_home_screen is visible',
    screenshotsDir: dir, screenshots: [],
    failure: {
      failureClass: 'unknown',
      stderrExcerpt: 'Assertion is false: id: org.commcare.dalvik:id/nsv_home_screen is visible',
    },
  } as RecipeRunResult;
}

/** A local client whose crash buffer reads `before` at recipe start and
 * `after` at failure time. */
function clientWithCrashBuffer(before: string, after: string) {
  const readCrashBuffer = vi.fn()
    .mockResolvedValueOnce(before)
    .mockResolvedValue(after);
  const avd = {
    findRunningAvd: vi.fn().mockResolvedValue({ name: 'ace-avd', serial: 'emulator-5554', status: 'booted' }),
    getAdbShell: () => vi.fn(),
    getAllocatedPorts: async () => ({ adbServerPort: 5038 }),
    captureUiDump: vi.fn().mockResolvedValue({ xml: '<hierarchy/>', elements: [] }),
    readCrashBuffer,
  };
  let call = 0;
  const maestro = {
    runRecipe: vi.fn(async (_r: string, _e: unknown, dir: string) => {
      call += 1;
      // 1st: the real recipe fails; 2nd: the throwaway screenshot recipe.
      return call === 1
        ? failResult(dir)
        : ({ status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: dir, screenshots: [] } as RecipeRunResult);
    }),
  };
  const client = new MobileClient({
    avd: avd as never,
    maestro: maestro as never,
    cloud: null as never,
    bootstrapConfig: null,
    recorder: { start: () => undefined as never, stop: async () => undefined },
    spool: { video: () => '', list: () => [], clear: () => {}, dir: () => '/x', count: () => 0 },
  });
  return { client, readCrashBuffer };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-forensics-'));
  const recipe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')), 'connect-claim-opp.yaml');
  fs.writeFileSync(recipe, 'appId: org.commcare.dalvik\n---\n- launchApp\n');
  return { root, recipe };
}

process.env.ACE_MOBILE_RECORD = 'off';

describe('failureForensics.appCrash (ace#2584)', () => {
  it('a CommCare FATAL during the failed recipe sets appCrash and writes the crash file', async () => {
    const { root, recipe } = setup();
    const { client, readCrashBuffer } = clientWithCrashBuffer(
      SYSTEM_CRASHES,
      `${SYSTEM_CRASHES}\n${COMMCARE_CRASH}`,
    );

    const result = await client.runRecipe(recipe, {}, root, 'ace-avd');

    expect(result.status).toBe('fail');
    const f = result.failureForensics!;
    expect(f.appCrash).toBeDefined();
    // The summary is CommCare's crash, not the first FATAL on the buffer.
    expect(f.appCrash).toContain('org.commcare.dalvik');
    expect(f.appCrash).toContain('IllegalArgumentException');
    expect(f.appCrash).not.toContain('configupdater');
    expect(f.crashLogPath).toBe(
      path.join(root, 'connect-claim-opp', 'connect-claim-opp-FAILURE-crash.txt'),
    );
    const written = fs.readFileSync(f.crashLogPath!, 'utf8');
    expect(written).toContain('ConnectJobIntroFragment.java:161');
    expect(written).not.toContain('permissioncontroller');
    expect(readCrashBuffer).toHaveBeenCalledWith('ace-avd');
  });

  it('NEGATIVE CONTROL: system-app crashes only leave appCrash unset', async () => {
    const { root, recipe } = setup();
    const { client } = clientWithCrashBuffer('', SYSTEM_CRASHES);
    const result = await client.runRecipe(recipe, {}, root, 'ace-avd');
    expect(result.status).toBe('fail');
    expect(result.failureForensics?.appCrash).toBeUndefined();
    expect(result.failureForensics?.crashLogPath).toBeUndefined();
  });

  it('NEGATIVE CONTROL: an empty crash buffer leaves appCrash unset', async () => {
    const { root, recipe } = setup();
    const { client } = clientWithCrashBuffer('', '');
    const result = await client.runRecipe(recipe, {}, root, 'ace-avd');
    expect(result.failureForensics?.appCrash).toBeUndefined();
  });

  it('NEGATIVE CONTROL: a CommCare crash already in the buffer before the recipe is not blamed on it', async () => {
    const { root, recipe } = setup();
    const stale = `${SYSTEM_CRASHES}\n${COMMCARE_CRASH}`;
    const { client } = clientWithCrashBuffer(stale, stale);
    const result = await client.runRecipe(recipe, {}, root, 'ace-avd');
    expect(result.failureForensics?.appCrash).toBeUndefined();
  });

  it('an unreadable crash buffer never turns the failure into a throw', async () => {
    const { root, recipe } = setup();
    const { client, readCrashBuffer } = clientWithCrashBuffer('', '');
    readCrashBuffer.mockReset().mockRejectedValue(new Error('adb: device offline'));
    const result = await client.runRecipe(recipe, {}, root, 'ace-avd');
    expect(result.status).toBe('fail');
    expect(result.failureForensics?.appCrash).toBeUndefined();
  });
});

describe('commcareCrashBlocks / newCommcareCrash (pure)', () => {
  it('extracts only CommCare blocks, bounded at the next FATAL', () => {
    const blocks = commcareCrashBlocks(`${SYSTEM_CRASHES}\n${COMMCARE_CRASH}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('PID: 8179');
    expect(blocks[0]).not.toContain('configupdater');
  });

  it('a block whose FATAL header was in the baseline is not new', () => {
    expect(newCommcareCrash(COMMCARE_CRASH, COMMCARE_CRASH)).toBeUndefined();
    expect(newCommcareCrash('', COMMCARE_CRASH)?.summary).toContain('IllegalArgumentException');
    // No baseline at all (read failed at recipe start): every CommCare block counts.
    expect(newCommcareCrash(undefined, COMMCARE_CRASH)).toBeDefined();
  });

  it('reports the LATEST new CommCare crash when several are new', () => {
    const second = COMMCARE_CRASH.replace(/18:59:31\.766  8179  8179/g, '19:01:00.001  8300  8300')
      .replace('PID: 8179', 'PID: 8300')
      .replace('IllegalArgumentException', 'NullPointerException');
    const r = newCommcareCrash('', `${COMMCARE_CRASH}\n${second}`);
    expect(r?.summary).toContain('NullPointerException');
    expect(r?.block).toContain('IllegalArgumentException');
    expect(r?.block).toContain('NullPointerException');
  });
});
