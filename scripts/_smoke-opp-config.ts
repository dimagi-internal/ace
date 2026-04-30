/**
 * Smoke-test the new opportunity-config atoms against march-demo's existing
 * opportunity (read-only paths only — we don't mutate someone else's opp).
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

  const ORG = 'march-demo';
  const OPP = 'dea88661-1cd6-486b-ab25-48584bf61a8e';

  console.log('1. listOpportunities');
  const opps = await backend.listOpportunities({ organization_slug: ORG });
  console.log(`   → ${opps.opportunities.length} opps; first=${opps.opportunities[0]?.name}`);

  console.log('2. getOpportunity (hydrate from /edit)');
  const opp = await backend.getOpportunity({ organization_slug: ORG, opportunity_id: OPP });
  console.log(`   → name=${opp.name} active=${opp.active} learn_app=${opp.learn_app?.cc_app_id ?? '(none)'} learn_domain=${opp.learn_app?.cc_domain ?? '(none)'}`);

  console.log('3. listDeliverUnits');
  const dus = await backend.listDeliverUnits({ organization_slug: ORG, opportunity_id: OPP });
  console.log(`   → ${dus.deliver_units.length} deliver units:`, dus.deliver_units.slice(0, 3).map((d) => `${d.id}=${d.slug}`));

  console.log('4. listPaymentUnits');
  const pus = await backend.listPaymentUnits({ organization_slug: ORG, opportunity_id: OPP });
  console.log(`   → ${pus.payment_units.length} payment units:`, pus.payment_units.slice(0, 3).map((p) => `${p.id}=${p.name}@${p.amount}`));

  console.log('All read-only opp-config atoms green ✓');
} finally {
  await session.close();
}
