import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudBackend } from '../../../../mcp/mobile/backends/cloud.js';
import { MobileError, AvdBootError } from '../../../../mcp/mobile/errors.js';

const BASE = 'https://example.test/ace';
const TOKEN = 'pat-test-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope<T>(data: T): { data: T; error: null } {
  return { data, error: null };
}

function envErr(code: string, message: string) {
  return { data: null, error: { code, message } };
}

/**
 * Builder for the runRecipe async flow: returns mock fetch responses
 * for a single POST (returns 202 + job_id) followed by one GET (returns
 * the terminal job record with `result` or `error` already populated).
 * Tests that don't need the polling shape directly can use this so
 * they don't need to know about the 2-step protocol — they just
 * declare the eventual result envelope.
 */
function asyncRecipeMocks(result: Record<string, unknown>) {
  const jobId = 'test-job-' + Math.random().toString(16).slice(2, 10);
  return [
    jsonResponse(202, envelope({ job_id: jobId, status: 'running' })),
    jsonResponse(200, envelope({
      job_id: jobId,
      operation: 'run_recipe',
      status: 'completed',
      owner: 'test',
      started_at: '2026-05-12T00:00:00Z',
      completed_at: '2026-05-12T00:01:00Z',
      result,
    })),
  ];
}

function asyncRecipeFailureMocks(error: string, errorCode = 'job-failed') {
  const jobId = 'test-job-' + Math.random().toString(16).slice(2, 10);
  return [
    jsonResponse(202, envelope({ job_id: jobId, status: 'running' })),
    jsonResponse(200, envelope({
      job_id: jobId,
      operation: 'run_recipe',
      status: 'failed',
      owner: 'test',
      started_at: '2026-05-12T00:00:00Z',
      completed_at: '2026-05-12T00:01:00Z',
      error,
      error_code: errorCode,
    })),
  ];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('CloudBackend constructor', () => {
  it('throws when ACE_WEB_BASE_URL is not configured', () => {
    expect(() => new CloudBackend({ token: 't', baseUrl: '' })).toThrow(MobileError);
  });

  it('throws when token is not configured', () => {
    expect(() => new CloudBackend({ baseUrl: BASE, token: '' })).toThrow(MobileError);
  });

  it('strips a trailing slash from baseUrl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({ instance_id: 'i-1', state: 'running', public_dns: null, started_at: 't' })),
    );
    const cb = new CloudBackend({ baseUrl: `${BASE}/`, token: TOKEN, fetchImpl });
    await cb.ensureAvdRunning('cloud');
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/api/mobile/ensure-running`, expect.any(Object));
  });
});

describe('CloudBackend.ensureAvdRunning', () => {
  it('POSTs ensure-running with bearer auth and returns AvdInfo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({ instance_id: 'i-abc', state: 'running', public_dns: 'dns', started_at: 't' })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });

    const info = await cb.ensureAvdRunning('cloud');

    expect(info).toEqual({ name: 'cloud', serial: 'cloud:i-abc', status: 'booted' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/mobile/ensure-running`);
    expect((init.headers as Headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('passes state when avdName looks like a baked state name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({ instance_id: 'i-1', state: 'running', public_dns: null, started_at: 't' })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });

    await cb.ensureAvdRunning('cc-2.62.0');
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ state: 'cc-2.62.0' });
  });

  it('maps boot-timeout error code to AvdBootError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(504, envErr('boot-timeout', 'instance did not reach ok')),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await expect(cb.ensureAvdRunning('cloud')).rejects.toBeInstanceOf(AvdBootError);
  });

  it('maps generic envelope errors to MobileError with namespaced code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(503, envErr('singleton-busy', 'another caller holds the lock')),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const err = await cb.ensureAvdRunning('cloud').catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe('CLOUD_SINGLETON_BUSY');
  });

  it('surfaces emulator-not-ready diagnostics inline in the error message', async () => {
    // ace-web /api/mobile/ensure-running returns 503 emulator-not-ready
    // with a `diagnostics` block. cloud.ts must bake the snapshot into
    // the user-visible message (MCP only surfaces .message in the
    // tool_result, so callers can't see structured fields otherwise).
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(503, {
        data: null,
        error: {
          code: 'emulator-not-ready',
          message: 'emulator on i-abc signalled ready but no device is visible to adb',
          diagnostics: {
            adb_devices: [],
            adb_visible_count: 0,
            emulator_pid: null,
            runner_service_state: 'failed',
            marker_present: true,
            marker_age_seconds: 1200,
            runner_log_tail: '[ace-emulator-launch] ERROR: boot timed out',
            emulator_log_tail: 'emulator: PANIC: Could not find AVD',
          },
        },
      }),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const err = await cb.ensureAvdRunning('cloud').catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe('CLOUD_EMULATOR_NOT_READY');
    expect(err.message).toContain('no device is visible to adb');
    expect(err.message).toContain('In-VM diagnostics:');
    expect(err.message).toContain("adb devices: 0 in 'device' state");
    expect(err.message).toContain('emulator process: not running');
    expect(err.message).toContain('ace-mobile-runner.service: failed');
    expect(err.message).toContain('ready marker: present (age 1200s)');
    expect(err.message).toContain('ERROR: boot timed out');
    expect(err.message).toContain('PANIC: Could not find AVD');
    // The structured diagnostics are also attached for programmatic
    // consumers (skill-level retry logic that doesn't want to grep
    // the message).
    expect(err.diagnostics).toBeDefined();
    expect(err.diagnostics.adb_visible_count).toBe(0);
  });
});

describe('CloudBackend.listStates / listAvds', () => {
  it('returns the catalog from /api/mobile/states', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({
        default: 'cc-2.62.0',
        active: 'cc-2.62.0',
        states: [
          { name: 'cc-2.62.0', snapshot: 'cc-2.62.0-registered', commcare_version: '2.62.0' },
          { name: 'cc-2.63.0', snapshot: 'cc-2.63.0-registered', commcare_version: '2.63.0' },
        ],
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });

    const catalog = await cb.listStates();
    expect(catalog.states).toHaveLength(2);
    expect(catalog.default).toBe('cc-2.62.0');

    // listAvds projects to names — same call backing it.
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, envelope({
        default: 'cc-2.62.0',
        active: null,
        states: [{ name: 'cc-2.62.0', snapshot: 's', commcare_version: '2.62.0' }],
      })),
    );
    const names = await cb.listAvds();
    expect(names).toEqual(['cc-2.62.0']);
  });
});

describe('CloudBackend.installApk', () => {
  it('rejects local file paths with a typed MobileError', async () => {
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl: vi.fn() });
    await expect(cb.installApk('cloud', '/tmp/local.apk')).rejects.toThrow(MobileError);
  });

  it('POSTs install-apk with the URL and returns ApkInfo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({ package_name: 'org.commcare.dalvik', version: '2.62.0' })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });

    const info = await cb.installApk('cloud', 'https://s3/url.apk');
    expect(info.packageId).toBe('org.commcare.dalvik');
    expect(info.versionName).toBe('2.62.0');
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ apk_url: 'https://s3/url.apk' });
  });

  it('surfaces version_code from ace-web when present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({
        package_name: 'org.commcare.dalvik',
        version: '2.62.0',
        version_code: 462001,
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });

    const info = await cb.installApk('cloud', 'https://s3/url.apk');
    expect(info.versionCode).toBe(462001);
  });

  it('falls back to versionCode=0 against older ace-web that omits the field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({ package_name: 'org.x', version: '1.0' })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });

    const info = await cb.installApk('cloud', 'https://s3/url.apk');
    expect(info.versionCode).toBe(0);
  });
});

describe('CloudBackend.runRecipe', () => {
  it('POSTs recipe (async 202), polls job to completion, downloads artifacts', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-test-'));
    const recipePath = path.join(tmp, 'connect-login.yaml');
    await fs.writeFile(recipePath, 'appId: org.commcare.dalvik\n---\n- launchApp: org.commcare.dalvik\n');

    const screenshotDir = path.join(tmp, 'shots');
    const [submitResp, pollResp] = asyncRecipeMocks({
      exit_code: 0,
      stdout: 'ok',
      stderr: '',
      artifacts: [
        { name: '01.png', presigned_url: 'https://s3/01.png?sig=x', content_type: 'image/png' },
        { name: 'commands.json', presigned_url: 'https://s3/commands.json', content_type: 'application/json' },
      ],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submitResp)
      .mockResolvedValueOnce(pollResp)
      .mockResolvedValueOnce(new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"foo":1}', { status: 200 }));

    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const result = await cb.runRecipe(recipePath, { COUNTRY_CODE: '+7' }, screenshotDir);

    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.screenshots).toHaveLength(1);

    // Submit POST should have the recipe body.
    const submitCall = fetchImpl.mock.calls[0];
    expect(submitCall[0]).toBe(`${BASE}/api/mobile/run-recipe`);
    const body = JSON.parse(submitCall[1].body as string);
    expect(body.recipe_yaml).toContain('appId: org.commcare.dalvik');
    expect(body.env).toEqual({ COUNTRY_CODE: '+7' });
    expect(body.screenshot_prefix).toBe('connect-login');

    // The second call is the poll — GET to /api/mobile/jobs/<id>.
    const pollCall = fetchImpl.mock.calls[1];
    expect((pollCall[0] as string).startsWith(`${BASE}/api/mobile/jobs/`)).toBe(true);
    expect(pollCall[1].method).toBe('GET');

    const onDisk = (await fs.readdir(screenshotDir)).sort();
    expect(onDisk).toEqual(['01.png', 'commands.json']);

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns status=fail when the completed job result has non-zero exit_code', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-test-'));
    const recipePath = path.join(tmp, 'r.yaml');
    await fs.writeFile(recipePath, 'appId: x\n');

    // The recipe ran end-to-end on the server but returned exit_code=1
    // (Maestro reported a failed step). Job status is still 'completed'
    // — server-side execution succeeded; the recipe just didn't pass.
    const [submit, poll] = asyncRecipeMocks({
      exit_code: 1, stdout: '', stderr: 'failed at step 3', artifacts: [],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll)
      // Auto-diagnose on failure path: runRecipe calls diagnose after a
      // non-zero exit_code to attach the in-VM snapshot.
      .mockResolvedValueOnce(jsonResponse(200, envelope({
        ssm_ok: true, ssm_error: null,
        adb_devices: [], adb_visible_count: 0,
        emulator_pid: null, emulator_cmdline: null,
        runner_service_state: 'failed',
        marker_present: false, marker_age_seconds: null,
        runner_log_tail: '', emulator_log_tail: '',
      })));
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const result = await cb.runRecipe(recipePath, {}, tmp);
    expect(result.status).toBe('fail');
    expect(result.stderr).toBe('failed at step 3');

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('throws when the job completes with status=failed (server-side execution error)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-test-'));
    const recipePath = path.join(tmp, 'r.yaml');
    await fs.writeFile(recipePath, 'appId: x\n');

    const [submit, poll] = asyncRecipeFailureMocks(
      'SSM timed out after 1800s',
      'ssm-timeout',
    );
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll);
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const err = await cb.runRecipe(recipePath, {}, tmp).catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe('CLOUD_SSM_TIMEOUT');
    expect(err.message).toContain('1800s');

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("omits state from the request body when avdName is a generic placeholder", async () => {
    // Regression for the leep Phase 5 attempt-6 bug: MobileClient
    // dispatches with avdName='cloud' (its generic AVD-name default),
    // and the prior runRecipe routed `state: 'cloud'` into the request
    // body. ace-web's controller saw `state_name='cloud' != active='cc-2.62.0'`
    // and triggered a full emulator switch_state on every recipe call.
    // The fix: filter `opts.state` through `resolveState` so non-`cc-*`
    // names map to the (empty) defaultState — no state field sent.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-no-state-'));
    const recipePath = path.join(tmp, 'r.yaml');
    await fs.writeFile(recipePath, 'appId: x\n');

    const [submit, poll] = asyncRecipeMocks({
      exit_code: 0, stdout: '', stderr: '', artifacts: [],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll);
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    await cb.runRecipe(recipePath, {}, tmp, { state: 'cloud' });

    // The submit POST body must NOT include `state` — the server would
    // otherwise switch_state on every call.
    const submitCall = fetchImpl.mock.calls[0];
    const body = JSON.parse(submitCall[1].body as string);
    expect(body.state).toBeUndefined();

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("forwards state to the server when avdName is a real baked state ('cc-2.62.0')", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-state-'));
    const recipePath = path.join(tmp, 'r.yaml');
    await fs.writeFile(recipePath, 'appId: x\n');

    const [submit, poll] = asyncRecipeMocks({
      exit_code: 0, stdout: '', stderr: '', artifacts: [],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll);
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    await cb.runRecipe(recipePath, {}, tmp, { state: 'cc-2.62.0' });

    const submitCall = fetchImpl.mock.calls[0];
    const body = JSON.parse(submitCall[1].body as string);
    expect(body.state).toBe('cc-2.62.0');

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('polls multiple times while the job is still running', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-test-'));
    const recipePath = path.join(tmp, 'r.yaml');
    await fs.writeFile(recipePath, 'appId: x\n');

    const jobId = 'long-job';
    const fetchImpl = vi.fn()
      // POST → 202
      .mockResolvedValueOnce(jsonResponse(202, envelope({ job_id: jobId, status: 'running' })))
      // 3 running polls — each one is a separate GET
      .mockResolvedValueOnce(jsonResponse(200, envelope({
        job_id: jobId, operation: 'run_recipe', status: 'running',
        owner: 't', started_at: '2026-05-12T00:00:00Z',
      })))
      .mockResolvedValueOnce(jsonResponse(200, envelope({
        job_id: jobId, operation: 'run_recipe', status: 'running',
        owner: 't', started_at: '2026-05-12T00:00:00Z',
      })))
      .mockResolvedValueOnce(jsonResponse(200, envelope({
        job_id: jobId, operation: 'run_recipe', status: 'completed',
        owner: 't', started_at: '2026-05-12T00:00:00Z',
        completed_at: '2026-05-12T00:02:00Z',
        result: { exit_code: 0, stdout: '', stderr: '', artifacts: [] },
      })));
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const result = await cb.runRecipe(recipePath, {}, tmp);
    expect(result.status).toBe('pass');
    // 1 POST + 3 GETs to /jobs/<id>
    expect(fetchImpl.mock.calls).toHaveLength(4);

    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('CloudBackend.snapshots / capture', () => {
  it('saveSnapshot returns a SnapshotResult', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({ name: 'snap1', saved_at: '2026-05-10T00:00:00Z' })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await cb.saveSnapshot('cloud', 'snap1');
    expect(r.snapshotName).toBe('snap1');
    expect(r.saved).toBe(true);
  });

  it('captureUiDump returns xml + parsed elements from ace-web', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({
        xml: '<hierarchy><node text="hi" class="android.widget.TextView"/></hierarchy>',
        elements: [
          { id: 'com.x:id/g', text: 'hi', class: 'android.widget.TextView', bounds: '[0,0][1,1]' },
        ],
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await cb.captureUiDump('cloud');
    expect(r.xml).toContain('<hierarchy>');
    expect(r.elements).toHaveLength(1);
    expect(r.elements[0]).toEqual({
      id: 'com.x:id/g', text: 'hi', class: 'android.widget.TextView', bounds: '[0,0][1,1]',
    });
  });

  it('captureUiDump degrades to empty elements when ace-web omits the field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({ xml: '<hierarchy/>' })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await cb.captureUiDump('cloud');
    expect(r.xml).toBe('<hierarchy/>');
    expect(r.elements).toEqual([]);
  });
});

describe('CloudBackend.runRecipe steps surfacing', () => {
  it('lifts ace-web steps[] into RecipeRunResult.steps with normalized status', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-steps-'));
    const recipePath = path.join(tmp, 'r.yaml');
    await fs.writeFile(recipePath, 'appId: x\n');

    const [submit, poll] = asyncRecipeMocks({
      exit_code: 0, stdout: '', stderr: '', artifacts: [],
      steps: [
        { index: 0, name: 'launchApp: x', status: 'pass', duration_ms: 100 },
        { index: 1, name: 'tapOn: Next', status: 'fail', error: 'timeout', screenshot: '02.png' },
        { index: 2, name: 'oddCommand', status: 'WEIRD_NEW_STATE' },
      ],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll);
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const r = await cb.runRecipe(recipePath, {}, tmp);
    expect(r.steps).toBeDefined();
    expect(r.steps).toHaveLength(3);
    expect(r.steps![0]).toEqual({
      index: 0, name: 'launchApp: x', status: 'pass', screenshot: undefined, error: undefined, durationMs: 100,
    });
    expect(r.steps![1].status).toBe('fail');
    expect(r.steps![1].screenshot).toBe('02.png');
    expect(r.steps![1].error).toBe('timeout');
    // Unknown status from a future ace-web release coerces, not crashes.
    expect(r.steps![2].status).toBe('unknown');

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('leaves steps undefined when ace-web omits the field (older versions)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-no-steps-'));
    const recipePath = path.join(tmp, 'r.yaml');
    await fs.writeFile(recipePath, 'appId: x\n');

    const [submit, poll] = asyncRecipeMocks({
      exit_code: 0, stdout: '', stderr: '', artifacts: [],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll);
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const r = await cb.runRecipe(recipePath, {}, tmp);
    expect(r.steps).toBeUndefined();

    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('CloudBackend.stopAvd', () => {
  it('sends an empty body by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, envelope({})));
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await cb.stopAvd('cloud');
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('forwards force=true when opt is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, envelope({})));
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await cb.stopAvd('cloud', { force: true });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ force: true });
  });
});

describe('CloudBackend.uninstallApk', () => {
  it('throws CLOUD_UNSUPPORTED — not exposed by the API', async () => {
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl: vi.fn() });
    const err = await cb.uninstallApk('cloud', 'org.x').catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe('CLOUD_UNSUPPORTED');
  });
});

describe('CloudBackend.diagnose', () => {
  it('GETs /api/mobile/diagnose and returns the Diagnostics payload', async () => {
    const diagPayload = {
      ssm_ok: true,
      ssm_error: null,
      adb_devices: [{ serial: 'emulator-5554', state: 'device' }],
      adb_visible_count: 1,
      emulator_pid: 1234,
      emulator_cmdline: '/opt/android-sdk/emulator/emulator -avd ACE',
      runner_service_state: 'active',
      marker_present: true,
      marker_age_seconds: 42,
      runner_log_tail: '...',
      emulator_log_tail: '...',
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, envelope(diagPayload)));
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });

    const d = await cb.diagnose();

    expect(d.adb_visible_count).toBe(1);
    expect(d.runner_service_state).toBe('active');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/mobile/diagnose`);
    expect(init.method).toBe('GET');
  });

  it('returns ssm_ok=false when the EC2 instance is stopped', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({
        ssm_ok: false,
        ssm_error: "instance i-xyz is 'stopped'",
        adb_devices: [],
        emulator_pid: null,
        emulator_cmdline: null,
        runner_service_state: null,
        marker_present: false,
        marker_age_seconds: null,
        runner_log_tail: '',
        emulator_log_tail: '',
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const d = await cb.diagnose();
    expect(d.ssm_ok).toBe(false);
    expect(d.ssm_error).toContain("'stopped'");
  });
});

describe('CloudBackend.restartRunner', () => {
  it("POSTs /api/mobile/restart-runner with wait_for_ready=true by default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({
        ssm_ok: true, ssm_error: null,
        adb_devices: [{ serial: 'emulator-5554', state: 'device' }],
        adb_visible_count: 1,
        emulator_pid: 9999, emulator_cmdline: null,
        runner_service_state: 'active',
        marker_present: true, marker_age_seconds: 5,
        runner_log_tail: '', emulator_log_tail: '',
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const d = await cb.restartRunner();
    expect(d.marker_age_seconds).toBe(5);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/mobile/restart-runner`);
    expect(init.method).toBe('POST');
    // Default omits wait_for_ready field — server applies default true.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('forwards wait_for_ready=false when set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({
        ssm_ok: true, ssm_error: null,
        adb_devices: [], adb_visible_count: 0,
        emulator_pid: null, emulator_cmdline: null,
        runner_service_state: 'activating',
        marker_present: false, marker_age_seconds: null,
        runner_log_tail: '', emulator_log_tail: '',
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await cb.restartRunner({ waitForReady: false });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ wait_for_ready: false });
  });
});

describe('CloudBackend.patchLaunchScript', () => {
  it('POSTs script body + restart_runner=true by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({
        sha256: 'abc123', bytes_written: 9876,
        restarted_runner: true, restart_log: null,
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const r = await cb.patchLaunchScript({ scriptBody: '#!/bin/bash\necho hi\n' });
    expect(r.sha256).toBe('abc123');
    expect(r.restarted_runner).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/mobile/admin/patch-launch-script`);
    expect(JSON.parse(init.body as string)).toEqual({
      script_body: '#!/bin/bash\necho hi\n',
      restart_runner: true,
    });
  });

  it('forwards restart_runner=false when set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, envelope({
        sha256: 'def', bytes_written: 10,
        restarted_runner: false, restart_log: null,
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await cb.patchLaunchScript({ scriptBody: '#!/bin/bash\n', restartRunner: false });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string).restart_runner).toBe(false);
  });
});

describe('CloudBackend.runRecipe auto-diagnose on failure', () => {
  it('attaches a Diagnostics snapshot on non-zero exit so callers see in-VM state', async () => {
    const [submit, poll] = asyncRecipeMocks({
      exit_code: 1,
      stdout: '...',
      stderr: 'Maestro: no devices/emulators found',
      artifacts: [],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll)
      // diagnose response (auto-probed after the failure)
      .mockResolvedValueOnce(jsonResponse(200, envelope({
        ssm_ok: true, ssm_error: null,
        adb_devices: [], adb_visible_count: 0,
        emulator_pid: null, emulator_cmdline: null,
        runner_service_state: 'failed',
        marker_present: false, marker_age_seconds: null,
        runner_log_tail: 'startup failed', emulator_log_tail: 'Segfault',
      })));

    const recipePath = path.join(os.tmpdir(), `recipe-${Date.now()}.yaml`);
    await fs.writeFile(recipePath, '# minimal recipe\n');
    const screenshotDir = path.join(os.tmpdir(), `shots-${Date.now()}`);

    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const r = await cb.runRecipe(recipePath, {}, screenshotDir);

    expect(r.status).toBe('fail');
    expect(r.diagnostics).toBeDefined();
    expect((r.diagnostics as Record<string, unknown>).adb_visible_count).toBe(0);
    expect((r.diagnostics as Record<string, unknown>).runner_service_state).toBe('failed');
    // 3 calls: submit (POST), poll (GET), diagnose (GET).
    expect(fetchImpl.mock.calls.length).toBe(3);
    expect((fetchImpl.mock.calls[2] as [string, RequestInit])[0]).toBe(
      `${BASE}/api/mobile/diagnose`,
    );
  });

  it('does not call diagnose on pass — kept off the happy path', async () => {
    const [submit, poll] = asyncRecipeMocks({
      exit_code: 0, stdout: '', stderr: '', artifacts: [],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll);
    const recipePath = path.join(os.tmpdir(), `recipe-${Date.now()}.yaml`);
    await fs.writeFile(recipePath, '# minimal recipe\n');
    const screenshotDir = path.join(os.tmpdir(), `shots-${Date.now()}-pass`);

    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const r = await cb.runRecipe(recipePath, {}, screenshotDir);

    expect(r.status).toBe('pass');
    expect(r.diagnostics).toBeUndefined();
    // 2 calls: submit + poll. No diagnose.
    expect(fetchImpl.mock.calls.length).toBe(2);
  });

  it('swallows diagnose probe errors — does not mask the original recipe failure', async () => {
    const [submit, poll] = asyncRecipeMocks({
      exit_code: 1, stdout: '', stderr: '', artifacts: [],
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(submit)
      .mockResolvedValueOnce(poll)
      .mockRejectedValueOnce(new Error('SSM probe blew up'));

    const recipePath = path.join(os.tmpdir(), `recipe-${Date.now()}-swallow.yaml`);
    await fs.writeFile(recipePath, '# minimal recipe\n');
    const screenshotDir = path.join(os.tmpdir(), `shots-${Date.now()}-swallow`);

    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl, jobPollIntervalMs: 0 });
    const r = await cb.runRecipe(recipePath, {}, screenshotDir);

    expect(r.status).toBe('fail');
    expect(r.diagnostics).toBeUndefined();
  });
});
