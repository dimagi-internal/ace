import { describe, it, expect, vi } from 'vitest';
import { fetchOtp, type ChromiumLike } from '../../../../mcp/mobile/auth/fetch-otp.js';
import { OtpFetchError } from '../../../../mcp/mobile/errors.js';

function mockChromium(html: string, signedIn = true): ChromiumLike {
  const page = {
    goto: vi.fn().mockResolvedValue({ ok: () => true }),
    url: vi.fn().mockReturnValue(
      signedIn
        ? 'https://connect.dimagi.com/users/connect_user_otp/'
        : 'https://connect.dimagi.com/sso/login',
    ),
    content: vi.fn().mockResolvedValue(html),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    launchPersistentContext: vi.fn().mockResolvedValue(context),
  } as unknown as ChromiumLike;
}

describe('fetchOtp', () => {
  it('parses 6-digit OTP for the given phone from page HTML', async () => {
    const html = `
      <table>
        <tr><td>+74260000001</td><td>123456</td><td>2026-04-28 12:00</td></tr>
        <tr><td>+74260000002</td><td>654321</td><td>2026-04-28 12:01</td></tr>
      </table>`;
    const r = await fetchOtp('+74260000002', {
      chromium: mockChromium(html),
      userDataDir: '/tmp/userdata',
    });
    expect(r.otp).toBe('654321');
    expect(r.phone).toBe('+74260000002');
  });

  it('throws OtpFetchError(AUTH_REQUIRED) when redirected to SSO', async () => {
    await expect(
      fetchOtp('+74260000002', {
        chromium: mockChromium('', false),
        userDataDir: '/tmp/userdata',
      }),
    ).rejects.toMatchObject({ code: 'OTP_AUTH_REQUIRED' });
  });

  it('throws OtpFetchError(NOT_FOUND) when phone has no row', async () => {
    const html = `<table><tr><td>+74260000999</td><td>111111</td></tr></table>`;
    await expect(
      fetchOtp('+74260000001', {
        chromium: mockChromium(html),
        userDataDir: '/tmp/userdata',
      }),
    ).rejects.toMatchObject({ code: 'OTP_NOT_FOUND' });
  });
});
