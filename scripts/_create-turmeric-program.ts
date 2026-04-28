/**
 * E2E test: create the turmeric-dogfood program in ai-demo-space using
 * ace-connect's Playwright backend directly (bypasses the running stale
 * MCP subprocess). Equivalent to what `connect-program-setup` would do
 * once routed through the MCP.
 */
import 'dotenv/config';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { PlaywrightBackend } from '../mcp/connect/backends/playwright.js';

const session = new PlaywrightSession({
  baseUrl: process.env.CONNECT_BASE_URL!,
  hqUsername: process.env.ACE_HQ_USERNAME,
  hqPassword: process.env.ACE_HQ_PASSWORD,
});

try {
  const ctx = await session.getContext();
  const backend = new PlaywrightBackend({
    baseUrl: process.env.CONNECT_BASE_URL!,
    csrfToken: session.getCsrfToken(),
    request: ctx.request,
  });

  const ORG = 'ai-demo-space';
  const NAME = 'Turmeric Market Survey (dogfood — 2026-04-27)';

  // 1. Idempotency check
  console.log('1. Checking for existing program with same name');
  const existing = await backend.listPrograms({ organization_slug: ORG, name: NAME });
  if (existing.programs.length > 0) {
    console.log(`   → already exists: ${existing.programs[0].id}`);
    console.log('   Skipping create. Pass --recreate to force.');
    process.exit(0);
  }
  console.log('   → none; proceeding to create');

  // 2. Verify delivery_type=11 ('Interview') exists
  console.log('2. Verifying delivery_type=11 (Interview)');
  const dts = await backend.listDeliveryTypes({ organization_slug: ORG });
  const dt = dts.delivery_types.find((d) => d.id === 11);
  console.log(`   → ${dt?.name ?? '(not found!)'}`);

  // 3. Create
  console.log('3. Creating program');
  const created = await backend.createProgram({
    organization_slug: ORG,
    name: NAME,
    description: 'Atomic-visit market survey: FLWs visit turmeric vendors and capture GPS + photo (with yellow MTN reference card) + 18-field form covering vendor demographics, product, sourcing, FLW visual quality observations, and education delivery. Output: vendor map + photo dataset for triage of suspected lead-chromate adulteration. Created via ace-connect MCP from ACE/turmeric-dogfood-20260427/pdd.md.',
    delivery_type: 11,  // Interview
    budget: 10000,
    currency: 'USD',
    country: 'IND',  // South Asia per PDD
    start_date: '2026-05-15',
    end_date: '2026-06-15',
  });
  console.log(`   → id ${created.id}`);
  console.log(`   → URL: ${process.env.CONNECT_BASE_URL}/a/${ORG}/program/`);
  console.log('Program creation succeeded ✓');
} finally {
  await session.close();
}
