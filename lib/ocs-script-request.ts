/**
 * The RequestFn an OCS script hands to `PlaywrightBackend`: every call goes
 * through a logged-in Playwright context with the session's CSRF token.
 * Shared by `scripts/bootstrap-ocs-golden-template.ts` and
 * `scripts/ocs-coach-build.ts`.
 */
import type { BrowserContext } from 'playwright';
import type { RequestFn, RequestResult } from '../mcp/ocs/backends/pipeline-patch.js';

export function makeProductionRequest(context: BrowserContext, csrfToken: string, baseUrl: string): RequestFn {
  return async (method, url, body, options): Promise<RequestResult> => {
    const maxRedirects = options?.followRedirects === false ? 0 : undefined;
    const headers = { 'X-CSRFToken': csrfToken, Referer: baseUrl };

    if (method === 'GET') {
      const res = await context.request.get(url, { maxRedirects });
      return {
        ok: res.ok(), status: res.status(), headers: res.headers(),
        text: () => res.text(), json: () => res.json(),
      };
    }
    if (options?.multipart) {
      const form = new FormData();
      for (const [key, value] of Object.entries(options.multipart)) {
        if (typeof value === 'string') {
          form.append(key.startsWith('files_') ? 'files' : key, value);
        } else if (value && typeof value === 'object' && 'buffer' in value) {
          const f = value as { name: string; mimeType: string; buffer: Buffer };
          form.append(
            key.startsWith('files_') ? 'files' : key,
            new Blob([new Uint8Array(f.buffer)], { type: f.mimeType }),
            f.name,
          );
        }
      }
      const res = await context.request.post(url, { headers, multipart: form, maxRedirects });
      return {
        ok: res.ok(), status: res.status(), headers: res.headers(),
        text: () => res.text(), json: () => res.json(),
      };
    }
    if (options?.formEncoded) {
      const res = await context.request.post(url, {
        headers, form: body as Record<string, string>, maxRedirects,
      });
      return {
        ok: res.ok(), status: res.status(), headers: res.headers(),
        text: () => res.text(), json: () => res.json(),
      };
    }
    const res = await context.request.post(url, { headers, data: body, maxRedirects });
    return {
      ok: res.ok(), status: res.status(), headers: res.headers(),
      text: () => res.text(), json: () => res.json(),
    };
  };
}
