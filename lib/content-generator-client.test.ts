import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentGeneratorClient, ContentGeneratorAuthError } from './content-generator-client.js';

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('ContentGeneratorClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('returns PNG bytes on 200 image/png', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG_MAGIC, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'k' });
    const out = await c.generateImage({ applicationContext: 'A', formText: 'F', imageDirectives: 'D' });
    expect(out.subarray(0, 8)).toEqual(Buffer.from(PNG_MAGIC));
  });

  it('sends Authorization Bearer header with the API key', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG_MAGIC, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'k123' });
    await c.generateImage({ applicationContext: 'A', formText: 'F' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer k123');
  });

  it('retries once on 5xx then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('fail', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(PNG_MAGIC, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'k', retryDelayMs: 1 });
    const out = await c.generateImage({ applicationContext: 'A', formText: 'F' });
    expect(out.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws ContentGeneratorAuthError on 401/403', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'bad', retryDelayMs: 1 });
    await expect(c.generateImage({ applicationContext: 'A', formText: 'F' })).rejects.toBeInstanceOf(
      ContentGeneratorAuthError,
    );
  });

  it('does not retry on 4xx (other than 408/429)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    const c = new ContentGeneratorClient({ url: 'https://x.test/gen', apiKey: 'k', retryDelayMs: 1 });
    await expect(c.generateImage({ applicationContext: 'A', formText: 'F' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
