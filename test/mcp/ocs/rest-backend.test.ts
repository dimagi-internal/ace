import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { RestBackend, extractExperimentId } from '../../../mcp/ocs/backends/rest.js';
import { HttpError } from '../../../mcp/ocs/errors.js';

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
  it('parses experiment_id from full URL', () => {
    expect(extractExperimentId('https://www.openchatstudio.com/a/connect-ace/chatbots/11996/'))
      .toBe(11996);
  });
  it('parses experiment_id from path-only URL', () => {
    expect(extractExperimentId('/a/connect-ace/chatbots/42/')).toBe(42);
  });
  it('returns null for undefined / empty / non-matching URLs', () => {
    expect(extractExperimentId(undefined)).toBeNull();
    expect(extractExperimentId('')).toBeNull();
    expect(extractExperimentId('/a/team/projects/99/')).toBeNull();
  });
});

describe('RestBackend chatbot atoms', () => {
  it('listChatbots returns both UUID id and integer experiment_id parsed from url', async () => {
    // OCS /api/experiments/ returns `id` as the UUID public_id, not the integer db id.
    // See apps/api/views/experiments.py:36 (lookup_field = "public_id").
    // The integer experiment_id is recoverable from the `url` field — every authoring
    // atom needs it (closes the idempotency gap surfaced in the 0.5.18 dogfood run).
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?cursor=abc&page_size=25', method: 'GET' })
      .reply(200, {
        results: [{
          id: '00000000-0000-4000-8000-000000000001',
          name: 'bot',
          url: 'https://www.openchatstudio.com/a/connect-ace/chatbots/11996/',
        }],
        next: 'xyz',
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listChatbots({ cursor: 'abc', page_size: 25 });
    expect(out.chatbots[0].id).toBe('00000000-0000-4000-8000-000000000001');
    expect(out.chatbots[0].experiment_id).toBe(11996);
    expect(out.next_cursor).toBe('xyz');
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

  it('getChatbot uses the UUID public_id as the path parameter and returns experiment_id', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/uuid-42/', method: 'GET' })
      .reply(200, {
        id: 'uuid-42',
        name: 'bot',
        url: '/a/connect-ace/chatbots/9001/',  // path-only also works
      });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const exp = await b.getChatbot({ public_id: 'uuid-42' });
    expect(exp.name).toBe('bot');
    expect(exp.id).toBe('uuid-42');
    expect(exp.experiment_id).toBe(9001);
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
