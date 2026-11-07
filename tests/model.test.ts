import { describe, expect, it, vi, afterEach } from 'vitest';
import { ModelClient } from '../src/model';

afterEach(() => vi.unstubAllGlobals());

describe('ModelClient', () => {
  it('parses streamed text and tool-call fragments', async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\\"path\\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"src/a.ts\\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const client = new ModelClient({ baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'test', maxTokens: 1000, reasoning: false });
    const result = await client.request(new AbortController().signal, [{ role: 'user', content: 'read' }], []);
    expect(result.content).toBe('Hello');
    expect(result.toolCalls[0]?.function.name).toBe('read_file');
    expect(result.toolCalls[0]?.function.arguments).toBe('{"path":"src/a.ts"}');
  });

  it('surfaces HTTP errors with the response status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    const client = new ModelClient({ baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'test', maxTokens: 1000, reasoning: false });
    await expect(client.request(new AbortController().signal, [], [])).rejects.toThrow(/401/);
  });
});
