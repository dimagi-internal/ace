// Partner-facing artifacts must never hand the LLO the Phase 4 opportunity URL.
//
// Since the PM→NM org flow (ace#2419, CLAUDE.md § Phases) the Phase 4
// opportunity is ACE's own build/QA vehicle, held by ACE's NM org (or its PM
// org when no NM org is configured). The partner cannot open it. The
// partner's opportunity is created in Phase 9 by `llo-onboarding` and recorded
// at `phases.solicitation-management.products.selected_llo.opportunity_url`.
//
// `training-onboarding-email` told the producer to put the Phase 4 URL in the
// CTA, and its self-eval rewarded it (ace#3000, repro
// smallholder-seasonal/20261015-1402). `training-llo-guide` and the OCS
// contacts page had the same source. This pins the replacement: the partner's
// URL, or a verbatim labelled placeholder that llo-onboarding fills.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const PLACEHOLDER =
  "[PLACEHOLDER — your organisation's Connect opportunity link, sent when your opportunity is set up]";
const PARTNER_URL = 'selected_llo.opportunity_url';

// The template slots that used to instruct linking the Phase 4 opportunity.
const RETIRED_SLOTS = [
  '<opportunity URL from connect-setup/opportunity.md>',
  'the actual\n        opportunity URL, not "your Connect dashboard"',
];

describe('partner-facing artifacts do not link the Phase 4 opportunity (ace#3000)', () => {
  it('training-onboarding-email: template uses the partner URL or the labelled placeholder', () => {
    const s = read('skills/training-onboarding-email/SKILL.md');
    for (const slot of RETIRED_SLOTS) expect(s).not.toContain(slot);
    expect(s).toContain(PLACEHOLDER);
    expect(s).toContain(PARTNER_URL);
    // The CTA slot in the email template block points at the rule, not Phase 4.
    const start = s.indexOf('```markdown');
    const template = s.slice(start, s.indexOf('\n```\n', start + 1));
    expect(template).toContain('## Your one next step');
    expect(template).not.toMatch(/connect-setup|connect\.opportunity\.url/);
  });

  it('training-onboarding-email: self-eval rewards placeholder/partner URL and penalises ACE-org URLs', () => {
    const s = read('skills/training-onboarding-email/SKILL.md');
    const selfEval = s.slice(s.indexOf('7. **Self-evaluate'));
    expect(selfEval).toContain(PARTNER_URL);
    expect(selfEval).toMatch(/placeholder/);
    expect(selfEval).toMatch(/connect_orgs\.pm_org/);
    expect(selfEval).toMatch(/connect_orgs\.nm_org/);
  });

  it('training-onboarding-email-eval: CTA dimension caps ACE-org links', () => {
    const s = read('skills/training-onboarding-email-eval/SKILL.md');
    const cta = s.split('\n').find((l) => l.startsWith('| **Call-to-action effectiveness**'));
    expect(cta).toBeDefined();
    expect(cta).toContain(PLACEHOLDER);
    expect(cta).toContain(PARTNER_URL);
    expect(cta).toMatch(/connect_orgs\.pm_org/);
    expect(cta).toMatch(/connect_orgs\.nm_org/);
    expect(cta).toMatch(/caps this dimension at 3/);
  });

  it('training-llo-guide: "Where the data lives" no longer reads the Phase 4 URL', () => {
    const s = read('skills/training-llo-guide/SKILL.md');
    expect(s).not.toContain('Connect opportunity URL: <opportunity URL from connect-setup/opportunity.md>');
    expect(s).toContain(PLACEHOLDER);
  });

  it('ocs-agent-setup: contacts-page opportunity row sources the partner opportunity', () => {
    const s = read('skills/ocs-agent-setup/SKILL.md');
    const row = s.split('\n').find((l) => l.includes('| Connect opportunity (worker-facing surface) |'));
    expect(row).toBeDefined();
    expect(row).toContain('selected_llo.opportunity_url');
    expect(row).not.toMatch(/→ `phases\.connect-setup\.products\.connect\.opportunity\.url`/);
  });

  it('llo-onboarding: fills the placeholder with the opportunity it created', () => {
    const s = read('skills/llo-onboarding/SKILL.md');
    expect(s).toContain(PLACEHOLDER);
  });
});
