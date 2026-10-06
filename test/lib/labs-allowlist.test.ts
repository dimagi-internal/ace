/**
 * lib/labs-allowlist.ts — the clone's Labs step must WIDEN a synthetic opp's
 * allowlist, never replace it (ace#2713).
 *
 * `synthetic_set_allowed_domains` REPLACES the list. On 2026-10-05
 * (spark-facilitator/20261004-1706 → workspace `spark`) the clone sent only the
 * partner's domain, which dropped `@dimagi-ai.com`. That is ACE's own mailbox
 * domain, so ACE lost its own synthetic org: `benchmarks_publish` →
 * "is not accessible to your account", and `labs_context` stopped listing
 * programme 10097.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aceMailboxDomain,
  cloneLabsAllowlist,
  reconcileAfterSet,
  labsContextShowsOpportunity,
} from '../../lib/labs-allowlist.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('aceMailboxDomain', () => {
  it('derives ACE\'s own domain from config/agent.json email', () => {
    expect(aceMailboxDomain(REPO_ROOT)).toBe('@dimagi-ai.com');
  });
});

describe('cloneLabsAllowlist', () => {
  it('the observed case: target-only list must still carry ACE\'s own domain', () => {
    // What the clone sent on 2026-10-05 was exactly the target list.
    const out = cloneLabsAllowlist({
      target: ['@sparkmicrogrants.org'],
      aceDomain: '@dimagi-ai.com',
    });
    expect(out).toContain('@sparkmicrogrants.org');
    expect(out).toContain('@dimagi-ai.com');
    expect(out).not.toEqual(['@sparkmicrogrants.org']);
  });

  it('keeps every domain already on the list (Phase 7 creates with Dimagi + ACE)', () => {
    const out = cloneLabsAllowlist({
      current: ['@dimagi.com', '@dimagi-ai.com'],
      target: ['sparkmicrogrants.org'],
      aceDomain: '@dimagi-ai.com',
    });
    expect(out).toEqual(['@dimagi-ai.com', '@dimagi.com', '@sparkmicrogrants.org']);
  });

  it('normalises case and the leading @, and dedupes', () => {
    const out = cloneLabsAllowlist({
      current: ['@Dimagi-AI.com'],
      target: ['SparkMicroGrants.org', '@sparkmicrogrants.org'],
      aceDomain: 'dimagi-ai.com',
    });
    expect(out).toEqual(['@dimagi-ai.com', '@sparkmicrogrants.org']);
  });

  it('refuses an empty target — the clone step has nothing to widen to', () => {
    expect(() => cloneLabsAllowlist({ target: [], aceDomain: '@dimagi-ai.com' })).toThrow(/labs_allowed_domains/);
  });

  it('refuses to run without ACE\'s own domain', () => {
    expect(() => cloneLabsAllowlist({ target: ['@x.org'], aceDomain: '' })).toThrow(/ACE/);
  });
});

describe('reconcileAfterSet', () => {
  it('flags a domain the write dropped, and returns the union to resend', () => {
    const r = reconcileAfterSet({
      sent: ['@dimagi-ai.com', '@sparkmicrogrants.org'],
      previous: ['@dimagi.com', '@dimagi-ai.com'],
    });
    expect(r.dropped).toEqual(['@dimagi.com']);
    expect(r.resend).toEqual(['@dimagi-ai.com', '@dimagi.com', '@sparkmicrogrants.org']);
  });

  it('is clean when the write only added domains', () => {
    const r = reconcileAfterSet({
      sent: ['@dimagi-ai.com', '@dimagi.com', '@sparkmicrogrants.org'],
      previous: ['@dimagi.com', '@dimagi-ai.com'],
    });
    expect(r.dropped).toEqual([]);
    expect(r.resend).toBeNull();
  });

  it('the manual restore on 2026-10-05: previous was target-only, nothing to resend', () => {
    const r = reconcileAfterSet({
      sent: ['@sparkmicrogrants.org', '@dimagi-ai.com'],
      previous: ['@sparkmicrogrants.org'],
    });
    expect(r.resend).toBeNull();
  });
});

describe('labsContextShowsOpportunity', () => {
  const ctx = {
    organizations: [{
      slug: 'labs-synthetic-spark-facilitator-example-partners--ace-spark-facilitator-20261004-1706',
      programs: [{
        id: 10097,
        name: 'Spark Facilitator (illustrative: three example partners)',
        opportunities: [{ id: 10097, name: 'A' }, { id: 10098, name: 'B' }, { id: '10099', name: 'C' }],
      }],
    }],
  };

  it('finds an opp anywhere in the org → program → opportunity tree', () => {
    expect(labsContextShowsOpportunity(ctx, 10097)).toBe(true);
    expect(labsContextShowsOpportunity(ctx, 10099)).toBe(true);
  });

  it('a program id alone is not an opportunity sighting', () => {
    const programOnly = { organizations: [{ programs: [{ id: 10097, opportunities: [] }] }] };
    expect(labsContextShowsOpportunity(programOnly, 10097)).toBe(false);
  });

  it('the lock-out: an empty context means ACE lost the opp', () => {
    expect(labsContextShowsOpportunity({ organizations: [] }, 10097)).toBe(false);
  });
});
