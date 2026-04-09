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
