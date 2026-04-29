import { chromium as defaultChromium, type BrowserContext } from 'playwright';
import { OtpFetchError } from '../errors.js';
import type { OtpResult } from '../types.js';

export interface ChromiumLike {
  launchPersistentContext(userDataDir: string, opts: { headless: boolean }): Promise<BrowserContext>;
}

export interface FetchOtpOpts {
  chromium?: ChromiumLike;
  userDataDir: string;
  url?: string;
  headed?: boolean;
}

const DEFAULT_URL = 'https://connect.dimagi.com/users/connect_user_otp/';

export async function fetchOtp(phone: string, opts: FetchOtpOpts): Promise<OtpResult> {
  const browser = (opts.chromium ?? defaultChromium) as ChromiumLike;
  const url = opts.url ?? DEFAULT_URL;
  const headed = opts.headed ?? false;

  const context = await browser.launchPersistentContext(opts.userDataDir, { headless: !headed });
  try {
    const page = await context.newPage();
    await page.goto(url);

    const onOtpPage = () =>
      page.url().startsWith('https://connect.dimagi.com/users/connect_user_otp/');

    if (!onOtpPage()) {
      if (!headed) {
        // Headless: cookies are stale or missing; bail fast.
        throw new OtpFetchError('AUTH_REQUIRED', phone);
      }
      // Headed (first-time-login flow): give the operator up to 5 minutes
      // to sign in via Dimagi SSO. The browser is open and on the SSO page;
      // once they finish auth, the redirect chain returns to the OTP page.
      // Poll the URL every second.
      process.stderr.write(
        '[ace-mobile] Waiting for Dimagi SSO sign-in (up to 5 min)...\n' +
          '            Sign in as ace@dimagi-ai.com (or any @dimagi.com SSO);\n' +
          '            cookies will persist for future headless runs.\n',
      );
      const deadline = Date.now() + 5 * 60 * 1000;
      while (!onOtpPage() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!onOtpPage()) {
        throw new OtpFetchError('AUTH_REQUIRED', phone);
      }
    }

    const html = await page.content();
    const otp = extractOtp(html, phone);
    if (!otp) throw new OtpFetchError('NOT_FOUND', phone);

    return { phone, otp, fetchedAt: new Date().toISOString() };
  } finally {
    await context.close();
  }
}

function extractOtp(html: string, phone: string): string | null {
  // Find a <tr> that contains the phone, then the next 6-digit run inside that <tr>.
  // Use a tempered match for row body: any char that doesn't begin "</tr>".
  const escaped = phone.replace(/[+]/g, '\\+');
  const rowRe = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?${escaped}(?:(?!</tr>)[\\s\\S])*?</tr>`, 'i');
  const m = html.match(rowRe);
  if (!m) return null;
  const otpMatch = m[0].match(/\b(\d{6})\b/);
  return otpMatch ? otpMatch[1] : null;
}
