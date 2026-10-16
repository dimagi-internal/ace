/**
 * share-run-access must not repeat claims its target systems have retired (ace#2525).
 *
 * Found while designing external-partner access for spark-facilitator/20260926-1413,
 * and again on smallholder-seasonal/20261014-0859. The skill told operators:
 *
 *   - an ace-web invite to an outside domain is "a no-op". It is not: ace-web's
 *     `apps/auth/login_gate.py` `admission_rule` admits `open` → `domain` →
 *     `invite` → `membership`, so an invite admits them, and into the whole workspace;
 *   - the allowlist lives in `deploy/aws/task-definition.json`. That file is
 *     gone from ace-web main; the value sits in `deploy/aws/ace-web.cfn.yaml`
 *     and includes `dimagi-associate.com`;
 *   - labs dashboards need no grant. Phase 7 synthetic opps carry a Dimagi-only
 *     `allowed_domains`, so an external sign-in reaches no dashboard;
 *   - (command) deliverable docs are "already anyone-with-link". The skill's
 *     own 2026-08-14 correction says no producer shares a document.
 *
 * Each pinned phrase is a sentence that sent a reviewer the wrong way.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = fs.readFileSync(path.join(REPO_ROOT, 'skills/share-run-access/SKILL.md'), 'utf8');
const COMMAND = fs.readFileSync(path.join(REPO_ROOT, 'commands/share-run-access.md'), 'utf8');

describe('share-run-access claims (ace#2525)', () => {
  it('never cites the deleted ace-web task-definition.json', () => {
    expect(SKILL).not.toContain('task-definition.json');
    expect(COMMAND).not.toContain('task-definition.json');
  });

  it('never calls an ace-web invite a no-op', () => {
    expect(SKILL).not.toMatch(/no-op/);
    expect(COMMAND).not.toMatch(/no-op/);
  });

  it("names ace-web's four admission rules and the current domain list", () => {
    for (const rule of ['`open`', '`domain`', '`invite`', '`membership`']) expect(SKILL).toContain(rule);
    expect(SKILL).toContain('dimagi.com,dimagi-ai.com,dimagi-associate.com');
  });

  it('says labs synthetic dashboards are Dimagi-only, not "no separate grant" for everyone', () => {
    expect(SKILL).not.toContain('they reach the run\'s dashboards');
    expect(SKILL).toContain('synthetic opp is Dimagi-only');
  });

  it('states the blast radius of the HQ and Connect grants and the Connect SSO order', () => {
    expect(SKILL).toMatch(/role on the whole DOMAIN/);
    expect(SKILL).toMatch(/sees every ACE run's opportunities/);
    expect(SKILL).toMatch(/sign in to\s+Connect with "Log in with CommCare HQ" FIRST/);
  });

  it('the command no longer claims deliverable docs are already anyone-with-link', () => {
    expect(COMMAND).not.toMatch(/already\s+anyone-with-link/);
  });
});
