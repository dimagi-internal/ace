import { describe, it, expect, vi } from 'vitest';
import { CompositeBackend } from '../../../../mcp/connect/backends/composite.js';
import type { ConnectClient } from '../../../../mcp/connect/client.js';

const makeStub = (label: string): Partial<ConnectClient> => ({
  listPrograms: vi.fn(async () => ({
    programs: [{ id: 'aaa', name: label, description: '', delivery_type: 0, budget: 0, currency: '', country: '', start_date: '', end_date: '' }],
  })),
});

describe('CompositeBackend', () => {
  it('routes listPrograms to the playwright impl (Playwright-backed atom)', async () => {
    const rest = makeStub('rest') as ConnectClient;
    const playwright = makeStub('playwright') as ConnectClient;
    const c = new CompositeBackend({ rest, playwright });
    const out = await c.listPrograms({ organization_slug: 'x' });
    expect(out.programs[0].name).toBe('playwright');
    expect(rest.listPrograms).not.toHaveBeenCalled();
  });

  it('routes sendFlwInvite to the playwright impl', async () => {
    const sent: unknown[] = [];
    const playwright: Partial<ConnectClient> = {
      sendFlwInvite: vi.fn(async (a) => {
        sent.push(a);
        return { opportunity_id: a.opportunity_id, phone_numbers: a.phone_numbers, status: 'queued' as const };
      }),
    };
    const rest: Partial<ConnectClient> = {
      sendFlwInvite: vi.fn(),
    };
    const c = new CompositeBackend({ rest: rest as ConnectClient, playwright: playwright as ConnectClient });
    const out = await c.sendFlwInvite({
      organization_slug: 'ai-demo-space',
      opportunity_id: 'opp-uuid',
      phone_numbers: ['+74260000100'],
    });
    expect(out.status).toBe('queued');
    expect(sent).toEqual([
      { organization_slug: 'ai-demo-space', opportunity_id: 'opp-uuid', phone_numbers: ['+74260000100'] },
    ]);
    expect(rest.sendFlwInvite).not.toHaveBeenCalled();
  });
});
