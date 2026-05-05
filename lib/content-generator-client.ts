//
// Wrapper around Dimagi's internal Content Generator API.
//
// LIVE CONTRACT: PARTIAL — the route path and auth header shape are
// inherited from CONTENT_GENERATOR_URL (treated as opaque) and the
// `auth` option (defaults to `Bearer`). Both may need adjustment when
// the CTO documents the live API. The signed-URL fallback path is
// already handled.

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
      timeoutMs?: number;       // default 60_000
      retryDelayMs?: number;    // default 1_000
    },
  ) {}

  async generateImage(input: {
    applicationContext: string;
    formText: string;
    imageDirectives?: string;
  }): Promise<Buffer> {
    const body = {
      application_context: input.applicationContext,
      form_text: input.formText,
      image_directives: input.imageDirectives ?? '',
    };

    const attempt = async (): Promise<Response> => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 60_000);
      try {
        return await fetch(this.opts.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(t);
      }
    };

    let res = await attempt();
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      await new Promise(r => setTimeout(r, this.opts.retryDelayMs ?? 1_000));
      res = await attempt();
    }

    if (res.status === 401 || res.status === 403) {
      throw new ContentGeneratorAuthError(res.status, await res.text());
    }
    if (res.status !== 200) {
      throw new Error(`Content Generator HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const ct = res.headers.get('content-type') ?? '';
    if (ct.startsWith('image/')) {
      return Buffer.from(await res.arrayBuffer());
    }
    if (ct.includes('json')) {
      // Live contract may return {url: signed} — fetch it inline.
      const j = await res.json();
      if (typeof j?.url === 'string') {
        const r2 = await fetch(j.url);
        if (r2.status !== 200) throw new Error(`signed URL fetch ${r2.status}`);
        return Buffer.from(await r2.arrayBuffer());
      }
      throw new Error(`Content Generator JSON response had no .url: ${JSON.stringify(j).slice(0, 200)}`);
    }
    throw new Error(`Content Generator unexpected content-type: ${ct}`);
  }
}
