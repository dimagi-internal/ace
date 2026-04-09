import { fetch } from 'undici';
import { HttpError } from '../errors.js';

export interface RestBackendOptions {
  baseUrl: string;
  token: string;
  maxRetries?: number;        // default 3
  retryBackoffMs?: number;    // default 500
}

export class RestBackend {
  constructor(private opts: RestBackendOptions) {}

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const maxRetries = this.opts.maxRetries ?? 3;
    const backoffMs = this.opts.retryBackoffMs ?? 500;
    const isIdempotent = method === 'GET';
    let lastErr: HttpError | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = await fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.ok) {
        // Handle empty-body responses (e.g. trigger_bot, end_session) which return 200 with no content
        if (!text) return undefined;
        return JSON.parse(text);
      }

      lastErr = new HttpError(res.status, path, text);

      // Retry policy: only on 5xx or 429, and only for GET (idempotent)
      const shouldRetry = isIdempotent && (res.status >= 500 || res.status === 429);
      if (!shouldRetry || attempt === maxRetries - 1) {
        throw lastErr;
      }
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
    }
    throw lastErr ?? new Error('unreachable');
  }

  async verify(): Promise<void> {
    await this.request('GET', '/api/experiments/?page_size=1');
  }

  async listChatbots(args: { cursor?: string; page_size?: number } = {}) {
    const qs = new URLSearchParams();
    if (args.cursor) qs.set('cursor', args.cursor);
    qs.set('page_size', String(args.page_size ?? 50));
    const body = (await this.request('GET', `/api/experiments/?${qs}`)) as {
      results: Array<{ id: number; name: string; public_id: string }>;
      next: string | null;
    };
    return { chatbots: body.results, next_cursor: body.next ?? undefined };
  }

  async getChatbot(args: { experiment_id: number }) {
    return (await this.request('GET', `/api/experiments/${args.experiment_id}/`)) as {
      id: number;
      name: string;
      public_id: string;
    };
  }

  async sendTestMessage(args: {
    experiment_id: number;
    messages: Array<{ role: string; content: string }>;
  }) {
    const body = (await this.request('POST', `/api/openai/${args.experiment_id}/chat/completions`, {
      model: 'anything',
      messages: args.messages,
    })) as { choices: Array<{ message: { role: string; content: string } }> };
    return { response: body.choices[0].message as { role: 'assistant'; content: string } };
  }

  async triggerBotMessage(args: {
    experiment_id: string;
    identifier: string;
    platform: string;
    prompt_text: string;
    session_data?: Record<string, unknown>;
    participant_data?: Record<string, unknown>;
  }) {
    await this.request('POST', '/api/trigger_bot', args);
  }

  async downloadFile(args: { file_id: number }) {
    const res = await fetch(`${this.opts.baseUrl}/api/files/${args.file_id}/content`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) {
      throw new HttpError(res.status, `/api/files/${args.file_id}/content`, await res.text());
    }
    const content = Buffer.from(await res.arrayBuffer());
    const mime_type = res.headers.get('content-type') ?? 'application/octet-stream';
    const disp = res.headers.get('content-disposition') ?? '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `file-${args.file_id}`;
    return { content, filename, mime_type };
  }
}
