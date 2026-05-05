/**
 * Live integration test for `commcare_upload_multimedia`.
 *
 * Run: CONNECT_INTEGRATION=1 \
 *      ACE_HQ_DOMAIN=connect-ace-prod \
 *      ACE_SMOKE_APP_ID=4e20ddf5beca42278c4d2c20383eb943 \
 *      npx vitest run test/mcp/connect/integration/commcare-upload-multimedia.test.ts
 *
 * Gated on CONNECT_INTEGRATION=1 — skipped by default. Hits live CCHQ via the
 * same Playwright session as `commcare_patch_xform`; requires .env with
 * CONNECT_BASE_URL and either ACE_HQ_USERNAME/PASSWORD or a fresh
 * ~/.ace/connect-session.json (run `/ace:connect-login` to refresh).
 *
 * NOTE — orphan pruning. This test only verifies the upload step (200 +
 * parseable response). It does NOT call `make_build`/`release_build`
 * because orphan multimedia (no form reference) is pruned by
 * CCHQ's `clean_paths()` — that's expected behavior, not a bug.
 * End-to-end "bytes land in CCZ" coverage lives in the skill-level smoke
 * test (Task 14), where the form-XML patch precedes the upload.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PlaywrightSession } from '../../../../mcp/connect/auth/playwright-session.js';
import { CommCareBackend } from '../../../../mcp/connect/backends/commcare.js';

const RUN = process.env.CONNECT_INTEGRATION === '1';

// 1×1 transparent PNG, base64-encoded — small enough to upload quickly.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const CCHQ_BASE_URL = process.env.CCHQ_BASE_URL ?? 'https://www.commcarehq.org';

describe.skipIf(!RUN)('commcare_upload_multimedia (integration)', () => {
  let session: PlaywrightSession;
  let backend: CommCareBackend;

  beforeAll(async () => {
    session = new PlaywrightSession({
      baseUrl: process.env.CONNECT_BASE_URL!,
      hqUsername: process.env.ACE_HQ_USERNAME,
      hqPassword: process.env.ACE_HQ_PASSWORD,
    });
    // Warm the session before constructing the backend (mirrors e2e setup).
    await session.getContext();
    backend = new CommCareBackend({ baseUrl: CCHQ_BASE_URL, session });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
  });

  it('uploads a tiny PNG and returns multimedia_id + file_hash_md5', async () => {
    const domain = process.env.ACE_HQ_DOMAIN!;
    const appId = process.env.ACE_SMOKE_APP_ID!;
    expect(domain).toBeTruthy();
    expect(appId).toBeTruthy();

    const filename = `probe-${Date.now()}.png`;
    const out = await backend.uploadMultimedia({
      domain,
      app_id: appId,
      media_path: `jr://file/commcare/image/${filename}`,
      file_bytes: TINY_PNG,
      content_type: 'image/png',
    });
    expect(out.multimedia_id).toMatch(/^[0-9a-f]{32}$/);
    expect(out.file_hash_md5).toMatch(/^[0-9a-f]{32}$/);
  }, 30_000);

  it('is idempotent — same bytes return the same multimedia_id', async () => {
    const domain = process.env.ACE_HQ_DOMAIN!;
    const appId = process.env.ACE_SMOKE_APP_ID!;
    const filename = `probe-idem-${Date.now()}.png`;
    const a = await backend.uploadMultimedia({
      domain,
      app_id: appId,
      media_path: `jr://file/commcare/image/${filename}`,
      file_bytes: TINY_PNG,
      content_type: 'image/png',
    });
    const b = await backend.uploadMultimedia({
      domain,
      app_id: appId,
      media_path: `jr://file/commcare/image/${filename}`,
      file_bytes: TINY_PNG,
      content_type: 'image/png',
    });
    expect(b.multimedia_id).toBe(a.multimedia_id);
    expect(b.file_hash_md5).toBe(a.file_hash_md5);
  }, 30_000);
});
