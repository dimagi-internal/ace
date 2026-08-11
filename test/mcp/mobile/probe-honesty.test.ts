import { describe, it, expect } from 'vitest';
import {
  classifyDeviceUserState,
  detectUiAutomationFailure,
  describeAdbServerContention,
  describeProbeFailures,
  postFailureProbeVerdict,
} from '../../../mcp/mobile/client.js';
import {
  detectUiDumpFailure,
  parseAdbServerPorts,
  AvdBackend,
} from '../../../mcp/mobile/backends/avd.js';

/**
 * dimagi-internal/ace#1155 — the post-failure device probe reported
 * `classified_as=commcare-not-installed` twice, reproducibly, on a device
 * where CommCare was installed, booted, and foregrounded on
 * `PersonalIdActivity`. The real fault was that Android's single
 * `UiAutomation` slot could not be acquired (orphan adb daemons contending
 * for the device), so `uiautomator dump` never wrote `window_dump.xml`.
 *
 * Two invariants are pinned here:
 *   1. A package-state class is only reachable behind a SUCCESSFUL query.
 *      An empty result from a FAILED query is not a negative answer.
 *   2. UiAutomation contention has its own class, because its remediation
 *      ("kill the competing automation client") is the opposite of the one
 *      `commcare-not-installed` implies ("reinstall CommCare").
 */

const PKG = 'org.commcare.dalvik';

// The verbatim stack from the incident's `logcat -b crash`.
const UIAUTOMATION_CRASH = [
  'com.android.commands.uiautomator.DumpCommand.run(DumpCommand.java:78)',
  '  at android.app.UiAutomation.connectWithTimeout(UiAutomation.java:381)',
  '  at UiAutomationConnection.registerUiTestAutomationServiceLocked(:576)',
  'java.lang.RuntimeException: Bad file descriptor',
].join('\n');

describe('classifyDeviceUserState — a failed query is not a negative answer (ace#1155)', () => {
  it('NEVER reports commcare-not-installed when the package query failed', () => {
    // The regression, exactly as it shipped: package list unavailable,
    // device sitting on PersonalIdActivity, uiautomator dead.
    expect(
      classifyDeviceUserState(
        'mResumedActivity: org.commcare.dalvik/...PersonalIdActivity',
        '',
        null,
        '',
        { packageQueryFailed: true, uiDumpFailed: true },
      ),
    ).not.toBe('commcare-not-installed');
  });

  it('reports probe-failed when the package query errored and nothing names a cause', () => {
    expect(
      classifyDeviceUserState('', '', null, '', { packageQueryFailed: true }),
    ).toBe('probe-failed');
  });

  it('reports device-unreachable when the probe adb server saw no device at all', () => {
    expect(
      classifyDeviceUserState('', '', null, '', { deviceUnreachable: true }),
    ).toBe('device-unreachable');
  });

  it('device-unreachable outranks every other signal (nothing was observed)', () => {
    const drawer = '<node text="Opportunities"/><node text="Work History"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: HomeActivity', drawer, [PKG], '', {
        deviceUnreachable: true,
      }),
    ).toBe('device-unreachable');
  });

  it('reports uiautomation-unavailable — not probe-failed — when the crash log names the cause', () => {
    expect(
      classifyDeviceUserState('', '', null, UIAUTOMATION_CRASH, {
        packageQueryFailed: true,
        uiDumpFailed: true,
      }),
    ).toBe('uiautomation-unavailable');
  });

  it('still reports commcare-not-installed on a SUCCESSFUL query that came back empty', () => {
    // The honest negative must survive — this is the class's whole purpose.
    expect(classifyDeviceUserState('mResumedActivity: Launcher', '<dump/>', [])).toBe(
      'commcare-not-installed',
    );
  });

  it('keeps the legacy positional signature working (installedPackages as string[])', () => {
    const drawer = '<node text="Opportunities"/><node text="Work History"/>';
    expect(classifyDeviceUserState('mResumedActivity: X', drawer, [PKG])).toBe('ready');
  });
});

describe('classifyDeviceUserState — uiautomation-unavailable (ace#1155)', () => {
  it('classifies a failed dump as uiautomation-unavailable instead of unknown', () => {
    expect(
      classifyDeviceUserState(
        'mResumedActivity: org.commcare.dalvik/...PersonalIdActivity',
        '',
        [PKG],
        '',
        { uiDumpFailed: true },
      ),
    ).toBe('uiautomation-unavailable');
  });

  it('does NOT fire on an empty dump that was successfully taken', () => {
    // A screen with no hierarchy is still a fact about the screen.
    expect(classifyDeviceUserState('mResumedActivity: SomeActivity', '', [PKG], '', {})).toBe(
      'unknown',
    );
  });

  it('does NOT override a dumpsys-derived positive signal', () => {
    // `focusedActivity` comes from dumpsys, which is independent of
    // UiAutomation — a contended device can still be legitimately `ready`,
    // and that answer is more useful than a contention report.
    expect(
      classifyDeviceUserState('mResumedActivity: OpportunitiesActivity', '', [PKG], '', {
        uiDumpFailed: true,
      }),
    ).toBe('ready');
  });

  it('does NOT override a dumpsys-derived needs-app-config signal', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', '', [PKG], '', {
        uiDumpFailed: true,
      }),
    ).toBe('needs-app-config');
  });

  it('lets a real CommCare crash-loop win over UiAutomation noise', () => {
    const both = [
      'E AndroidRuntime: FATAL EXCEPTION: main',
      `E AndroidRuntime: Process: ${PKG}, PID: 4471`,
      UIAUTOMATION_CRASH,
    ].join('\n');
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', '', [PKG], both, {
        uiDumpFailed: true,
      }),
    ).toBe('app-crash-looping');
  });
});

describe('detectUiAutomationFailure', () => {
  it('matches the connectWithTimeout acquisition frame', () => {
    expect(detectUiAutomationFailure(UIAUTOMATION_CRASH)).toBe(true);
  });

  it('matches registerUiTestAutomationServiceLocked on its own', () => {
    expect(
      detectUiAutomationFailure('at UiAutomationConnection.registerUiTestAutomationServiceLocked(:576)'),
    ).toBe(true);
  });

  it('does not fire on ordinary uiautomator startup chatter', () => {
    const benign = [
      'D AndroidRuntime: >>>>>> START com.android.internal.os.RuntimeInit uid 2000 <<<<<<',
      'D AndroidRuntime: Calling main entry com.android.commands.uiautomator.Launcher',
      'I UiAutomationShellWrapper: connected',
    ].join('\n');
    expect(detectUiAutomationFailure(benign)).toBe(false);
  });

  it('is false for an absent logcat', () => {
    expect(detectUiAutomationFailure(undefined)).toBe(false);
    expect(detectUiAutomationFailure('')).toBe(false);
  });
});

describe('detectUiDumpFailure', () => {
  it('flags a non-zero uiautomator dump exit', () => {
    expect(detectUiDumpFailure(1, '', '<hierarchy/>', 0)).toBe(true);
  });

  it('flags the missing window_dump.xml read-back', () => {
    expect(
      detectUiDumpFailure(0, '', 'cat: /data/local/tmp/window_dump.xml: No such file or directory', 1),
    ).toBe(true);
  });

  it('flags the UiAutomation stack in the dump command output', () => {
    expect(detectUiDumpFailure(0, UIAUTOMATION_CRASH, '', 0)).toBe(true);
  });

  it('does NOT flag a clean dump that simply returned an empty hierarchy', () => {
    expect(detectUiDumpFailure(0, 'UI hierchary dumped to: ...', '', 0)).toBe(false);
  });

  it('does NOT flag a successful dump', () => {
    expect(detectUiDumpFailure(0, 'UI hierchary dumped to: ...', '<hierarchy/>', 0)).toBe(false);
  });
});

describe('parseAdbServerPorts', () => {
  it('extracts every -L tcp: fork-server port', () => {
    const ps = [
      '/usr/bin/adb -L tcp:5038 fork-server server --reply-fd 4',
      '/usr/bin/adb -L tcp:5040 fork-server server --reply-fd 4',
      '/usr/bin/adb -L tcp:5041 fork-server server --reply-fd 4',
      '/usr/bin/adb -L tcp:5042 fork-server server --reply-fd 4',
      '/Applications/Something.app/Contents/MacOS/Something',
    ].join('\n');
    expect(parseAdbServerPorts(ps)).toEqual([5038, 5040, 5041, 5042]);
  });

  it('treats a bare fork-server as the 5037 default', () => {
    expect(parseAdbServerPorts('adb fork-server server')).toEqual([5037]);
  });

  it('ignores non-adb processes and plain adb client calls', () => {
    const ps = ['adb -s emulator-5556 shell pm list packages', 'node server.js'].join('\n');
    expect(parseAdbServerPorts(ps)).toEqual([]);
  });

  it('dedupes', () => {
    expect(parseAdbServerPorts('adb -L tcp:5039 fork-server server\nadb -L tcp:5039 fork-server server')).toEqual([
      5039,
    ]);
  });
});

describe('describeAdbServerContention', () => {
  it('says nothing when one server (or none) holds the serial', () => {
    expect(describeAdbServerContention('emulator-5556', [])).toBeUndefined();
    expect(describeAdbServerContention('emulator-5556', [5039])).toBeUndefined();
  });

  it('names every contending port when the device is shared', () => {
    // The incident's exact host shape: four adb servers, one emulator.
    const msg = describeAdbServerContention('emulator-5556', [5042, 5038, 5041, 5040]);
    expect(msg).toContain('4 adb servers');
    expect(msg).toContain('5038, 5040, 5041, 5042');
    expect(msg).toContain('emulator-5556');
    expect(msg).toMatch(/kill the competing client/i);
  });
});

describe('describeProbeFailures', () => {
  it('names each thing the probe could not do', () => {
    expect(describeProbeFailures({ packageQueryFailed: true, uiDumpFailed: true })).toBe(
      'pm-list-packages-errored,uiautomator-dump-produced-no-xml',
    );
    expect(describeProbeFailures({ deviceUnreachable: true })).toBe('no-device-on-probe-adb-server');
    expect(describeProbeFailures({})).toBe('none');
  });
});

describe('postFailureProbeVerdict — no certainty the probe did not earn (ace#1155)', () => {
  it('refuses to assert "real registration failure" when the probe itself failed', () => {
    for (const cls of ['probe-failed', 'device-unreachable'] as const) {
      const msg = postFailureProbeVerdict(cls, 'probe:pm-list-packages-errored');
      expect(msg).not.toMatch(/real registration failure/);
      expect(msg).toMatch(/did NOT complete/);
    }
  });

  it('routes uiautomation-unavailable at the competing client, not at a reinstall', () => {
    const msg = postFailureProbeVerdict('uiautomation-unavailable', 'probe:uiautomator-dump-produced-no-xml');
    expect(msg).not.toMatch(/real registration failure/);
    expect(msg).toMatch(/NOT to reinstall CommCare/);
    expect(msg).toMatch(/kill the competing client/i);
  });

  it('marks unknown as inconclusive rather than confirmed', () => {
    expect(postFailureProbeVerdict('unknown', 'none')).toMatch(/inconclusive/);
  });

  it('keeps the confident wording for classes the probe actually observed', () => {
    expect(postFailureProbeVerdict('needs-personal-id', 'screen:personalid-wipe')).toMatch(
      /real registration failure not recipe flakiness/,
    );
  });
});

describe('AvdBackend.listPackages — throws rather than answering a question it could not ask', () => {
  it('throws on a non-zero pm list packages exit instead of returning []', async () => {
    const shell = async (cmd: string, args: string[]) => {
      if (cmd === 'adb' && args[0] === 'devices') {
        return { stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '', exitCode: 0 };
      }
      if (cmd === 'adb' && args.includes('name')) {
        return { stdout: 'ACE_Pixel_API_34\nOK\n', stderr: '', exitCode: 0 };
      }
      if (cmd === 'adb' && args.includes('pm')) {
        return { stdout: '', stderr: 'adb: device offline', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const backend = new AvdBackend({ shell });
    await expect(backend.listPackages('ACE_Pixel_API_34', 'org.commcare.dalvik')).rejects.toThrow(
      /pm list packages/,
    );
  });
});
