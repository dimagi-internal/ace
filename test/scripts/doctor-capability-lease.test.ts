// capability_lease doctor probe: one read-only GET, a remediation per failure,
// and it never acquires (it has no route that could).
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyCapabilityLease, classifyLongPoll, probeCapabilityLease } from '../../lib/capability-lease-probe.js';

const URL_ = 'https://canopy.test/api/agents/ace/capabilities';
const declared = (grant: unknown, live: unknown = []) => ({
  capabilities: [{ name: 'android-emulator', manifest: { name: 'android-emulator', limits: { max_concurrent: 4 }, params: { state: { enum: ['cc-2.62.0', 'cc-2.63.0'] } } }, grant, live_leases: live }],
});

describe('classifyCapabilityLease', () => {
  it('PASS when declared + granted, reporting live leases', () => {
    const v = classifyCapabilityLease({ url: URL_, status: 200, body: declared({ max_concurrent: 2 }, [{}, {}]), hasToken: true });
    expect(v).toMatchObject({ status: 'pass', declared: true, granted: true, liveLeases: 2 });
    expect(v.summary).toContain('2 live lease(s)');
  });

  it.each([
    ['no PAT', { hasToken: false }, /CANOPY_WEB_PAT/, /\/ace:setup --force-env/],
    ['unreachable', { networkError: 'ENOTFOUND', hasToken: true }, /cannot reach/, /CANOPY_WEB_API_URL/],
    ['401', { status: 401, hasToken: true }, /401/, /re-mint/],
    ['403', { status: 403, hasToken: true }, /403/, /member of ACE's canopy-web workspace/],
    ['404 (old canopy-web)', { status: 404, hasToken: true }, /predates the capability broker/, /apps\/capabilities/],
    ['not declared', { status: 200, body: { capabilities: [] }, hasToken: true }, /NOT declared/, /deploy\.sh/],
    ['declared, not granted', { status: 200, body: declared(null), hasToken: true }, /NOT granted/, /CapabilityGrant/],
    ['stack missing Outputs', { status: 200, body: { capabilities: [{ ...declared({}).capabilities[0], stack: 'canopy-cap-ace-android-emulator', stack_outputs: { Capability: 'android-emulator' } }] }, hasToken: true }, /lacks Outputs LaunchTemplateId/, /deploy\.sh/],
  ])('%s → WARN with a remediation', (_n, r, summary, fix) => {
    const v = classifyCapabilityLease({ url: URL_, ...(r as object) } as Parameters<typeof classifyCapabilityLease>[0]);
    expect(v.status).toBe('warn');
    expect(v.summary).toMatch(summary);
    expect(v.remediation).toMatch(fix);
  });
});

describe('classifyCapabilityLease — the state for the configured APK version', () => {
  it('WARN naming the bake when cc-<apk version> is not in the manifest enum', () => {
    const v = classifyCapabilityLease({ url: URL_, status: 200, body: declared({}), hasToken: true, apkVersion: '2.64.0' });
    expect(v).toMatchObject({ status: 'warn', wantedState: 'cc-2.64.0', stateBaked: false });
    expect(v.summary).toMatch(/does not bake cc-2\.64\.0/);
    expect(v.remediation).toMatch(/variables\.pkr\.hcl/);
    expect(v.remediation).toMatch(/bake\.sh/);
  });

  it('PASS naming the baked state, the complete stack Outputs and long-poll support', () => {
    const body = { capabilities: [{ ...declared({}).capabilities[0], stack: 's', stack_outputs: { LaunchTemplateId: 'l', ArtifactsBucketName: 'b', InstanceRoleArn: 'r', Capability: 'c' } }] };
    const v = classifyCapabilityLease({ url: URL_, status: 200, body, hasToken: true, apkVersion: '2.63.0', longPoll: true });
    expect(v).toMatchObject({ status: 'pass', stateBaked: true, longPoll: true });
    expect(v.summary).toMatch(/cc-2\.63\.0 baked/);
    expect(v.summary).toMatch(/stack Outputs complete/);
    expect(v.summary).toMatch(/long-poll yes/);
  });
});

describe('classifyLongPoll', () => {
  it('422 naming wait_s → supported; 404 → an older broker that ignores it; anything else → unknown', () => {
    expect(classifyLongPoll({ status: 422, body: { title: 'Request validation failed', extras: { errors: [{ loc: ['query', 'wait_s'] }] } } })).toBe(true);
    expect(classifyLongPoll({ status: 404, body: { title: "lease '0' not found" } })).toBe(false);
    expect(classifyLongPoll({ status: 500 })).toBeNull();
  });
});

describe('probeCapabilityLease', () => {
  it('makes only GETs (capabilities, then the long-poll check) and never a write', async () => {
    const env = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'clp-')), 'ace.env');
    fs.writeFileSync(env, 'CANOPY_WEB_PAT=ace-pat\n');
    const saved = { f: process.env.ACE_ENV_FILE, u: process.env.CANOPY_WEB_API_URL, a: process.env.ACE_CONNECT_APK_VERSION };
    process.env.ACE_ENV_FILE = env;
    process.env.CANOPY_WEB_API_URL = 'https://canopy.test';
    const calls: Array<{ url: string; method: string; auth: string | null }> = [];
    try {
      process.env.ACE_CONNECT_APK_VERSION = '2.63.0';
      const v = await probeCapabilityLease(async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
        if (String(input).includes('/leases/')) {
          return new Response(JSON.stringify({ title: 'Request validation failed', extras: { errors: [{ loc: ['query', 'wait_s'] }] } }), { status: 422 });
        }
        return new Response(JSON.stringify(declared({})), { status: 200 });
      });
      expect(v).toMatchObject({ status: 'pass', stateBaked: true, longPoll: true });
      expect(calls).toEqual([
        { url: URL_, method: 'GET', auth: 'Bearer ace-pat' },
        { url: 'https://canopy.test/api/capabilities/leases/00000000-0000-0000-0000-000000000000?wait_s=99', method: 'GET', auth: 'Bearer ace-pat' },
      ]);
    } finally {
      for (const [k, val] of [['ACE_ENV_FILE', saved.f], ['CANOPY_WEB_API_URL', saved.u], ['ACE_CONNECT_APK_VERSION', saved.a]] as const) {
        if (val === undefined) delete process.env[k];
        else process.env[k] = val;
      }
    }
  });
});

describe('bin/ace-doctor wires capability_lease through the line-probe pair', () => {
  it('runs scripts/doctor-capability-lease.ts via run_line_probe + emit_line_probe', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../bin/ace-doctor'), 'utf8');
    expect(src).toMatch(/run_line_probe scripts\/doctor-capability-lease\.ts/);
    expect(src).toMatch(/emit_line_probe capability_lease/);
  });
});
