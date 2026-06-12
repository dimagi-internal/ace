import { fetch } from 'undici';
import { HttpError, StaleOcsSubprocessError } from '../errors.js';
import { isTransientNetworkError } from '../../../lib/transient-retry.js';

/**
 * Extract the integer experiment_id from a chatbot's web URL.
 *
 * Historical note: 0.6.1 introduced this helper expecting OCS's REST
 * `/api/experiments/` to return a human-facing `/a/<team>/chatbots/<int>/`
 * URL in the `url` field. The 2026-04-28 dogfood validation run found the
 * live API actually returns the API URL `/api/experiments/<uuid>/`, so this
 * regex returns `null` in production. Kept as a defensive parser in case
 * OCS ever returns the human URL — composite enrichment via the chatbots
 * table HTMX endpoint is the canonical experiment_id source as of 0.6.6.
 */
export function extractExperimentId(url: string | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/a\/[^/]+\/chatbots\/(\d+)\//);
  return m ? Number(m[1]) : null;
}

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
      // `fetch` here is the undici export, not the global. Type the
      // local with `Awaited<ReturnType<typeof fetch>>` so we pick up
      // undici's Response shape (not the global Response, which is
      // structurally similar but tagged differently by TS 5+).
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${this.opts.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e: any) {
        // Network-layer failure (ECONNRESET, ECONNREFUSED, socket hang
        // up, fetch failed, etc.) — fetch threw before returning a
        // response. Pre-PR-O these surfaced immediately; now retry on
        // idempotent calls with the same backoff schedule as 5xx/429.
        if (
          isIdempotent &&
          isTransientNetworkError(e) &&
          attempt < maxRetries - 1
        ) {
          await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
          continue;
        }
        throw e;
      }
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
    // The integer `experiment_id` is needed by every authoring atom
    // (set_chatbot_system_prompt, attach_knowledge, publish_chatbot_version,
    // etc.) and is recoverable from the human-facing `url` field, which has
    // the form `/a/<team>/chatbots/<experiment_id>/`. Surfacing it here
    // closes the idempotency gap: a skill that lists bots by name can then
    // reconfigure an existing bot directly, instead of cloning a duplicate
    // because the int id was unreachable.
    const body = (await this.request('GET', `/api/experiments/?${qs}`)) as {
      results: Array<{ id: string; name: string; url?: string; version_number?: number }>;
      next: string | null;
    };
    const chatbots = body.results.map((r) => ({
      ...r,
      experiment_id: extractExperimentId(r.url),
    }));
    return { chatbots, next_cursor: body.next ?? undefined };
  }

  async getChatbot(args: { public_id: string }) {
    // The `{id}` path param is the UUID public_id (see apps/api/views/experiments.py).
    // See listChatbots for why we surface the integer experiment_id alongside.
    const raw = (await this.request('GET', `/api/experiments/${args.public_id}/`)) as {
      id: string;
      name: string;
      url?: string;
      version_number?: number;
    };
    return { ...raw, experiment_id: extractExperimentId(raw.url) };
  }

  async sendTestMessage(args: {
    public_id: string;
    embed_key: string;
    message: string;
  }) {
    // Use the anonymous widget chat API (POST /api/chat/start/ → send → poll).
    // The old OpenAI-compatible endpoint (/api/openai/{id}/chat/completions)
    // returns 404 on connect-ace. The widget API works reliably and doesn't
    // require a REST API token — only the embed_key.
    const chatHeaders = {
      'Content-Type': 'application/json',
      'X-Embed-Key': args.embed_key,
      Referer: this.opts.baseUrl,
    };

    // 1. Start anonymous session. As of OCS #3552 (deployed 2026-06-09) the
    //    chat session API requires a per-session token: POST /api/chat/start/
    //    issues a signed `session_token` that the message/poll/end session
    //    endpoints enforce as the `X-Session-Token` header. A direct API
    //    consumer that sends NO `x-ocs-widget-version` header is treated as
    //    token-enforced (it is NOT opted out — see chat.py
    //    `_issue_or_opt_out_session_token`), so we must capture the issued token
    //    and thread it on every subsequent session call. Without it /message/
    //    and /poll/ reject with 403 `session_token_required`, which the bot
    //    surfaced as the generic "something went wrong" fallback and was
    //    misread as an LLM outage (jjackson/ace#742). We pass
    //    `use_session_token: true` to make token issuance explicit rather than
    //    relying on the header-absence default.
    const startRes = await fetch(`${this.opts.baseUrl}/api/chat/start/`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ chatbot_id: args.public_id, use_session_token: true }),
    });
    if (!startRes.ok) {
      throw new HttpError(startRes.status, '/api/chat/start/', await startRes.text());
    }
    const { session_id, session_token } = (await startRes.json()) as {
      session_id: string;
      session_token?: string | null;
    };

    // Session-scoped headers: thread the per-session token on every subsequent
    // session endpoint. When OCS opted the session out (token null — e.g. a
    // pre-token session backfilled to `session_token_required = false`), we omit
    // the header and the legacy tokenless path still works.
    const sessionHeaders = session_token
      ? { ...chatHeaders, 'X-Session-Token': session_token }
      : chatHeaders;

    // 2. Send message
    const sendRes = await fetch(`${this.opts.baseUrl}/api/chat/${session_id}/message/`, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ message: args.message }),
    });
    if (!sendRes.ok) {
      const sendBody = await sendRes.text();
      // Self-diagnosis (jjackson/ace#761): a 403 session_token_required AFTER
      // /start/ issued a token that we threaded as X-Session-Token is the
      // stale-subprocess signature — the fixed code (c91f5b7) can't produce it.
      // Throw the typed error so the operator gets "restart Claude Code", not a
      // generic 403 misread as an auth/session failure.
      if (sendRes.status === 403 && session_token && sendBody.includes('session_token_required')) {
        throw new StaleOcsSubprocessError(`${session_id}/message/`);
      }
      throw new HttpError(sendRes.status, `/api/chat/${session_id}/message/`, sendBody);
    }
    const { task_id } = (await sendRes.json()) as { task_id: string };

    // 3. Poll for response (up to 120s). Fail FAST on a generation error
    //    instead of spinning to the deadline. The poll payload on a failed
    //    generation is `{"error": "...", "status": "error"}` and can arrive
    //    with a NON-2xx HTTP status — so we must inspect the body even when
    //    `pollRes.ok` is false rather than blindly `continue`-ing past it. The
    //    old `if (!pollRes.ok) continue` swallowed exactly this shape and let
    //    a ~6s-detectable error spin to the full 120s timeout, masking an
    //    actionable diagnostic as a wall-clock stall (jjackson/ace#708).
    const deadline = Date.now() + 120_000;
    let lastTransient = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(
        `${this.opts.baseUrl}/api/chat/${session_id}/${task_id}/poll/`,
        { method: 'GET', headers: sessionHeaders },
      );
      // Parse the body regardless of HTTP status — an errored generation can
      // be delivered with a non-2xx code while still carrying the payload.
      let pb: { status?: string; error?: string; message?: { content?: string } };
      try {
        pb = (await pollRes.json()) as typeof pb;
      } catch {
        // Non-JSON body (e.g. an HTML 5xx page). Treat as transient and keep
        // polling; remember it for the timeout message.
        if (!pollRes.ok) lastTransient = `HTTP ${pollRes.status}`;
        continue;
      }
      // Generation error — surface the error content and fail fast, enriched
      // with the session's trace pointer (see describeSessionTrace below).
      if (pb.status === 'error' || pb.status === 'failed' || (pb.error && pb.error.trim())) {
        const detail = pb.error?.trim() || `task ${task_id} reported status '${pb.status}'`;
        const tracePointer = await this.describeSessionTrace(session_id);
        throw new Error(`sendTestMessage: OCS generation error — ${detail}${tracePointer}`);
      }
      if (pb.status === 'complete' && pb.message?.content) {
        return { response: pb.message.content };
      }
      // Still processing, or a transient non-ok with no error payload — keep polling.
      if (!pollRes.ok) lastTransient = `HTTP ${pollRes.status}`;
    }
    throw new Error(
      `sendTestMessage: timed out after 120s waiting for response` +
        (lastTransient ? ` (last transient poll: ${lastTransient})` : ''),
    );
  }

  /**
   * Best-effort trace pointer for a failed generation. OCS hides the real
   * provider error behind the generic "intermittent error related to load"
   * fallback unless the experiment has debug_mode enabled (OCS
   * apps/experiments/task_utils.py), which misled triage into calling a
   * revoked team LLM-provider key a platform-wide outage (jjackson/ace#743 —
   * the golden-template "control" sat behind the same dead key, so it failed
   * identically and proved nothing). The session's trace page carries the
   * underlying error (e.g. `401 invalid x-api-key`), so the thrown error
   * carries its URL. Never throws — enrichment failure returns ''.
   */
  private async describeSessionTrace(sessionId: string): Promise<string> {
    try {
      const session = (await this.request('GET', `/api/sessions/${sessionId}/`)) as {
        messages?: Array<{ metadata?: { trace_info?: Array<{ trace_url?: string }> } }>;
      };
      const traceUrls = (session.messages ?? [])
        .flatMap((m) => m.metadata?.trace_info ?? [])
        .map((t) => t.trace_url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0);
      const last = traceUrls[traceUrls.length - 1];
      if (!last) return '';
      const abs = last.startsWith('http') ? last : `${this.opts.baseUrl}${last}`;
      return (
        ` [session ${sessionId}; underlying trace: ${abs} — OCS masks the real provider error` +
        ` behind this generic fallback unless debug_mode is on. Open the trace (team login)` +
        ` before diagnosing a platform outage; known class: revoked team LLM provider key` +
        ` (jjackson/ace#743).]`
      );
    } catch {
      return '';
    }
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
