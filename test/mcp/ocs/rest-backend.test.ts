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
