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

    if (!page.url().startsWith('https://connect.dimagi.com/users/connect_user_otp/')) {
      throw new OtpFetchError('AUTH_REQUIRED', phone);
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
