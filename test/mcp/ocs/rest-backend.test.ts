import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { RestBackend, extractExperimentId } from '../../../mcp/ocs/backends/rest.js';
import { HttpError, StaleOcsSubprocessError } from '../../../mcp/ocs/errors.js';

const BASE = 'https://www.openchatstudio.com';

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
});

describe('RestBackend.verify', () => {
  it('calls GET /api/experiments/?page_size=1 with Bearer token', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?page_size=1', method: 'GET' })
      .reply(200, { results: [], next: null });

    const backend = new RestBackend({ baseUrl: BASE, token: 'tok_xyz' });
    await expect(backend.verify()).resolves.toBeUndefined();
  });

  it('throws HttpError on 401', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?page_size=1', method: 'GET' })
      .reply(401, 'Unauthorized');

    const backend = new RestBackend({ baseUrl: BASE, token: 'bad' });
    await expect(backend.verify()).rejects.toBeInstanceOf(HttpError);
  });
});

describe('extractExperimentId', () => {
  it('parses experiment_id from full human URL', () => {
    expect(extractExperimentId('https://www.openchatstudio.com/a/connect-ace/chatbots/11996/'))
      .toBe(11996);
  });
  it('parses experiment_id from path-only human URL', () => {
    expect(extractExperimentId('/a/connect-ace/chatbots/42/')).toBe(42);
  });
  it('returns null for the API URL shape (this is what live OCS actually returns; 0.6.6 N2 fix)', () => {
    // Live OCS /api/experiments/ returns `url` as the API URL, NOT the human URL.
    // This is the regression caught in the 2026-04-28 turmeric-dogfood addendum:
    // we used to assume `/a/<team>/chatbots/<int>/` but the live shape is
    // `/api/experiments/<uuid>/`. The composite backend now enriches via a
    // Playwright HTMX scrape; this regex parser is the fallback path.
    expect(extractExperimentId('https://www.openchatstudio.com/api/experiments/5e946111-357e-4748-97b9-1fadacfa7122/'))
      .toBeNull();
  });
  it('returns null for undefined / empty / non-matching URLs', () => {
    expect(extractExperimentId(undefined)).toBeNull();
    expect(extractExperimentId('')).toBeNull();
    expect(extractExperimentId('/a/team/projects/99/')).toBeNull();
  });
});

describe('RestBackend chatbot atoms', () => {
  it('listChatbots returns experiment_id: null on the live API-URL shape (composite enriches separately)', async () => {
    // The 2026-04-28 N2 fix (0.6.6): live OCS returns `url` as the API URL,
    // not the human URL. The REST-level regex parser correctly returns null
    // for this shape; the composite backend enriches via a Playwright scrape.
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?cursor=abc&page_size=25', method: 'GET' })
      .reply(200, {
        results: [{
          id: '5e946111-357e-4748-97b9-1fadacfa7122',
          name: 'ACE - turmeric',
          url: 'https://www.openchatstudio.com/api/experiments/5e946111-357e-4748-97b9-1fadacfa7122/',
        }],
        next: 'xyz',
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listChatbots({ cursor: 'abc', page_size: 25 });
    expect(out.chatbots[0].id).toBe('5e946111-357e-4748-97b9-1fadacfa7122');
    expect(out.chatbots[0].experiment_id).toBeNull();
    expect(out.next_cursor).toBe('xyz');
  });

  it('listChatbots still parses experiment_id from the legacy human-URL shape if OCS ever returns it', async () => {
    // Defensive: keep the parser for the case where OCS changes back or some
    // future endpoint returns the human URL.
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?page_size=50', method: 'GET' })
      .reply(200, {
        results: [{
          id: 'uuid-1',
          name: 'bot',
          url: 'https://www.openchatstudio.com/a/connect-ace/chatbots/11996/',
        }],
        next: null,
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listChatbots();
    expect(out.chatbots[0].experiment_id).toBe(11996);
  });

  it('listChatbots returns experiment_id: null when url is missing', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?page_size=50', method: 'GET' })
      .reply(200, {
        results: [{ id: 'uuid-no-url', name: 'orphan' }],
        next: null,
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listChatbots();
    expect(out.chatbots[0].experiment_id).toBeNull();
  });

  it('getChatbot uses the UUID public_id as the path parameter; returns experiment_id null on API URL', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/uuid-42/', method: 'GET' })
      .reply(200, {
        id: 'uuid-42',
        name: 'bot',
        url: '/api/experiments/uuid-42/',  // live API shape
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const exp = await b.getChatbot({ public_id: 'uuid-42' });
    expect(exp.name).toBe('bot');
    expect(exp.id).toBe('uuid-42');
    expect(exp.experiment_id).toBeNull();
  });

  it('sendTestMessage uses the widget chat API (start → send → poll)', async () => {
    const sessionId = 'test-session-123';
    const taskId = 'test-task-456';

    // 1. Start session
    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId });

    // 2. Send message
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/message/`, method: 'POST' })
      .reply(200, { task_id: taskId });

    // 3. Poll for response (return complete on first poll)
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/${taskId}/poll/`, method: 'GET' })
      .reply(200, { status: 'complete', message: { content: 'hi there' } });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const res = await b.sendTestMessage({
      public_id: 'uuid-42',
      embed_key: 'embed-key-xyz',
      message: 'hello',
    });
    expect(res.response).toBe('hi there');
  });

  // jjackson/ace#742: OCS #3552 (deployed 2026-06-09) requires a per-session
  // token. POST /api/chat/start/ now returns `session_token`, which the
  // message + poll session endpoints enforce as `X-Session-Token`. The backend
  // must capture the token and thread it, or those calls 403 with
  // `session_token_required` (the bot then surfaces a generic "something went
  // wrong" fallback that reads like an LLM outage).
  it('sendTestMessage threads the per-session token (X-Session-Token) on message + poll', async () => {
    const sessionId = 'tok-session-1';
    const taskId = 'tok-task-1';
    const token = 'signed-session-token-abc';

    // start issues the session token (and we ask for it via use_session_token)
    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId, session_token: token });

    // message + poll MUST carry the token header — undici only matches the
    // intercept (and thus 200s) when the header is present with the right value.
    mockAgent.get(BASE)
      .intercept({
        path: `/api/chat/${sessionId}/message/`,
        method: 'POST',
        headers: { 'X-Session-Token': token },
      })
      .reply(200, { task_id: taskId });
    mockAgent.get(BASE)
      .intercept({
        path: `/api/chat/${sessionId}/${taskId}/poll/`,
        method: 'GET',
        headers: { 'X-Session-Token': token },
      })
      .reply(200, { status: 'complete', message: { content: 'token threaded ok' } });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const res = await b.sendTestMessage({
      public_id: 'uuid-42',
      embed_key: 'embed-key-xyz',
      message: 'hello',
    });
    expect(res.response).toBe('token threaded ok');
  });

  // jjackson/ace#761: when /start/ DID issue a token (and the fixed code
  // threaded it) yet /message/ still 403s `session_token_required`, that's the
  // stale-subprocess signature — the running ace-ocs MCP is executing pre-#742
  // code. Self-diagnose with the typed StaleOcsSubprocessError ("restart Claude
  // Code") instead of a generic HttpError that reads like an auth failure.
  it('sendTestMessage throws StaleOcsSubprocessError on 403 session_token_required despite a threaded token (#761)', async () => {
    const sessionId = 'stale-session-1';
    const token = 'signed-session-token-xyz';
    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId, session_token: token });
    // Token was issued + threaded, yet the endpoint still rejects it.
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/message/`, method: 'POST' })
      .reply(403, { detail: 'session_token_required' });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(
      b.sendTestMessage({ public_id: 'uuid-42', embed_key: 'k', message: 'hi' }),
    ).rejects.toBeInstanceOf(StaleOcsSubprocessError);
  });

  // Control: a 403 session_token_required when NO token was issued is a genuine
  // session/auth condition, NOT a stale subprocess — must stay a plain HttpError.
  it('sendTestMessage throws a plain HttpError on a 403 with no token issued (#761 control)', async () => {
    const sessionId = 'notoken-403';
    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId, session_token: null });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/message/`, method: 'POST' })
      .reply(403, { detail: 'session_token_required' });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const err = await b
      .sendTestMessage({ public_id: 'uuid-42', embed_key: 'k', message: 'hi' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(StaleOcsSubprocessError);
  });

  // A session OCS opted out of token enforcement returns session_token: null;
  // the backend must then NOT send the header and the legacy path still works.
  it('sendTestMessage omits X-Session-Token when OCS issues no token (opted-out session)', async () => {
    const sessionId = 'notok-session-1';
    const taskId = 'notok-task-1';

    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId, session_token: null });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/message/`, method: 'POST' })
      .reply(200, { task_id: taskId });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/${taskId}/poll/`, method: 'GET' })
      .reply(200, { status: 'complete', message: { content: 'legacy ok' } });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const res = await b.sendTestMessage({ public_id: 'uuid-42', embed_key: 'k', message: 'hi' });
    expect(res.response).toBe('legacy ok');
  });

  // jjackson/ace#708: a failed LLM generation returns
  // `{"error":"...","status":"error"}` on /poll/ — sometimes with a non-2xx
  // HTTP status. sendTestMessage must FAIL FAST and surface the error content
  // instead of spinning to the 120s timeout.
  it('sendTestMessage fails fast and surfaces the error content on status:error (HTTP 200)', async () => {
    const sessionId = 's-err-200';
    const taskId = 't-err-200';
    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/message/`, method: 'POST' })
      .reply(200, { task_id: taskId });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/${taskId}/poll/`, method: 'GET' })
      .reply(200, { status: 'error', error: 'Sorry something went wrong. Intermittent load error.' });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(
      b.sendTestMessage({ public_id: 'uuid-42', embed_key: 'k', message: 'hi' }),
    ).rejects.toThrow(/OCS generation error.*Intermittent load error/);
  });

  it('sendTestMessage fails fast on an error payload delivered with a non-2xx status (the #708 mask)', async () => {
    const sessionId = 's-err-500';
    const taskId = 't-err-500';
    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/message/`, method: 'POST' })
      .reply(200, { task_id: taskId });
    // The generation error arrives with HTTP 500 but a JSON error body — the
    // old `if (!pollRes.ok) continue` swallowed this and spun to 120s.
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/${taskId}/poll/`, method: 'GET' })
      .reply(500, { status: 'error', error: 'upstream provider outage' });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(
      b.sendTestMessage({ public_id: 'uuid-42', embed_key: 'k', message: 'hi' }),
    ).rejects.toThrow(/OCS generation error.*upstream provider outage/);
  });

  // jjackson/ace#743: the generic "intermittent error related to load" fallback
  // masked a revoked team LLM provider key (Anthropic 401 invalid x-api-key) and
  // was misdiagnosed as a platform outage. The real error lives in the session's
  // trace. On a generation error, sendTestMessage must enrich the thrown error
  // with the session's trace pointer so triage starts at the provider error,
  // not at "OCS is down".
  it('sendTestMessage enriches a generation error with the session trace pointer (#743)', async () => {
    const sessionId = 's-err-trace';
    const taskId = 't-err-trace';
    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/message/`, method: 'POST' })
      .reply(200, { task_id: taskId });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/${taskId}/poll/`, method: 'GET' })
      .reply(500, { status: 'error', error: 'Sorry something went wrong. This was likely an intermittent error related to load.' });
    mockAgent.get(BASE)
      .intercept({ path: `/api/sessions/${sessionId}/`, method: 'GET' })
      .reply(200, {
        id: sessionId,
        messages: [
          {
            role: 'user',
            content: 'hi',
            metadata: {
              trace_info: [
                { trace_id: 663105, trace_url: '/a/connect-ace/traces/663105/', trace_provider: 'ocs' },
              ],
            },
          },
          { role: 'assistant', content: 'Sorry, something went wrong...', metadata: {} },
        ],
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const err = await b
      .sendTestMessage({ public_id: 'uuid-42', embed_key: 'k', message: 'hi' })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/OCS generation error/);
    expect(err!.message).toContain(`${BASE}/a/connect-ace/traces/663105/`);
    expect(err!.message).toContain(sessionId);
    // Must steer the reader away from the "outage" misdiagnosis class.
    expect(err!.message).toMatch(/provider error/i);
  });

  it('sendTestMessage surfaces the original generation error when trace enrichment fails', async () => {
    const sessionId = 's-err-noenrich';
    const taskId = 't-err-noenrich';
    mockAgent.get(BASE)
      .intercept({ path: '/api/chat/start/', method: 'POST' })
      .reply(200, { session_id: sessionId });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/message/`, method: 'POST' })
      .reply(200, { task_id: taskId });
    mockAgent.get(BASE)
      .intercept({ path: `/api/chat/${sessionId}/${taskId}/poll/`, method: 'GET' })
      .reply(200, { status: 'error', error: 'boom' });
    mockAgent.get(BASE)
      .intercept({ path: `/api/sessions/${sessionId}/`, method: 'GET' })
      .reply(500, 'nope');

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(
      b.sendTestMessage({ public_id: 'uuid-42', embed_key: 'k', message: 'hi' }),
    ).rejects.toThrow(/OCS generation error — boom/);
  });

  it('triggerBotMessage posts to /api/trigger_bot', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/trigger_bot', method: 'POST' })
      .reply(200, '');

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(b.triggerBotMessage({
      experiment_id: 'exp1',
      identifier: '+15550000000',
      platform: 'api',
      prompt_text: 'hi there',
    })).resolves.toBeUndefined();
  });

  it('downloadFile returns a Buffer', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/files/7/content', method: 'GET' })
      .reply(200, Buffer.from('PDFDATA'), {
        headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="x.pdf"' },
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const f = await b.downloadFile({ file_id: 7 });
    expect(f.content.toString()).toBe('PDFDATA');
    expect(f.mime_type).toBe('application/pdf');
    expect(f.filename).toBe('x.pdf');
  });
});

describe('RestBackend session atoms', () => {
  it('listSessions filters by experiment', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/?experiment=42&page_size=50', method: 'GET' })
      .reply(200, { results: [{ id: 's1', tags: ['foo'], created_at: 'ts' }], next: null });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listSessions({ experiment_id: '42' });
    expect(out.sessions[0].id).toBe('s1');
  });

  it('listSessions `since` filters client-side by created_at, not via `ordering` param', async () => {
    // Assert the query string does NOT include `since` or `ordering`
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/?page_size=50', method: 'GET' })
      .reply(200, {
        results: [
          { id: 'old', tags: [], created_at: '2026-04-01T00:00:00Z' },
          { id: 'new', tags: [], created_at: '2026-04-10T00:00:00Z' },
        ],
        next: null,
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listSessions({ since: '2026-04-05T00:00:00Z' });
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0].id).toBe('new');
  });

  it('getSession returns messages', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/', method: 'GET' })
      .reply(200, {
        id: 's1',
        tags: [],
        created_at: 'ts',
        messages: [{ id: 'm1', created_at: 'ts', message_type: 'human', content: 'hi' }],
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const sess = await b.getSession({ session_id: 's1' });
    expect(sess.messages[0].content).toBe('hi');
  });

  // OCS PR #3634 (deployed 2026-06-15) added `state` to the session retrieval
  // payload. Surfacing it lets the verifier read mid-conversation session
  // memory (cohort_id, last_interview, etc.) — strictly read-only.
  it('getSession passes through the `state` field when present (OCS #3634)', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s2/', method: 'GET' })
      .reply(200, {
        id: 's2',
        tags: [],
        created_at: 'ts',
        messages: [],
        state: { cohort_id: '08TRS', next_interview: 'te002' },
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const sess = await b.getSession({ session_id: 's2' });
    expect(sess.state).toEqual({ cohort_id: '08TRS', next_interview: 'te002' });
  });

  it('getSession omits `state` cleanly when OCS does not return it', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s3/', method: 'GET' })
      .reply(200, { id: 's3', tags: [], created_at: 'ts', messages: [] });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const sess = await b.getSession({ session_id: 's3' });
    expect(sess.state).toBeUndefined();
  });

  it('addSessionTags posts to /tags/', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/tags/', method: 'POST' })
      .reply(200, { tags: ['a', 'b'] });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const r = await b.addSessionTags({ session_id: 's1', tags: ['a', 'b'] });
    expect(r.tags).toEqual(['a', 'b']);
  });

  it('removeSessionTags sends DELETE', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/tags/', method: 'DELETE' })
      .reply(200, { tags: [] });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const r = await b.removeSessionTags({ session_id: 's1', tags: ['a'] });
    expect(r.tags).toEqual([]);
  });

  it('endSession posts to end_experiment_session', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/end_experiment_session/', method: 'POST' })
      .reply(200, '');

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(b.endSession({ session_id: 's1' })).resolves.toBeUndefined();
  });

  it('updateSessionState patches', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/sessions/s1/update_state/', method: 'PATCH' })
      .reply(200, { state: { foo: 1 } });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const r = await b.updateSessionState({ session_id: 's1', state: { foo: 1 } });
    expect(r.state).toEqual({ foo: 1 });
  });

  it('updateParticipantData posts to /api/participants', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/participants', method: 'POST' })
      .reply(200, '');

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    await expect(b.updateParticipantData({
      identifier: 'p1',
      platform: 'api',
      data: [{ experiment: 'e1', data: { name: 'Jane' } }],
    })).resolves.toBeUndefined();
  });
});

// ── v2 chatbots inspect + me (OCS PR #3536 + #3648, schema served at /api/schema/) ──────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const INSPECT_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'chatbot-inspect.json'), 'utf-8'),
);

describe('RestBackend v2 atoms', () => {
  it('inspectChatbot GETs /api/v2/chatbots/{id}/inspect/ and returns the payload verbatim', async () => {
    mockAgent.get(BASE)
      .intercept({
        path: `/api/v2/chatbots/${INSPECT_FIXTURE.id}/inspect/`,
        method: 'GET',
        headers: { Authorization: 'Bearer tok' },
      })
      .reply(200, INSPECT_FIXTURE);

    const b = new RestBackend({ baseUrl: BASE, token: 'tok' });
    const out = await b.inspectChatbot({ public_id: INSPECT_FIXTURE.id });
    expect(out.name).toBe(INSPECT_FIXTURE.name);
    // The verifier needs these three nested fields specifically:
    // (1) a router node with keywords
    const router = out.pipeline?.nodes?.find((n) => n.type === 'StaticRouterNode');
    expect(router?.params?.keywords).toEqual(['te001', 'te002', 'te003']);
    // (2) a 24-hour timeout trigger
    const timeout = out.events.timeout_triggers.find((t) => t.delay_seconds === 86400);
    expect(timeout?.is_active).toBe(true);
    // (3) a "Session Completion" custom action on the LLM node
    const llm = out.pipeline?.nodes?.find((n) => n.type === 'LLMResponseWithPrompt');
    const action = llm?.custom_actions?.find((a) => a.name === 'Session Completion');
    expect(action).toBeDefined();
  });

  it('inspectChatbot forwards the `version` query param when supplied', async () => {
    mockAgent.get(BASE)
      .intercept({
        path: `/api/v2/chatbots/${INSPECT_FIXTURE.id}/inspect/?version=default`,
        method: 'GET',
      })
      .reply(200, INSPECT_FIXTURE);

    const b = new RestBackend({ baseUrl: BASE, token: 'tok' });
    const out = await b.inspectChatbot({ public_id: INSPECT_FIXTURE.id, version: 'default' });
    expect(out.id).toBe(INSPECT_FIXTURE.id);
  });

  it('inspectChatbot throws HttpError on 404 (e.g. wrong public_id / not on team)', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/v2/chatbots/nope/inspect/', method: 'GET' })
      .reply(404, 'Not Found');

    const b = new RestBackend({ baseUrl: BASE, token: 'tok' });
    await expect(b.inspectChatbot({ public_id: 'nope' })).rejects.toBeInstanceOf(HttpError);
  });

  it('getMe GETs /api/v2/me/ and returns user identity for the scoped key', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/v2/me/', method: 'GET' })
      .reply(200, {
        id: 42,
        username: 'ace@dimagi-ai.com',
        email: 'ace@dimagi-ai.com',
        first_name: 'Ace',
        last_name: 'AI',
        team: { name: 'Vaccine Coach', slug: 'vaccine-coach' },
      });

    const b = new RestBackend({ baseUrl: BASE, token: 'tok' });
    const me = await b.getMe();
    expect(me.email).toBe('ace@dimagi-ai.com');
    expect(me.team?.slug).toBe('vaccine-coach');
  });

  it('getMe throws HttpError on 401 (invalid or expired key)', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/v2/me/', method: 'GET' })
      .reply(401, 'Unauthorized');

    const b = new RestBackend({ baseUrl: BASE, token: 'bad' });
    await expect(b.getMe()).rejects.toBeInstanceOf(HttpError);
  });
});

// ── Multi-team token registry: tokensByTeam + resolveToken (#802 follow-up) ──────────────────────
describe('RestBackend multi-team token resolution', () => {
  const tokensByTeam = new Map<string, string>([
    ['Vaccine_Coach', 'tok_vc'],
    ['VACCINE_COACH', 'tok_vc'],   // env-name form alias
    ['other-team', 'tok_other'],
  ]);

  it('resolveToken returns opts.token when team_slug is omitted', () => {
    const b = new RestBackend({ baseUrl: BASE, token: 'tok_default', tokensByTeam });
    expect(b.resolveToken()).toBe('tok_default');
    expect(b.resolveToken(undefined)).toBe('tok_default');
  });

  it('resolveToken short-circuits to opts.token when slug matches defaultTeamSlug', () => {
    const b = new RestBackend({
      baseUrl: BASE,
      token: 'tok_default',
      defaultTeamSlug: 'connect-ace',
      tokensByTeam,
    });
    expect(b.resolveToken('connect-ace')).toBe('tok_default');
  });

  it('resolveToken looks up a registered non-default team', () => {
    const b = new RestBackend({
      baseUrl: BASE,
      token: 'tok_default',
      defaultTeamSlug: 'connect-ace',
      tokensByTeam,
    });
    expect(b.resolveToken('Vaccine_Coach')).toBe('tok_vc');
    expect(b.resolveToken('VACCINE_COACH')).toBe('tok_vc'); // alias resolves identically
    expect(b.resolveToken('other-team')).toBe('tok_other');
  });

  it('resolveToken throws a typed error naming the env var to add when slug is not registered', () => {
    const b = new RestBackend({ baseUrl: BASE, token: 'tok_default', tokensByTeam });
    // Slug-to-env-name mapping uppercases + replaces non-alphanumerics with `_`.
    expect(() => b.resolveToken('missing-team')).toThrow(/OCS_API_TOKEN_MISSING_TEAM/);
    expect(() => b.resolveToken('Foo_Bar')).toThrow(/OCS_API_TOKEN_FOO_BAR/);
  });

  it('inspectChatbot uses the resolved team token instead of opts.token when team_slug is provided', async () => {
    mockAgent.get(BASE)
      .intercept({
        path: `/api/v2/chatbots/${INSPECT_FIXTURE.id}/inspect/`,
        method: 'GET',
        headers: { Authorization: 'Bearer tok_vc' },   // <-- NOT tok_default
      })
      .reply(200, INSPECT_FIXTURE);

    const b = new RestBackend({
      baseUrl: BASE,
      token: 'tok_default',
      defaultTeamSlug: 'connect-ace',
      tokensByTeam,
    });
    const out = await b.inspectChatbot({ public_id: INSPECT_FIXTURE.id, team_slug: 'Vaccine_Coach' });
    expect(out.id).toBe(INSPECT_FIXTURE.id);
  });

  it('getMe uses the resolved team token when team_slug is provided', async () => {
    mockAgent.get(BASE)
      .intercept({
        path: '/api/v2/me/',
        method: 'GET',
        headers: { Authorization: 'Bearer tok_vc' },
      })
      .reply(200, {
        id: 17,
        username: 'jjackson@dimagi.com',
        email: 'jjackson@dimagi.com',
        team: { name: 'CCC LDVP Bots', slug: 'Vaccine_Coach' },
      });

    const b = new RestBackend({
      baseUrl: BASE,
      token: 'tok_default',
      defaultTeamSlug: 'connect-ace',
      tokensByTeam,
    });
    const me = await b.getMe({ team_slug: 'Vaccine_Coach' });
    expect(me.team?.slug).toBe('Vaccine_Coach');
  });

  it('listChatbots uses the resolved team token when team_slug is provided', async () => {
    mockAgent.get(BASE)
      .intercept({
        path: '/api/experiments/?page_size=50',
        method: 'GET',
        headers: { Authorization: 'Bearer tok_vc' },
      })
      .reply(200, { results: [], next: null });

    const b = new RestBackend({
      baseUrl: BASE,
      token: 'tok_default',
      defaultTeamSlug: 'connect-ace',
      tokensByTeam,
    });
    const out = await b.listChatbots({ team_slug: 'Vaccine_Coach' });
    expect(out.chatbots).toEqual([]);
  });

  it('inspectChatbot still uses opts.token when team_slug is omitted (back-compat)', async () => {
    mockAgent.get(BASE)
      .intercept({
        path: `/api/v2/chatbots/${INSPECT_FIXTURE.id}/inspect/`,
        method: 'GET',
        headers: { Authorization: 'Bearer tok_default' },
      })
      .reply(200, INSPECT_FIXTURE);

    const b = new RestBackend({
      baseUrl: BASE,
      token: 'tok_default',
      defaultTeamSlug: 'connect-ace',
      tokensByTeam,
    });
    const out = await b.inspectChatbot({ public_id: INSPECT_FIXTURE.id });
    expect(out.id).toBe(INSPECT_FIXTURE.id);
  });
});

// ── Env loader: loadTokensByTeam ────────────────────────────────────────────────────────────────
import { loadTokensByTeam } from '../../../mcp/ocs/auth/rest-token.js';

describe('loadTokensByTeam', () => {
  it('builds the registry from OCS_API_TOKEN_<SLUG> env vars only (OCS_API_TOKEN excluded)', () => {
    const reg = loadTokensByTeam({
      OCS_API_TOKEN: 'should_be_excluded',
      OCS_API_TOKEN_VACCINE_COACH: 'tok_vc',
      OCS_API_TOKEN_FOO: 'tok_foo',
      UNRELATED: 'noise',
    } as never);
    // Each entry registers both the uppercase env-name form AND a title-cased
    // alias so the live OCS slug ("Vaccine_Coach") resolves identically to
    // the env-name form ("VACCINE_COACH").
    expect(reg.get('VACCINE_COACH')).toBe('tok_vc');
    expect(reg.get('Vaccine_Coach')).toBe('tok_vc');
    expect(reg.get('FOO')).toBe('tok_foo');
    expect(reg.has('OCS_API_TOKEN')).toBe(false);     // default excluded
    expect(reg.has('should_be_excluded')).toBe(false);
  });

  it('returns an empty Map when no OCS_API_TOKEN_<SLUG> vars are set (back-compat)', () => {
    const reg = loadTokensByTeam({ OCS_API_TOKEN: 'only_default', UNRELATED: 'noise' } as never);
    expect(reg.size).toBe(0);
  });

  it('skips empty values to avoid registering blank tokens', () => {
    const reg = loadTokensByTeam({ OCS_API_TOKEN_EMPTY: '', OCS_API_TOKEN_FOO: 'tok_foo' } as never);
    expect(reg.has('EMPTY')).toBe(false);
    expect(reg.get('FOO')).toBe('tok_foo');
  });
});
