// Sealed pool-slot secrets are opened by the canopy CLI; plaintext passes through.
import { describe, it, expect, vi } from 'vitest';
import { canopyOpener, openSlotData } from '../../lib/slot-data-open.js';
import { MobileError } from '../../mcp/mobile/errors.js';

const lease = (slot_data: unknown) => ({ lease_id: 'L1', capability: 'test-worker', slot: 'worker-1', slot_data });

describe('openSlotData', () => {
  it('passes the old plaintext shape (and null, and an empty sealed map) through without the CLI', () => {
    const opener = vi.fn();
    const d = { public: { phone: '+1' }, secret: { pin: '1234' } };
    expect(openSlotData(lease(d), 'worker-1', opener)).toEqual(d);
    expect(openSlotData(lease(null), 'worker-1', opener)).toBeNull();
    expect(openSlotData(lease({ public: { phone: '+1' }, sealed: {}, agent_id: 'a' }), 'worker-1', opener)).toEqual({
      public: { phone: '+1' },
      sealed: {},
      agent_id: 'a',
    });
    expect(opener).not.toHaveBeenCalled();
  });

  it('opens a sealed shape with the CLI and returns {public, secret}', () => {
    const opener = vi.fn((_input: string) => JSON.stringify({ public: { phone: '+1' }, secret: { pin: '1234' } }));
    const out = openSlotData(
      lease({ public: { phone: '+1' }, sealed: { pin: 'zks1:x' }, agent_id: 'a' }),
      'worker-1',
      opener,
    );
    expect(out).toEqual({ public: { phone: '+1' }, secret: { pin: '1234' } });
    expect(JSON.parse(opener.mock.calls[0][0])).toEqual({
      capability: 'test-worker',
      slot: 'worker-1',
      slot_data: { public: { phone: '+1' }, sealed: { pin: 'zks1:x' }, agent_id: 'a' },
    });
  });

  it('non-JSON from the CLI is TEST_WORKER_SEALED and never echoes the output', () => {
    try {
      openSlotData(lease({ sealed: { pin: 'zks1:x' }, agent_id: 'a' }), 'worker-1', () => 'PIN-9876 oops');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as MobileError).code).toBe('TEST_WORKER_SEALED');
      expect((e as Error).message).not.toContain('PIN-9876');
    }
  });

  it('a missing CLI is TEST_WORKER_SEALED with how to install it', () => {
    const open = canopyOpener('/nonexistent/canopy-bin');
    try {
      open('{}');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as MobileError).code).toBe('TEST_WORKER_SEALED');
      expect((e as MobileError).remediation).toContain('/canopy:setup');
    }
  });
});
