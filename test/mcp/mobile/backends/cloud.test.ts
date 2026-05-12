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
  it('reads recipe from disk, POSTs YAML body, downloads artifacts to screenshotDir', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-test-'));
    const recipePath = path.join(tmp, 'connect-login.yaml');
    await fs.writeFile(recipePath, 'appId: org.commcare.dalvik\n---\n- launchApp: org.commcare.dalvik\n');

    const screenshotDir = path.join(tmp, 'shots');
    const fetchImpl = vi.fn()
      // Recipe POST
      .mockResolvedValueOnce(jsonResponse(200, envelope({
        exit_code: 0,
        stdout: 'ok',
        stderr: '',
        artifacts: [
          { name: '01.png', presigned_url: 'https://s3/01.png?sig=x', content_type: 'image/png' },
          { name: 'commands.json', presigned_url: 'https://s3/commands.json', content_type: 'application/json' },
        ],
      })))
      // Artifact downloads
      .mockResolvedValueOnce(new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"foo":1}', { status: 200 }));

    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const result = await cb.runRecipe(recipePath, { COUNTRY_CODE: '+7' }, screenshotDir);

    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.screenshots).toHaveLength(1); // only the .png
    expect(result.screenshots[0].path).toBe(path.join(screenshotDir, '01.png'));

    // Verify body shape on the recipe POST.
    const recipeCall = fetchImpl.mock.calls[0];
    const body = JSON.parse(recipeCall[1].body as string);
    expect(body.recipe_yaml).toContain('appId: org.commcare.dalvik');
    expect(body.env).toEqual({ COUNTRY_CODE: '+7' });
    expect(body.screenshot_prefix).toBe('connect-login');

    // Both files materialize on disk.
    const onDisk = (await fs.readdir(screenshotDir)).sort();
    expect(onDisk).toEqual(['01.png', 'commands.json']);

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns status=fail when ace-web reports non-zero exit_code', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-test-'));
    const recipePath = path.join(tmp, 'r.yaml');
    await fs.writeFile(recipePath, 'appId: x\n');

    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, envelope({
        exit_code: 1, stdout: '', stderr: 'failed at step 3', artifacts: [],
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const result = await cb.runRecipe(recipePath, {}, tmp);
    expect(result.status).toBe('fail');
    expect(result.stderr).toBe('failed at step 3');

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

    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, envelope({
        exit_code: 0, stdout: '', stderr: '', artifacts: [],
        steps: [
          { index: 0, name: 'launchApp: x', status: 'pass', duration_ms: 100 },
          { index: 1, name: 'tapOn: Next', status: 'fail', error: 'timeout', screenshot: '02.png' },
          { index: 2, name: 'oddCommand', status: 'WEIRD_NEW_STATE' },
        ],
      })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
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

    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, envelope({ exit_code: 0, stdout: '', stderr: '', artifacts: [] })),
    );
    const cb = new CloudBackend({ baseUrl: BASE, token: TOKEN, fetchImpl });
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
