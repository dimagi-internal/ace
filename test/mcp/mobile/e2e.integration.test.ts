// test/mcp/mobile/e2e.integration.test.ts
/**
 * MOBILE_INTEGRATION=1 npm run test:integration
 *
 * Requires: Mac with Android SDK, ACE_Pixel_API_34 AVD, registered ACE test user,
 * seeded Playwright cookies. Skipped without env flag.
 */
import { describe, it, expect } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';

const RUN = process.env.MOBILE_INTEGRATION === '1';
const describeIfRun = RUN ? describe : describe.skip;

describeIfRun('mobile e2e', () => {
  it('boots AVD and runs connect-login.yaml', async () => {
    const client = new MobileClient();
    const avdName = process.env.ACE_AVD_NAME || 'ACE_Pixel_API_34';
    const avd = await client.ensureAvdRunning(avdName);
    expect(avd.status).toBe('booted');

    const tmp = `/tmp/mobile-e2e-${Date.now()}`;
    const result = await client.runRecipe(
      `${client.staticRecipesDir}/connect-login.yaml`,
      {
        PHONE_LOCAL: process.env.ACE_E2E_PHONE_LOCAL!,
        PIN: process.env.ACE_E2E_PIN!,
      },
      tmp,
    );
    expect(result.status).toBe('pass');
    expect(result.screenshots.length).toBeGreaterThan(0);
  }, 5 * 60 * 1000); // 5min timeout
});
