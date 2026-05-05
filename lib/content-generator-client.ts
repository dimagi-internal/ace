//
// Wrapper around Dimagi's internal Content Generator API.
//
// LIVE CONTRACT (per OpenAPI v0.1.0, probed 2026-05-05 — see
// scripts/probe-content-generator.ts):
//   Service: "Dimagi Content Gen" v0.1.0
//   Endpoint: POST <CONTENT_GENERATOR_URL>/v1/form-image
//     - CONTENT_GENERATOR_URL is the gateway base only; this client
//       appends /v1/form-image so future endpoints (e.g. /v1/form-audio)
//       don't require an env-var rename.
//   Auth: x-api-key: <google-cloud-api-key> header.
//     - The OpenAPI spec has no securitySchemes (gateway handles auth);
//       the live API Gateway accepts the API key via either x-api-key
//       header or ?key= query string. Header is the confirmed-working
//       scheme; the client falls back to ?key= once if the header is
//       rejected with 401/403, for resilience against a future gateway
//       reconfiguration.
//   Request body (application/json, schema FormImageRequest):
//     - application_context: string (required)
//     - form_text:           string (required)
//     - image_directives:    string | null (optional)
//     - upscale:             boolean (default false)  ~10s low-res, ~30s upscaled
//   Response 200 (application/json, schema FormImageResponse):
//     - image:        string  base64-encoded PNG
//     - prompt_used:  string  Gemini-produced image prompt (recorded by callers)
//   Errors:
//     - 422 HTTPValidationError: { detail: [{ loc, msg, type, ... }] }
//     - 401/403: live API not in spec — surface via ContentGeneratorAuthError.
//

export class ContentGeneratorAuthError extends Error {
  constructor(public status: number, body: string) {
    super(`Content Generator auth failed (${status}): ${body.slice(0, 200)}`);
    this.name = 'ContentGeneratorAuthError';
  }
}

export class ContentGeneratorClient {
  constructor(
    private opts: {
      url: string;
      apiKey: string;
      timeoutMs?: number;       // default 180_000 (live wall-clock ~68s low-res; upscale runs longer)
      retryDelayMs?: number;    // default 1_000
    },
  ) {}

  async generateImage(input: {
    applicationContext: string;
    formText: string;
    imageDirectives?: string;
    upscale?: boolean;
  }): Promise<{ image: Buffer; promptUsed: string }> {
    const body = {
      application_context: input.applicationContext,
      form_text: input.formText,
      image_directives: input.imageDirectives ?? null,
      upscale: input.upscale ?? false,
    };

    const endpoint = this.opts.url.replace(/\/$/, '') + '/v1/form-image';

    const fetchWithTimeout = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 180_000);
      try {
        return await fetch(url, { ...init, signal: ac.signal });
      } finally {
        clearTimeout(t);
      }
    };

    // Auth scheme: x-api-key header is the confirmed-working scheme as of
    // 2026-05-05. Falls back to ?key= query string once on 401/403 so a
    // future gateway reconfiguration doesn't silently break the skill.
    const attemptHeader = async (): Promise<Response> =>
      fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.opts.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    const attemptQuery = async (): Promise<Response> =>
      fetchWithTimeout(`${endpoint}?key=${encodeURIComponent(this.opts.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    let res = await attemptHeader();
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      await new Promise(r => setTimeout(r, this.opts.retryDelayMs ?? 1_000));
      res = await attemptHeader();
    }

    // Auth fallback: header rejected → try query-string scheme once.
    if (res.status === 401 || res.status === 403) {
      const headerErrBody = await res.text();
      const fallback = await attemptQuery();
      if (fallback.status === 401 || fallback.status === 403) {
        const fallbackBody = await fallback.text();
        throw new ContentGeneratorAuthError(
          fallback.status,
          `header: ${headerErrBody.slice(0, 100)} | query: ${fallbackBody.slice(0, 100)}`,
        );
      }
      res = fallback;
    }

    if (res.status === 422) {
      const errText = await res.text();
      let msg = errText;
      try {
        const parsed = JSON.parse(errText);
        if (Array.isArray(parsed?.detail)) {
          msg = parsed.detail.map((d: any) => d?.msg ?? JSON.stringify(d)).join('; ');
        }
      } catch {
        // not JSON, fall through with raw text
      }
      throw new Error(`Content Generator validation error (422): ${msg.slice(0, 300)}`);
    }
    if (res.status !== 200) {
      throw new Error(`Content Generator HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) {
      throw new Error(`Content Generator unexpected content-type: ${ct}`);
    }
    const j = (await res.json()) as { image?: unknown; prompt_used?: unknown };
    if (typeof j?.image !== 'string' || typeof j?.prompt_used !== 'string') {
      throw new Error(
        `Content Generator JSON missing image/prompt_used: ${JSON.stringify(j).slice(0, 200)}`,
      );
    }
    return {
      image: Buffer.from(j.image, 'base64'),
      promptUsed: j.prompt_used,
    };
  }
}
