/**
 * Smoke-test ace-connect Playwright backend's Programs atoms end-to-end.
 *
 * Run: npx tsx scripts/_smoke-programs.ts
 *
 * Creates a program named ACE-Smoke-<timestamp> in ai-demo-space, then lists
 * programs to confirm. Will leave the test program in place — re-running the
 * script just creates more (harmless dupes; clean up in the UI later).
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

  const stamp = Date.now();
  const name = `ACE-Smoke-${stamp}`;

  console.log('1. Listing existing programs in ai-demo-space');
  const before = await backend.listPrograms({ organization_slug: 'ai-demo-space' });
  console.log(`   → ${before.programs.length} programs`);
  console.log(`   → first 3: ${before.programs.slice(0, 3).map((p) => p.name).join(', ')}`);

  console.log('2. listDeliveryTypes');
  const dts = await backend.listDeliveryTypes({ organization_slug: 'ai-demo-space' });
  console.log(`   → ${dts.delivery_types.length} types`);
  console.log(`   → 'Nutrition' = ${dts.delivery_types.find((d) => d.name === 'Nutrition')?.id}`);

  console.log(`3. createProgram '${name}'`);
  const created = await backend.createProgram({
    organization_slug: 'ai-demo-space',
    name,
    description: 'ACE smoke test program',
    delivery_type: 13,  // Nutrition
    budget: 5000,
    currency: 'USD',
    country: 'USA',
    start_date: '2026-05-01',
    end_date: '2026-08-01',
  });
  console.log(`   → id ${created.id}`);

  console.log('4. getProgram by id');
  const fetched = await backend.getProgram({ organization_slug: 'ai-demo-space', program_id: created.id });
  console.log(`   → ${fetched.name} (${fetched.id})`);

  console.log('5. updateProgram (rename)');
  const renamed = `${name}-renamed`;
  const updated = await backend.updateProgram({
    organization_slug: 'ai-demo-space',
    program_id: created.id,
    name: renamed,
  });
  console.log(`   → name now: ${updated.name}`);

  console.log('All Programs atoms passed ✓');
} finally {
  await session.close();
}
