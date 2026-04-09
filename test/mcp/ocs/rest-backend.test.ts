import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { RestBackend } from '../../../mcp/ocs/backends/rest.js';
import { HttpError } from '../../../mcp/ocs/errors.js';

const BASE = 'https://chatbots.dimagi.com';

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

describe('RestBackend chatbot atoms', () => {
  it('listChatbots passes cursor and page_size as query params', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?cursor=abc&page_size=25', method: 'GET' })
      .reply(200, { results: [{ id: 1, name: 'bot', public_id: 'uuid-1' }], next: 'xyz' });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const out = await b.listChatbots({ cursor: 'abc', page_size: 25 });
    expect(out.chatbots[0].id).toBe(1);
    expect(out.next_cursor).toBe('xyz');
  });

  it('getChatbot fetches a single experiment', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/42/', method: 'GET' })
      .reply(200, { id: 42, name: 'bot', public_id: 'uuid-42' });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const exp = await b.getChatbot({ experiment_id: 42 });
    expect(exp.name).toBe('bot');
  });

  it('sendTestMessage posts OpenAI-compatible body', async () => {
    mockAgent.get(BASE)
      .intercept({
        path: '/api/openai/99/chat/completions',
        method: 'POST',
        body: (body) => {
          const parsed = JSON.parse(body as string);
          return parsed.messages[0].role === 'user';
        },
      })
      .reply(200, { choices: [{ message: { role: 'assistant', content: 'hi' } }] });

    const b = new RestBackend({ baseUrl: BASE, token: 't' });
    const res = await b.sendTestMessage({
      experiment_id: 99,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.response.content).toBe('hi');
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
