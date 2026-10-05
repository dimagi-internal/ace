/**
 * ace#2704: Nova's `upload_app_to_hq` refuses on an `unverified`
 * commcare-connect capability, and app-deploy used to read `unverified` as a
 * WARN. These tests pin the classifier that attributes the refusal, and the
 * skill text that routes the refusal to it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyConnectFlag, parseUserDomains } from '../../lib/hq-connect-flag-probe.js';

const REPO = join(__dirname, '..', '..');
const ok = (domains: string[]) => ({ ok: true as const, domains });

describe('parseUserDomains', () => {
  it('parses the live HQ shape (DoesNothingPaginator, no next)', () => {
    // Shape observed 2026-10-05 from /api/user_domains/v1/?feature_flag=commcare_connect
    const body = {
      meta: { total_count: 2 },
      objects: [
        { domain_name: 'connect-ace-prod', project_name: 'connect-ace-prod' },
        { domain_name: 'connect-interviews', project_name: null },
      ],
    };
    expect(parseUserDomains(body)).toEqual(['connect-ace-prod', 'connect-interviews']);
  });
  it('rejects a short page (Nova settles this to unverified)', () => {
    expect(parseUserDomains({ meta: { total_count: 3 }, objects: [{ domain_name: 'a' }] })).toBeNull();
  });
  it('rejects a non-object body', () => {
    expect(parseUserDomains('<html>login</html>')).toBeNull();
  });
});

describe('classifyConnectFlag', () => {
  // Observed 2026-10-05 ~20:30Z with ACE's key while Nova reported `unverified`.
  it('available when ACE sees the space in both lists — Nova stored-key path is the fault', () => {
    expect(
      classifyConnectFlag(
        'connect-ace-prod',
        ok(['ace-crispr-connect', 'connect-ace-prod', 'connect-ace-spark']),
        ok(['connect-ace-prod', 'auto-connect-master']),
      ),
    ).toBe('available');
  });
  it('missing when visible but not flagged', () => {
    expect(classifyConnectFlag('x', ok(['x']), ok([]))).toBe('missing');
  });
  it('domain-not-visible when the unfiltered list lacks the space', () => {
    expect(classifyConnectFlag('x', ok(['y']), ok([]))).toBe('domain-not-visible');
  });
  it('hq-unreachable when ACE own key fails either leg', () => {
    expect(classifyConnectFlag('x', { ok: false, status: 401 }, ok(['x']))).toBe('hq-unreachable');
    expect(classifyConnectFlag('x', ok(['x']), { ok: false, status: 'error' })).toBe('hq-unreachable');
  });
});

describe('app-deploy routes an unverified upload refusal (ace#2704)', () => {
  const skill = readFileSync(join(REPO, 'skills/app-deploy/SKILL.md'), 'utf8');
  it('handles project_space_incompatible in the upload step', () => {
    expect(skill).toMatch(/Handle `project_space_incompatible`/);
    expect(skill).toContain('scripts/probe-hq-connect-flag.ts');
  });
  it('no longer treats an unverified blocker as a plain WARN', () => {
    expect(skill).not.toMatch(/`blocked` with an `unverified` blocker, or any `unverified` advisory \| \*\*`\[WARN\]`/);
  });
});
