import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentGeneratorClient, ContentGeneratorAuthError } from './content-generator-client.js';

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = Buffer.from(PNG_MAGIC).toString('base64');

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ContentGeneratorClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('returns image bytes + prompt_used on 200 application/json', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ image: PNG_BASE64, prompt_used: 'foo' }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k' });
    const out = await c.generateImage({ applicationContext: 'A', formText: 'F', imageDirectives: 'D' });
    expect(out.image.subarray(0, 8)).toEqual(Buffer.from(PNG_MAGIC));
    expect(out.promptUsed).toBe('foo');
  });

  it('appends /v1/form-image to the gateway base URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ image: PNG_BASE64, prompt_used: 'p' }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k' });
    await c.generateImage({ applicationContext: 'A', formText: 'F' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.test/v1/form-image');
  });

  it('handles trailing slash on the gateway URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ image: PNG_BASE64, prompt_used: 'p' }));
    const c = new ContentGeneratorClient({ url: 'https://x.test/', apiKey: 'k' });
    await c.generateImage({ applicationContext: 'A', formText: 'F' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.test/v1/form-image');
  });

  it('sends x-api-key header on first attempt', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ image: PNG_BASE64, prompt_used: 'p' }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k123' });
    await c.generateImage({ applicationContext: 'A', formText: 'F' });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k123');
    expect(headers.Authorization).toBeUndefined();
  });

  it('falls back to ?key= query string after 401 on header', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(jsonRes({ image: PNG_BASE64, prompt_used: 'p' }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k123', retryDelayMs: 1 });
    const out = await c.generateImage({ applicationContext: 'A', formText: 'F' });
    expect(out.promptUsed).toBe('p');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://x.test/v1/form-image?key=k123');
    const fallbackHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(fallbackHeaders['x-api-key']).toBeUndefined();
  });

  it('throws ContentGeneratorAuthError when both auth shapes fail', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'bad', retryDelayMs: 1 });
    await expect(c.generateImage({ applicationContext: 'A', formText: 'F' })).rejects.toBeInstanceOf(
      ContentGeneratorAuthError,
    );
  });

  it('retries once on 5xx then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('fail', { status: 503 }))
      .mockResolvedValueOnce(jsonRes({ image: PNG_BASE64, prompt_used: 'p' }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k', retryDelayMs: 1 });
    const out = await c.generateImage({ applicationContext: 'A', formText: 'F' });
    expect(out.image.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx (other than 408/429)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k', retryDelayMs: 1 });
    await expect(c.generateImage({ applicationContext: 'A', formText: 'F' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends upscale=true when caller requests it', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ image: PNG_BASE64, prompt_used: 'p' }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k' });
    await c.generateImage({ applicationContext: 'A', formText: 'F', upscale: true });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.upscale).toBe(true);
  });

  it('defaults upscale to false when not provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ image: PNG_BASE64, prompt_used: 'p' }));
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k' });
    await c.generateImage({ applicationContext: 'A', formText: 'F' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.upscale).toBe(false);
  });

  it('forwards 422 validation errors with detail message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ detail: [{ loc: ['body', 'form_text'], msg: 'field required', type: 'value_error.missing' }] }, 422),
    );
    const c = new ContentGeneratorClient({ url: 'https://x.test', apiKey: 'k', retryDelayMs: 1 });
    await expect(c.generateImage({ applicationContext: 'A', formText: '' })).rejects.toThrow(/field required/);
  });
});
