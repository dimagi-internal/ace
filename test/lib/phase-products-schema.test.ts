import { describe, it, expect } from 'vitest';
import { validatePhaseProductsFragment } from '../../lib/phase-products-schema.js';

const DOC = {
  file_id: '1abcDEF',
  title: 'Onboarding email',
  web_view_link: 'https://docs.google.com/document/d/1abcDEF/edit',
};

describe('qa-and-training products.training.docs (jjackson/ace#748)', () => {
  it('accepts the five enumerated doc slots', () => {
    const res = validatePhaseProductsFragment('qa-and-training', {
      training: {
        deck: DOC,
        docs: {
          llo_guide: DOC,
          flw_guide: DOC,
          quick_reference: DOC,
          faq: DOC,
          onboarding_email: DOC,
        },
      },
    });
    expect(res.valid).toBe(true);
  });

  it('rejects an unknown doc key (deck_spec — the #705/#748 drift class), naming the path', () => {
    // training-deck-generate's SKILL.md used to instruct writing this slot;
    // nothing reads it and the summary page renders blank. The docs map is the
    // consumer-read enumeration, so unknown keys must fail loud at validateAs
    // rather than pass through silently.
    const res = validatePhaseProductsFragment('qa-and-training', {
      training: {
        docs: { deck_spec: DOC },
      },
    });
    expect(res.valid).toBe(false);
    expect(JSON.stringify(res.issues)).toContain('deck_spec');
  });
});
