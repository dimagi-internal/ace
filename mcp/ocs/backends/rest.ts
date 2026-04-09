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
    // NOTE: OCS's ExperimentSerializer returns `id` as the UUID public_id, not
    // the integer db id. See apps/api/views/experiments.py:36 (lookup_field = "public_id").
    const body = (await this.request('GET', `/api/experiments/?${qs}`)) as {
      results: Array<{ id: string; name: string; url?: string; version_number?: number }>;
      next: string | null;
    };
    return { chatbots: body.results, next_cursor: body.next ?? undefined };
  }

  async getChatbot(args: { public_id: string }) {
    // The `{id}` path param is the UUID public_id (see apps/api/views/experiments.py).
    return (await this.request('GET', `/api/experiments/${args.public_id}/`)) as {
      id: string;
      name: string;
      url?: string;
      version_number?: number;
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

  async listSessions(args: {
    experiment_id?: string;
    since?: string;
    tags?: string;
    versions?: string;
    cursor?: string;
    page_size?: number;
  }) {
    const qs = new URLSearchParams();
    if (args.experiment_id) qs.set('experiment', args.experiment_id);
    if (args.tags) qs.set('tags', args.tags);
    if (args.versions) qs.set('versions', args.versions);
    if (args.cursor) qs.set('cursor', args.cursor);
    qs.set('page_size', String(args.page_size ?? 50));
    const body = (await this.request('GET', `/api/sessions/?${qs}`)) as {
      results: Array<{ id: string; tags: string[]; created_at: string }>;
      next: string | null;
    };
    // NOTE: `since` is NOT forwarded to OCS because /api/sessions/ has no
    // documented date-filter param in the OpenAPI schema. We apply it
    // client-side after pagination. Spec verification item: confirm whether
    // OCS adds a `created_at__gte`-style filter and, if so, forward it here.
    let results = body.results;
    if (args.since) {
      const sinceMs = Date.parse(args.since);
      if (!Number.isNaN(sinceMs)) {
        results = results.filter((s) => Date.parse(s.created_at) >= sinceMs);
      }
    }
    return { sessions: results, next_cursor: body.next ?? undefined };
  }

  async getSession(args: { session_id: string }) {
    return (await this.request('GET', `/api/sessions/${args.session_id}/`)) as {
      id: string;
      tags: string[];
      created_at: string;
      messages: Array<{ id: string; created_at: string; message_type: 'human' | 'ai' | 'system'; content: string }>;
    };
  }

  async endSession(args: { session_id: string }) {
    await this.request('POST', `/api/sessions/${args.session_id}/end_experiment_session/`);
  }

  async addSessionTags(args: { session_id: string; tags: string[] }) {
    return (await this.request('POST', `/api/sessions/${args.session_id}/tags/`, { tags: args.tags })) as { tags: string[] };
  }

  async removeSessionTags(args: { session_id: string; tags: string[] }) {
    return (await this.request('DELETE', `/api/sessions/${args.session_id}/tags/`, { tags: args.tags })) as { tags: string[] };
  }

  async updateSessionState(args: { session_id: string; state: Record<string, unknown> }) {
    return (await this.request('PATCH', `/api/sessions/${args.session_id}/update_state/`, { state: args.state })) as { state: Record<string, unknown> };
  }

  async updateParticipantData(args: {
    identifier: string;
    platform: string;
    data: Array<Record<string, unknown>>;
  }) {
    await this.request('POST', '/api/participants', args);
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
