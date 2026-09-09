import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SENDABLE_TRAINING_ARTIFACTS,
  normalizeArtifactKey,
  resolveSendScope,
  assertSendScopeRespected,
  describeSendScope,
} from '../../lib/training-send-scope';

const REPO = join(__dirname, '..', '..');

describe('training send scope', () => {
  it('is unscoped by default — omitting a scope sends everything', () => {
    const scope = resolveSendScope();
    expect(scope.explicit).toBe(false);
    expect(scope.keys).toEqual([...SENDABLE_TRAINING_ARTIFACTS]);
    expect(resolveSendScope(null)).toEqual(scope);
  });

  it('honours the operator\'s own words for a deck-only send', () => {
    // The literal request this was built for: "send only the training deck".
    for (const phrasing of ['training deck', 'deck', 'training-deck', 'training-deck.gdoc']) {
      const scope = resolveSendScope([phrasing]);
      expect(scope.explicit, phrasing).toBe(true);
      expect(scope.keys, phrasing).toEqual(['training-deck']);
    }
  });

  it('accepts the three spellings the repo already uses for the same docs', () => {
    // training-onboarding-email Step 2 says llo-manager-guide / flw-training-guide
    // / quick-reference; the artifact table says training-llo-guide.md etc. A
    // scope that took only one spelling would reject half the callers.
    expect(normalizeArtifactKey('llo-manager-guide')).toBe('training-llo-guide');
    expect(normalizeArtifactKey('flw-training-guide')).toBe('training-flw-guide');
    expect(normalizeArtifactKey('quick-reference')).toBe('training-quick-reference');
    expect(normalizeArtifactKey('training-quick-reference.md')).toBe('training-quick-reference');
    expect(normalizeArtifactKey('FAQ')).toBe('training-faq');
  });

  it('returns canonical order regardless of the order requested', () => {
    const scope = resolveSendScope(['faq', 'deck']);
    expect(scope.keys).toEqual(['training-deck', 'training-faq']);
  });

  it('deduplicates a repeated request', () => {
    expect(resolveSendScope(['deck', 'training-deck', 'deck']).keys).toEqual(['training-deck']);
  });

  it('throws on an unknown artifact rather than falling back to everything', () => {
    // The dangerous failure mode: a typo resolving to "send them all" would
    // put documents in front of an external organisation that the operator
    // explicitly excluded. Loud beats permissive here.
    expect(() => resolveSendScope(['training-dekc'])).toThrow(/cannot send/i);
    expect(() => resolveSendScope(['deck', 'the invoice'])).toThrow(/"the invoice"/);
  });

  it('throws on an empty scope, which is ambiguous', () => {
    expect(() => resolveSendScope([])).toThrow(/ambiguous/i);
  });

  it('catches an out-of-scope enclosure', () => {
    const scope = resolveSendScope(['deck']);
    expect(() =>
      assertSendScopeRespected(scope, ['training-deck', 'training-flw-guide']),
    ).toThrow(/outside its scope/i);
    // And passes when the send obeys.
    expect(() => assertSendScopeRespected(scope, ['training-deck'])).not.toThrow();
  });

  it('ignores non-training enclosures — it governs training artifacts only', () => {
    const scope = resolveSendScope(['deck']);
    // A widget URL or an opportunity link is not a training artifact and is not
    // this module's business.
    expect(() =>
      assertSendScopeRespected(scope, ['training-deck', 'https://connect.dimagi.com/opp/1']),
    ).not.toThrow();
  });

  it('describes itself for a phase summary', () => {
    expect(describeSendScope(resolveSendScope(['deck']))).toMatch(/scoped to 1 artifact/);
    expect(describeSendScope(resolveSendScope())).toMatch(/unscoped/);
  });

  it('does not include the onboarding email itself', () => {
    // It is the envelope, not the enclosure.
    expect(SENDABLE_TRAINING_ARTIFACTS).not.toContain('training-onboarding-email');
    expect(normalizeArtifactKey('training-onboarding-email')).toBeNull();
  });
});

describe('training send scope has callers (anti-orphan)', () => {
  // Same guard as test/templates/connect-wiki-map.test.ts. A scope module that
  // no skill consults is the "helper with no caller" shape: it reads as shipped
  // and changes nothing about what actually gets emailed (ace#1877, ace#2333).
  const CALLERS = [
    'skills/training-onboarding-email/SKILL.md',
    'skills/llo-onboarding/SKILL.md',
  ];

  for (const caller of CALLERS) {
    it(`${caller} references the send scope`, () => {
      const body = readFileSync(join(REPO, caller), 'utf8');
      expect(body, `${caller} must consult lib/training-send-scope.ts`).toContain(
        'training-send-scope',
      );
    });
  }

  it('training-onboarding-email no longer hard-requires all three sibling docs', () => {
    // The specific line this change had to remove: a self-check reading "All
    // three sibling docs are linked" makes obeying a narrower operator request
    // fail its own gate.
    const body = readFileSync(
      join(REPO, 'skills/training-onboarding-email/SKILL.md'),
      'utf8',
    );
    expect(body).not.toMatch(/All three sibling docs are linked/);
  });

  it('the producers stay unconditional — no producer consults the send scope', () => {
    // The load-bearing half. Generation is not scoped: an operator narrowing a
    // SEND must never stop an artifact being produced, because the next
    // opportunity needs the producer and internal readers need the artifact.
    const PRODUCERS = [
      'skills/training-deck-generate/SKILL.md',
      'skills/training-llo-guide/SKILL.md',
      'skills/training-flw-guide/SKILL.md',
      'skills/training-quick-reference/SKILL.md',
      'skills/training-faq/SKILL.md',
    ];
    const offenders = PRODUCERS.filter((p) =>
      readFileSync(join(REPO, p), 'utf8').includes('training-send-scope'),
    );
    expect(
      offenders,
      'A producer must not gate its own output on the send scope. Generation is\n' +
        'unconditional; only the outbound email is scoped.\n\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
