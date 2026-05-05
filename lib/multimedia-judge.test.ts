import { describe, it, expect, vi } from 'vitest';
import { judgeField, type JudgeInput } from './multimedia-judge.js';

const fakeAnthropic = (responseText: string) => ({
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  },
});

const baseInput: JudgeInput = {
  appContext: 'African FLWs teaching mothers KMC for SVN newborns. Modestly dressed.',
  appType: 'learn',
  formName: 'KMC positioning',
  formPosition: 'module 1, form 0 (instructional)',
  field: {
    id: 'kmc_position_demo',
    kind: 'label',
    label: "Show the mother how to support the baby's head and neck while skin-to-skin.",
    hint: null,
    options: [],
  },
  surroundingFields: [],
};

describe('judgeField', () => {
  it('parses a valid yes-self-use response', async () => {
    const fake = fakeAnthropic(
      JSON.stringify({
        generate: true,
        use_case: 'flw_self_use',
        why: 'FLW uses this to demonstrate KMC positioning.',
        directive: 'Frontline worker assisting a mother holding a small newborn skin-to-skin.',
      }),
    );
    const out = await judgeField(baseInput, fake as any);
    expect(out.generate).toBe(true);
    expect(out.use_case).toBe('flw_self_use');
  });

  it('parses a valid no response', async () => {
    const fake = fakeAnthropic(JSON.stringify({ generate: false, why: 'numeric input', directive: null }));
    const out = await judgeField(baseInput, fake as any);
    expect(out.generate).toBe(false);
  });

  it('throws on schema-invalid LLM output', async () => {
    const fake = fakeAnthropic(JSON.stringify({ generate: 'maybe', why: 42 }));
    await expect(judgeField(baseInput, fake as any)).rejects.toThrow();
  });

  it('throws on non-JSON LLM output', async () => {
    const fake = fakeAnthropic('I am sorry, I cannot');
    await expect(judgeField(baseInput, fake as any)).rejects.toThrow();
  });

  it('places appContext in a cache_control:ephemeral block', async () => {
    const fake = fakeAnthropic(
      JSON.stringify({ generate: false, why: 'x', directive: null }),
    );
    await judgeField(baseInput, fake as any);
    const callArgs = fake.messages.create.mock.calls[0][0];
    const sysBlocks = Array.isArray(callArgs.system) ? callArgs.system : [];
    const ephemeral = sysBlocks.find((b: any) => b.cache_control?.type === 'ephemeral');
    expect(ephemeral).toBeDefined();
    expect(ephemeral.text).toContain(baseInput.appContext);
  });
});
