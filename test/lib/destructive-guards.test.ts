/**
 * Tests for lib/destructive-guards — code-level rails on destructive MCP atoms
 * (security audit 2026-07-31, F5). Encodes the "MUST exclude the golden
 * template" invariants that were previously only prose in the tool description.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNotGoldenTemplateChatbot,
  assertNotGoldenTemplateCollection,
  assertDimagiOwnerRecipient,
  DestructiveGuardError,
} from '../../lib/destructive-guards.js';

describe('assertNotGoldenTemplateChatbot', () => {
  const env = { OCS_GOLDEN_TEMPLATE_ID: '42' } as NodeJS.ProcessEnv;

  it('throws when deleting the golden template chatbot', () => {
    expect(() => assertNotGoldenTemplateChatbot(42, env)).toThrow(DestructiveGuardError);
    expect(() => assertNotGoldenTemplateChatbot(42, env)).toThrow(/OCS_GOLDEN_TEMPLATE_ID/);
  });

  it('allows deleting any other chatbot', () => {
    expect(() => assertNotGoldenTemplateChatbot(43, env)).not.toThrow();
  });

  it('no-ops when the env var is unset (nothing to protect)', () => {
    expect(() => assertNotGoldenTemplateChatbot(42, {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() =>
      assertNotGoldenTemplateChatbot(42, { OCS_GOLDEN_TEMPLATE_ID: '' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe('assertNotGoldenTemplateCollection', () => {
  const env = { OCS_GOLDEN_TEMPLATE_COLLECTION_ID: '350' } as NodeJS.ProcessEnv;

  it('throws when deleting the golden template collection', () => {
    expect(() => assertNotGoldenTemplateCollection(350, env)).toThrow(DestructiveGuardError);
  });

  it('allows deleting a per-opp collection', () => {
    expect(() => assertNotGoldenTemplateCollection(999, env)).not.toThrow();
  });
});

describe('assertDimagiOwnerRecipient', () => {
  it.each([
    'someone@dimagi.com',
    'ace@dimagi-ai.com',
    'contractor@dimagi-associate.com',
    'MixedCase@Dimagi.com',
  ])('allows Dimagi-owned recipient %s', (email) => {
    expect(() => assertDimagiOwnerRecipient(email)).not.toThrow();
  });

  it.each([
    'attacker@evil.com',
    'someone@gmail.com',
    'spoof@dimagi.com.attacker.com',
    'nodomain',
    '',
  ])('rejects non-Dimagi recipient %s', (email) => {
    expect(() => assertDimagiOwnerRecipient(email)).toThrow(DestructiveGuardError);
  });
});
