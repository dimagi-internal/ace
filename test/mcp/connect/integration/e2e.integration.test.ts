/**
 * Live integration test for ace-connect Programs atoms.
 *
 * Run: CONNECT_INTEGRATION=1 npx vitest run test/mcp/connect/integration/e2e.integration.test.ts
 *
 * Gated on CONNECT_INTEGRATION=1 — skipped by default. Hits live Connect
 * (connect.dimagi.com); requires .env with CONNECT_BASE_URL and either
 * ACE_HQ_USERNAME/PASSWORD or a fresh ~/.ace/connect-session.json.
 *
 * Test data is namespaced by timestamp (`ACE-IT-<ts>`) so re-runs don't
 * collide. Created programs are left in place — clean up in the Connect UI
 * if the test org grows cluttered.
 *
 * As of 0.10.47 this exercises the real REST automation API
 * (`POST /api/programs/`) for create, then falls back to the HTML-driven
 * read atoms (Playwright backend) for verification.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PlaywrightSession } from '../../../../mcp/connect/auth/playwright-session.js';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { RestBackend } from '../../../../mcp/connect/backends/rest.js';

const skip = process.env.CONNECT_INTEGRATION !== '1';

describe.skipIf(skip)('connect e2e (live, ai-demo-space)', () => {
  let session: PlaywrightSession;
  let rest: RestBackend;
  let playwright: PlaywrightBackend;
  const stamp = Date.now();
  const ORG = 'ai-demo-space';
  const PROGRAM_NAME = `ACE-IT-${stamp}`;
  let programId: string;

  beforeAll(async () => {
    session = new PlaywrightSession({
      baseUrl: process.env.CONNECT_BASE_URL!,
      hqUsername: process.env.ACE_HQ_USERNAME,
      hqPassword: process.env.ACE_HQ_PASSWORD,
    });
    const ctx = await session.getContext();
    const csrfToken = session.getCsrfToken();
    rest = new RestBackend({
      baseUrl: process.env.CONNECT_BASE_URL!,
      csrfToken,
      request: ctx.request,
    });
    playwright = new PlaywrightBackend({
      baseUrl: process.env.CONNECT_BASE_URL!,
      csrfToken,
      request: ctx.request,
    });
  }, 60_000);

  afterAll(async () => { await session?.close(); });

  it('lists delivery types (>=10 entries, includes Nutrition)', async () => {
    const out = await playwright.listDeliveryTypes({ organization_slug: ORG });
    expect(out.delivery_types.length).toBeGreaterThanOrEqual(10);
    expect(out.delivery_types.find((d) => d.name === 'Nutrition')).toBeDefined();
  }, 30_000);

  it('createProgram (REST) returns a program with a UUID', async () => {
    const p = await rest.createProgram({
      organization_slug: ORG,
      name: PROGRAM_NAME,
      description: 'ace-connect integration test',
      delivery_type: 'nutrition',
      budget: 1000,
      currency: 'USD',
      country: 'United States of America',
      start_date: '2026-05-01',
      end_date: '2026-08-01',
    });
    expect(p.name).toBe(PROGRAM_NAME);
    expect(p.id).toMatch(/^[a-f0-9-]{36}$/);
    programId = p.id;
  }, 60_000);

  it('listPrograms with a name filter finds the new program', async () => {
    const out = await playwright.listPrograms({ organization_slug: ORG, name: PROGRAM_NAME });
    expect(out.programs).toHaveLength(1);
    expect(out.programs[0].id).toBe(programId);
  });

  it('getProgram hydrates all fields from the edit form', async () => {
    const p = await playwright.getProgram({ organization_slug: ORG, program_id: programId });
    expect(p.id).toBe(programId);
    expect(p.name).toBe(PROGRAM_NAME);
    expect(p.description).toBe('ace-connect integration test');
    expect(p.budget).toBe(1000);
    expect(p.currency).toBe('USD');
    expect(p.start_date).toBe('2026-05-01');
    expect(p.end_date).toBe('2026-08-01');
  });

  it('updateProgram renames the program', async () => {
    const renamed = `${PROGRAM_NAME}-renamed`;
    const p = await playwright.updateProgram({
      organization_slug: ORG,
      program_id: programId,
      name: renamed,
    });
    expect(p.name).toBe(renamed);
  }, 60_000);
});
