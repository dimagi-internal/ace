/**
 * Tests for `lib/no-invite-detector.ts` — recognizes the canonical
 * pre-invite failure signature in registerTestUser's recipe output.
 *
 * The integration doc (`playbook/integrations/mobile-integration.md`
 * § Pre-invite gating) describes the failure mode: Connect-id's
 * `/users/start_configuration` calls `check_number_for_existing_invites`
 * synchronously. For phone numbers with no existing invite, the lookup
 * hangs past the gunicorn worker timeout, the worker dies with
 * SystemExit, and CommCare receives an empty body and force-stops.
 *
 * From Maestro's vantage point: the phone-entry tap succeeds, then on
 * the next step (typically Continue tap or downstream assertVisible),
 * the CommCare app is no longer in the foreground. Detecting this
 * pair of signals lets registerTestUser surface a typed error
 * pointing at the connect_send_flw_invite remedy instead of a generic
 * "Part A failed: <stderr>" blob.
 */
import { describe, it, expect } from 'vitest';
import { detectNoInviteSignature } from '../../lib/no-invite-detector.js';
import { TEST_PHONE } from '../fixtures/test-phone.js';

describe('detectNoInviteSignature — positive cases (pre-invite failure)', () => {
  it('detects "Application is not in foreground" after Continue tap', () => {
    const stderr = [
      'Running flow: connect-register-to-otp.yaml',
      '[OK] launchApp',
      '[OK] tapOn id=primaryPhoneEditText',
      '[OK] inputText',
      '[OK] tapOn id=btn_continue',
      '[FAIL] assertVisible: Application org.commcare.dalvik is not in foreground',
    ].join('\n');
    expect(detectNoInviteSignature({ stderr, stdout: '' })).toBe(true);
  });

  it('detects "App background" after phone-entry tap', () => {
    const stderr = [
      'tapOn id=primaryPhoneEditText',
      'tapOn id=btn_continue',
      'expected app to be in foreground but was background',
    ].join('\n');
    expect(detectNoInviteSignature({ stderr, stdout: '' })).toBe(true);
  });

  it('detects force-stop signal in stdout after phone-entry', () => {
    const stdout = [
      'flow: tapOn primaryPhoneEditText (ok)',
      'flow: tapOn btn_continue (ok)',
      'org.commcare.dalvik force-stopped',
    ].join('\n');
    expect(detectNoInviteSignature({ stderr: '', stdout })).toBe(true);
  });
});

describe('detectNoInviteSignature — negative cases (other failures)', () => {
  it('does NOT trigger on a Maestro driver UNAVAILABLE error', () => {
    const stderr = 'UNAVAILABLE: io exception';
    expect(detectNoInviteSignature({ stderr, stdout: '' })).toBe(false);
  });

  it('does NOT trigger on a regular selector-not-found failure mid-flow', () => {
    const stderr = [
      'tapOn id=primaryPhoneEditText',
      `inputText "${TEST_PHONE}"`,
      'Element not found: id "btn_continue"',
    ].join('\n');
    expect(detectNoInviteSignature({ stderr, stdout: '' })).toBe(false);
  });

  it('does NOT trigger when the foreground-loss happens before the phone-entry tap', () => {
    // App went background BEFORE we ever tapped Continue — that's a
    // different class of failure (the app crashed on launch or
    // similar). The no-invite signature requires the foreground loss
    // to be AFTER the Continue tap.
    const stderr = [
      'launchApp org.commcare.dalvik',
      'Application is not in foreground',
    ].join('\n');
    expect(detectNoInviteSignature({ stderr, stdout: '' })).toBe(false);
  });

  it('does NOT trigger on an empty stderr/stdout pair', () => {
    expect(detectNoInviteSignature({ stderr: '', stdout: '' })).toBe(false);
  });

  it('does NOT trigger when only one of the two signals is present', () => {
    // Continue tap present but no foreground-loss signal anywhere.
    const stderr = 'tapOn id=btn_continue\nFlow completed successfully';
    expect(detectNoInviteSignature({ stderr, stdout: '' })).toBe(false);
  });
});

describe('detectNoInviteSignature — boundary cases', () => {
  it('treats Sentry CONNECT-ID-3F mentions as confirmatory', () => {
    const stderr = [
      'tapOn id=btn_continue',
      'CONNECT-ID-3F: start_configuration crashed with SystemExit',
    ].join('\n');
    expect(detectNoInviteSignature({ stderr, stdout: '' })).toBe(true);
  });

  it('case-insensitive on the key tokens', () => {
    const stderr = [
      'TapOn primaryPhoneEditText',
      'TapOn BTN_CONTINUE',
      'APPLICATION IS NOT IN FOREGROUND',
    ].join('\n');
    expect(detectNoInviteSignature({ stderr, stdout: '' })).toBe(true);
  });
});
