/**
 * `/ace:release` only shares.
 *
 * Owner decision (Jonathan, 2026-10-03): "when validate release readiness
 * passes it means executing release doesn't change anything other than
 * sharing externally." The defect it closes is ace#2620: the old release-run
 * ran an open-ended "polish" of partner docs and a `--forward-source` that
 * could redirect another workspace's public page, all before the operator saw
 * the grant table. Every check and content change belongs to
 * `skills/validate-release-readiness`; `skills/release-run` executes the
 * plan's share actions and records the release — nothing else.
 *
 * This is the ratchet: the release procedure (skill + command) may name no MCP
 * atom outside the share / read-back / record allowlist, may dispatch no skill,
 * may call no script subcommand that assesses or writes, may POST to no
 * ace-web endpoint other than the release record and the workspace invite, and
 * may write run_state only under `released`. Adding a write to the release
 * means changing this list — which is the conversation to have, not a quiet
 * edit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReleasePlan, parseReviewers, type ReleaseAction } from '../../lib/release-plan';

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SKILL = read('skills/release-run/SKILL.md');
const CMD = read('commands/release.md');
const BOTH = `${SKILL}\n${CMD}`;

/** Every atom ACE registers (docs/atom-schemas.md is generated from the servers). */
const ALL_ATOMS = [...read('docs/atom-schemas.md').matchAll(/^### `([a-z0-9_]+)`/gm)].map((m) => m[1]);

/** The only atoms a release may touch: reads, the four grants, revocation, and the `released:` record. */
const RELEASE_ATOMS = new Set([
  'resolve_opp_path', // read
  'drive_read_file', // read the verdict + run_state
  'commcare_invite_web_user', // share: HQ
  'commcare_list_users', // read-back
  'connect_add_org_member', // share: Connect (its own read-back)
  'connect_remove_org_member', // --revoke-shared only
  'drive_set_anyone_with_link', // share: Drive
  'update_yaml_file', // the `released:` record ONLY (asserted below)
]);

describe('release-run executes the plan and nothing else', () => {
  it('names no MCP atom outside the share/read-back/record allowlist', () => {
    expect(ALL_ATOMS.length).toBeGreaterThan(100); // the catalogue really loaded
    const named = ALL_ATOMS.filter((a) => new RegExp(`\\b${a}\\b`).test(BOTH));
    expect(named.filter((a) => !RELEASE_ATOMS.has(a))).toEqual([]);
  });

  it("the command's allowed-tools grant nothing more", () => {
    const tools = (/^allowed-tools:\s*\[(.*)\]$/m.exec(CMD)?.[1] ?? '').split(',').map((s) => s.trim());
    const mcp = tools.filter((t) => t.startsWith('mcp__')).map((t) => t.split('__').pop()!);
    expect(mcp.filter((a) => !RELEASE_ATOMS.has(a))).toEqual([]);
    const other = tools.filter((t) => !t.startsWith('mcp__'));
    expect(other.sort()).toEqual(['AskUserQuestion', 'Bash', 'Read']); // no Skill, no Agent, no Edit/Write
  });

  it('dispatches no skill and runs no audit or gate re-run', () => {
    expect(SKILL).not.toMatch(/\bSkill\(/);
    expect(SKILL).not.toMatch(/Agent\(/);
    for (const s of ['audit-run-surface.ts', 'output-preview-capture', 'clone-asset-refs', 'grant-review-access']) expect(BOTH).not.toContain(s);
  });

  it('calls only the read / gate / plan subcommands of the release script', () => {
    const subs = [...SKILL.matchAll(/\$RC ([a-z-]+)/g)].map((m) => m[1]);
    expect(subs.length).toBeGreaterThan(0);
    expect([...new Set(subs)].filter((s) => !['inventory', 'gate', 'plan-show', 'plan-actions', 'email-body', 'thread-recipients'].includes(s))).toEqual([]);
  });

  it('POSTs only the release record and the workspace invite', () => {
    const posts = [...SKILL.matchAll(/(?:POST|curl[^\n]*-X POST)[^\n]*?(\/api\/[^\s"`]+)/g)].map((m) => m[1]);
    const curlTargets = [...SKILL.matchAll(/"\$\{ACE_WEB_BASE_URL%\/\}(\/api\/[^"]+)"/g)].map((m) => m[1]);
    for (const p of [...posts, ...curlTargets]) expect(p, p).toMatch(/\/runs\/<run-id>\/release$|\/members\/invite$/);
  });

  it('writes run_state only under `released`', () => {
    const lines = SKILL.split('\n').filter((l) => /update_yaml_file/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    // each mention sits in a paragraph about the `released` record
    const paras = SKILL.split(/\n\s*\n/).filter((p) => /update_yaml_file/.test(p));
    for (const p of paras) expect(p, p).toMatch(/`?released[:.]/);
    expect(SKILL).toMatch(/No other key is written/);
  });

  it('every action kind a plan can contain has a row in the execution table', () => {
    const { plan } = buildReleasePlan({
      workspace: 'spark', opp: 'o', runId: 'r', reviewers: parseReviewers('a@spark.org'),
      runState: { clone: { from: { workspace: 'dimagi-team', opp: 'o', run: 'r0' }, hq: { status: 'done' }, connect: { status: 'done' } } },
      tenancy: { hq_domain: 'd', connect_holding_org: 'org' },
      driveDocs: [{ file_id: 'FILEFILEFILE', url: 'https://docs.google.com/document/d/FILEFILEFILE/edit', anyone_role: null }],
      options: { forward_source: true, allow_cross_workspace_forward: true, allow_shared_connect: false },
      aceWebBase: 'https://labs.connect.dimagi.com/ace',
    });
    const kinds = new Set<ReleaseAction['kind']>(plan.actions.map((a) => a.kind));
    expect([...kinds].sort()).toEqual(['ace_web_invite', 'connect_org_member', 'drive_share', 'email', 'forward_source', 'hq_invite']);
    for (const k of kinds) expect(SKILL, k).toContain(`| \`${k}\` |`);
  });

  it('the validation skill, not the release, owns checks and repairs', () => {
    const v = read('skills/validate-release-readiness/SKILL.md');
    expect(v).toMatch(/run-surface-audit/);
    expect(v).toMatch(/commcare_get_subscription/);
    expect(v).toMatch(/Repair/);
    // and the validation shares nothing
    for (const a of ['commcare_invite_web_user', 'connect_add_org_member', 'drive_share_with_person', 'bin/ace-email']) {
      expect(read('commands/validate-release-readiness.md')).not.toContain(a);
    }
    expect(read('commands/validate-release-readiness.md')).not.toMatch(/drive_set_anyone_with_link/);
  });
});
