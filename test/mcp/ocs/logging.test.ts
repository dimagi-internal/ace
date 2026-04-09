import { describe, it, expect } from 'vitest';
import { createLoggingProxy, type LogEntry } from '../../../mcp/ocs/logging.js';

describe('createLoggingProxy', () => {
  it('logs successful calls with atom name, args, duration, and result', async () => {
    const logged: LogEntry[] = [];
    const target = {
      cloneChatbot: async (args: { template_id: number }) => ({ experiment_id: 1, template_id: args.template_id }),
    };
    const proxied = createLoggingProxy(target, (entry) => logged.push(entry));

    const out = await proxied.cloneChatbot({ template_id: 5 });
    expect(out.experiment_id).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0].atom).toBe('cloneChatbot');
    expect(logged[0].result).toBe('ok');
    expect(typeof logged[0].duration_ms).toBe('number');
    expect(logged[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('logs errors with error class and message', async () => {
    const logged: LogEntry[] = [];
    const target = {
      failingAtom: async () => {
        throw new Error('boom');
      },
    };
    const proxied = createLoggingProxy(target, (entry) => logged.push(entry));

    await expect(proxied.failingAtom()).rejects.toThrow('boom');
    expect(logged).toHaveLength(1);
    expect(logged[0].result).toBe('error');
    expect(logged[0].error_class).toBe('Error');
    expect(logged[0].error_message).toBe('boom');
  });

  it('leaves non-function properties untouched', () => {
    const target = { version: '1.0.0' };
    const proxied = createLoggingProxy(target, () => {});
    expect(proxied.version).toBe('1.0.0');
  });
});
