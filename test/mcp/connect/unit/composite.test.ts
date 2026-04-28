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
});
