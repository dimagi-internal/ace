/**
 * Tests for lib/destructive-guards — code-level rails on destructive MCP atoms
 * (security audit 2026-07-31, F5). Encodes the "MUST exclude the golden
 * template" invariants that were previously only prose in the tool description.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertAceOwnedHqDomain,
  GUARD_ENV_KEYS,
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
  // The key that actually exists in .env.tpl. The original test injected
  // OCS_GOLDEN_TEMPLATE_COLLECTION_ID, which is declared nowhere — so it
  // passed while the guard could never fire in production (ace#1112).
  const env = { OCS_SHARED_COLLECTION_ID: '350' } as NodeJS.ProcessEnv;

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


describe('every guard env key is really declared (ace#1112)', () => {
  // The preventer. assertNotGoldenTemplateCollection shipped reading
  // OCS_GOLDEN_TEMPLATE_COLLECTION_ID, a variable declared in no .env.tpl and
  // set in no installed .env. It compared against undefined on every call, its
  // unit test injected the phantom key by hand, and the audit item read as
  // closed while the shared collection stayed deletable.
  const tpl = readFileSync(join(__dirname, '../../.env.tpl'), 'utf8');

  it.each([...GUARD_ENV_KEYS])('%s is declared in .env.tpl', (key) => {
    expect(new RegExp(`^${key}=`, 'm').test(tpl)).toBe(true);
  });

  it('the guard source reads no env key outside GUARD_ENV_KEYS', () => {
    const src = readFileSync(join(__dirname, '../../lib/destructive-guards.ts'), 'utf8');
    const read = new Set<string>();
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) read.add(m[1]);
    // The forward-compat alias is deliberately not required to exist.
    read.delete('OCS_GOLDEN_TEMPLATE_COLLECTION_ID');
    expect([...read].sort()).toEqual([...GUARD_ENV_KEYS].sort());
  });
});

describe('assertAceOwnedHqDomain (ace#1112)', () => {
  const env = { ACE_HQ_DOMAIN: 'connect-ace-prod' } as NodeJS.ProcessEnv;

  it('allows the ACE-owned domain', () => {
    expect(() => assertAceOwnedHqDomain('connect-ace-prod', undefined, env)).not.toThrow();
  });

  it('is case- and whitespace-insensitive', () => {
    expect(() => assertAceOwnedHqDomain('  Connect-ACE-Prod ', undefined, env)).not.toThrow();
  });

  it('refuses a foreign domain', () => {
    expect(() => assertAceOwnedHqDomain('some-partner-org', undefined, env))
      .toThrow(DestructiveGuardError);
    expect(() => assertAceOwnedHqDomain('some-partner-org', undefined, env))
      .toThrow(/ACE owns "connect-ace-prod"/);
  });

  it('accepts an override that names the exact domain', () => {
    expect(() => assertAceOwnedHqDomain('other-domain', 'other-domain', env)).not.toThrow();
  });

  it('rejects a generic override — the point is that it cannot be boilerplate', () => {
    for (const bogus of ['true', 'yes', '1', '*', 'connect-ace-prod']) {
      expect(() => assertAceOwnedHqDomain('other-domain', bogus, env))
        .toThrow(DestructiveGuardError);
    }
  });

  it('refuses everything when ACE_HQ_DOMAIN is unset rather than failing open', () => {
    expect(() => assertAceOwnedHqDomain('anything', undefined, {} as NodeJS.ProcessEnv))
      .toThrow(/ACE_HQ_DOMAIN is unset/);
  });

  it('an unset ACE_HQ_DOMAIN is not rescued by the override either', () => {
    expect(() => assertAceOwnedHqDomain('anything', 'anything', {} as NodeJS.ProcessEnv))
      .toThrow(/ACE_HQ_DOMAIN is unset/);
  });
});
