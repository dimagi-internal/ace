import { describe, it, expect, vi } from 'vitest';
import { CompositeBackend } from '../../../../mcp/connect/backends/composite.js';
import type { ConnectClient } from '../../../../mcp/connect/client.js';

const makeListProgramsStub = (label: string): Partial<ConnectClient> => ({
  listPrograms: vi.fn(async () => ({
    programs: [{
      id: 'aaa',
      name: label,
      description: '',
      delivery_type: 0,
      budget: 0,
      currency: '',
      country: '',
      start_date: '',
      end_date: '',
    }],
  })),
});

describe('CompositeBackend', () => {
  it('routes listPrograms to the playwright impl (Playwright-backed atom)', async () => {
    const rest = makeListProgramsStub('rest') as ConnectClient;
    const playwright = makeListProgramsStub('playwright') as ConnectClient;
    const c = new CompositeBackend({ rest, playwright });
    const out = await c.listPrograms({ organization_slug: 'x' });
    expect(out.programs[0].name).toBe('playwright');
    expect(rest.listPrograms).not.toHaveBeenCalled();
  });

  it('routes sendFlwInvite to the REST impl (PR #1135 automation API)', async () => {
    const sent: unknown[] = [];
    const rest: Partial<ConnectClient> = {
      sendFlwInvite: vi.fn(async (a) => {
        sent.push(a);
        return {
          opportunity_id: a.opportunity_id,
          phone_numbers: a.phone_numbers,
          invited_count: a.phone_numbers.length,
          status: 'queued' as const,
        };
      }),
    };
    const playwright: Partial<ConnectClient> = {
      sendFlwInvite: vi.fn(),
    };
    const c = new CompositeBackend({ rest: rest as ConnectClient, playwright: playwright as ConnectClient });
    const out = await c.sendFlwInvite({
      organization_slug: 'ai-demo-space',
      opportunity_id: 'opp-uuid',
      phone_numbers: ['+74260000100'],
    });
    expect(out.status).toBe('queued');
    expect(out.invited_count).toBe(1);
    expect(sent).toEqual([
      { organization_slug: 'ai-demo-space', opportunity_id: 'opp-uuid', phone_numbers: ['+74260000100'] },
    ]);
    expect(playwright.sendFlwInvite).not.toHaveBeenCalled();
  });

  it('routes createOpportunity to the REST impl', async () => {
    const sent: unknown[] = [];
    const rest: Partial<ConnectClient> = {
      createOpportunity: vi.fn(async (a) => {
        sent.push(a);
        return {
          id: 'opp-uuid',
          program_id: a.program_id,
          name: a.name,
          short_description: a.short_description,
          description: a.description,
          organization_slug: a.target_organization_slug,
          managed: true,
          active: false,
          start_date: a.start_date,
          end_date: a.end_date,
          total_budget: a.total_budget,
        };
      }),
    };
    const playwright: Partial<ConnectClient> = { createOpportunity: vi.fn() };
    const c = new CompositeBackend({ rest: rest as ConnectClient, playwright: playwright as ConnectClient });
    const out = await c.createOpportunity({
      organization_slug: 'pm-org',
      program_id: 'prog-uuid',
      name: 'Test Opp',
      short_description: 'short',
      description: 'desc',
      target_organization_slug: 'llo-org',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
      total_budget: 100000,
      learn_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'x', cc_domain: 'd', cc_app_id: 'la', description: 'L', passing_score: 80 },
      deliver_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'x', cc_domain: 'd', cc_app_id: 'da' },
    });
    expect(out.managed).toBe(true);
    expect(playwright.createOpportunity).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });
});
