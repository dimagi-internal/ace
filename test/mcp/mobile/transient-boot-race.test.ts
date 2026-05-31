import { describe, it, expect } from 'vitest';
import { isTransientBootRaceError } from '../../../mcp/mobile/errors.js';

// jjackson/ace#589 — the boot→driver→recipe handoff race detector. These are
// the exact strings observed in the malaria-rdt/20260531-0739 Part-A failure.
describe('isTransientBootRaceError', () => {
  it('matches the dadb.AdbStreamClosed signature', () => {
    expect(
      isTransientBootRaceError(
        new Error(
          'register_test_user part A failed: > Flow connect-register-to-otp\n' +
            'io.grpc.StatusRuntimeException: UNAVAILABLE\n' +
            'Caused by: dadb.AdbStreamClosed: ADB stream is closed for localId: 97188347',
        ),
      ),
    ).toBe(true);
  });

  it('matches "Not able to reach the gRPC server"', () => {
    expect(
      isTransientBootRaceError(
        new Error('[ERROR] Not able to reach the gRPC server while processing deviceInfo command'),
      ),
    ).toBe(true);
  });

  it('matches a bare gRPC UNAVAILABLE StatusRuntimeException', () => {
    expect(isTransientBootRaceError(new Error('io.grpc.StatusRuntimeException: UNAVAILABLE'))).toBe(true);
  });

  it('matches when the signature is only in the stack, not the message', () => {
    const e = new Error('register_test_user part A failed');
    e.stack = 'Error: ...\n  caused by dadb.AdbStreamClosed: ADB stream is closed';
    expect(isTransientBootRaceError(e)).toBe(true);
  });

  it('matches plain-string errors too', () => {
    expect(isTransientBootRaceError('ADB stream is closed for localId: 1')).toBe(true);
  });

  it('does NOT match an unrelated registration failure', () => {
    expect(
      isTransientBootRaceError(new Error('register_test_user part B failed: element not found')),
    ).toBe(false);
  });

  it('does NOT match the pre-invite gating signature', () => {
    expect(
      isTransientBootRaceError(new Error('CommCare fell out of foreground (no invite)')),
    ).toBe(false);
  });

  it('is null/undefined safe', () => {
    expect(isTransientBootRaceError(null)).toBe(false);
    expect(isTransientBootRaceError(undefined)).toBe(false);
  });
});
