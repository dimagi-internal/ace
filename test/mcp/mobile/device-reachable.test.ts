/**
 * ace#1357 fix 3 — don't drive recipes at a device that never came up.
 *
 * The observed run: three consecutive mobile_ensure_avd_running calls all
 * failing at `register_test_user part B`, with a dadb broken-pipe trace. The
 * real cause — a de-provisioned AVD's `cache.img` FATAL — was sitting in
 * ${TMPDIR}/ace-emulator-5554.log the whole time, because #1047's stderr
 * capture had written it. It was dropped because the attach block only
 * decorates errors from the boot-wait path.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAdbEcho,
  buildUnreachableMessage,
  REACHABILITY_TOKEN,
} from '../../../mcp/mobile/device-reachable';

describe('classifyAdbEcho', () => {
  it('is reachable only when the token comes back', () => {
    expect(classifyAdbEcho({ stdout: `${REACHABILITY_TOKEN}\n`, stderr: '' }))
      .toEqual({ reachable: true });
  });

  it('tolerates surrounding noise around the token', () => {
    expect(classifyAdbEcho({ stdout: `warning: blah\n${REACHABILITY_TOKEN}\r\n`, stderr: '' }).reachable)
      .toBe(true);
  });

  it('does NOT trust a zero exit with no token — adb exits 0 on a half-dead device', () => {
    const v = classifyAdbEcho({ stdout: '', stderr: '', exitCode: 0 });
    expect(v.reachable).toBe(false);
    expect(v.reason).toContain('exit 0');
  });

  it.each([
    ['error: device offline', 'offline'],
    ['error: device not found', 'no longer lists'],
    ['error: no devices/emulators found', 'no devices at all'],
    ['adb: device unauthorized', 'not authorised'],
  ])('names the cause for %s', (stderr, expected) => {
    const v = classifyAdbEcho({ stdout: '', stderr });
    expect(v.reachable).toBe(false);
    expect(v.reason).toContain(expected);
  });

  it('reports a thrown invocation rather than swallowing it', () => {
    const v = classifyAdbEcho({ stdout: '', stderr: '', error: 'spawn adb ENOENT' });
    expect(v.reachable).toBe(false);
    expect(v.reason).toContain('ENOENT');
  });

  it('classifies the observed Connection refused case', () => {
    const v = classifyAdbEcho({ stdout: '', stderr: 'Connection refused' });
    expect(v.reason).toContain('nothing is listening');
  });
});

describe('buildUnreachableMessage leads with the cause, not the symptom', () => {
  const base = { serial: 'emulator-5554', avdName: 'ACE_Pixel_API_34', reason: 'adb reports the device offline' };

  it('says plainly that this is not a registration failure', () => {
    const m = buildUnreachableMessage(base);
    expect(m).toContain('Not a registration failure');
    expect(m).toContain('never got a device to drive');
  });

  it('surfaces the emulator FATAL line when one was captured', () => {
    const m = buildUnreachableMessage({
      ...base,
      bootLogPath: '/tmp/ace-emulator-5554.log',
      fatalLine: "PANIC: Cannot find AVD system path... 'cache.img': No such file or directory",
    });
    expect(m).toContain('cache.img');
    expect(m).toContain('The emulator said why when it started');
    expect(m).toContain('/tmp/ace-emulator-5554.log');
  });

  it('falls back to the tail when no single fatal line stands out', () => {
    const m = buildUnreachableMessage({ ...base, bootLogPath: '/tmp/x.log', tail: 'line1\nline2' });
    expect(m).toContain('Last lines of the emulator boot log');
    expect(m).toContain('line2');
  });

  it('prefers the fatal line over the tail when both are present', () => {
    const m = buildUnreachableMessage({
      ...base, bootLogPath: '/tmp/x.log', fatalLine: 'FATAL: boom', tail: 'noise\nmore noise',
    });
    expect(m).toContain('FATAL: boom');
    expect(m).not.toContain('more noise');
  });

  it('says so explicitly when NO boot log was found, rather than staying silent', () => {
    const m = buildUnreachableMessage(base);
    expect(m).toContain('No emulator boot log was found');
  });

  it('names the re-provisioning remedy — the failure reads like a probe bug otherwise', () => {
    expect(buildUnreachableMessage(base)).toContain('/ace:mobile-bootstrap');
  });

  it('always identifies which serial and AVD', () => {
    const m = buildUnreachableMessage(base);
    expect(m).toContain('emulator-5554');
    expect(m).toContain('ACE_Pixel_API_34');
  });
});
