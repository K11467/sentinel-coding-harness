import { describe, expect, test } from 'vitest';
import {
  ResponsesProviderError,
  ZhizengzengResponsesClient,
  type FetchLike,
} from '../../src/llm/zhizengzeng-responses.js';
import type { AgentContext } from '../../src/llm/client.js';

const context: AgentContext = {
  task: '读取 package.json 并说明测试命令',
  workspace: '/tmp/workspace',
  availableActions: ['read_file', 'finish'],
  recentFeedback: [],
  notes: [],
  recentSteps: [],
};

class FakeCredentials {
  constructor(private readonly value = 'test-key-must-not-leak') {}

  async get(): Promise<string> {
    return this.value;
  }
}

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ZhizengzengResponsesClient', () => {
  test('用固定 HTTPS endpoint、Bearer header、strict action schema 请求 Responses', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return response(200, { output_text: '{"type":"finish","reason":"已完成","summary":"ok"}', usage: { total_tokens: 12 } });
    };
    const client = new ZhizengzengResponsesClient({ credentials: new FakeCredentials(), fetcher });

    await expect(client.decide(context)).resolves.toBe('{"type":"finish","reason":"已完成","summary":"ok"}');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe('https://api.zhizengzeng.com/v1/responses');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toMatchObject({
      Authorization: 'Bearer test-key-must-not-leak',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toMatchObject({ model: 'gpt-5.4-mini', store: false });
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'action_envelope', strict: true });
    expect(body.text.format.schema).not.toHaveProperty('id');
    expect(client.lastUsage).toEqual({ totalTokens: 12 });
  });

  test('兼容 output.content 的文本响应，并且仅返回完整动作 JSON 文本', async () => {
    const client = new ZhizengzengResponsesClient({
      credentials: new FakeCredentials(),
      fetcher: async () => response(200, {
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"type":"run_tests","reason":"验证"}' }] }],
      }),
    });

    await expect(client.decide(context)).resolves.toBe('{"type":"run_tests","reason":"验证"}');
  });

  test.each([
    [400, 'PROVIDER_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_ERROR'],
  ])('将 HTTP %i 映射为脱敏 provider 错误', async (status, code) => {
    const secret = 'response-body-secret';
    const client = new ZhizengzengResponsesClient({
      credentials: new FakeCredentials(),
      fetcher: async () => response(status, { error: { message: secret } }),
    });

    await expect(client.decide(context)).rejects.toMatchObject({ code });
    await expect(client.decide(context)).rejects.not.toThrow(secret);
  });

  test('网络异常和 AbortError 不回显原因，并被分别映射', async () => {
    const client = new ZhizengzengResponsesClient({
      credentials: new FakeCredentials(),
      fetcher: async () => { throw new DOMException('private network detail', 'AbortError'); },
    });
    await expect(client.decide(context)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(client.decide(context)).rejects.not.toThrow('private network detail');

    const networkClient = new ZhizengzengResponsesClient({
      credentials: new FakeCredentials(),
      fetcher: async () => { throw new Error('dns secret detail'); },
    });
    await expect(networkClient.decide(context)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(networkClient.decide(context)).rejects.not.toThrow('dns secret detail');
  });

  test('缺少 output_text 或不安全 base URL 会 fail-closed', async () => {
    const client = new ZhizengzengResponsesClient({
      credentials: new FakeCredentials(),
      fetcher: async () => response(200, { output: [] }),
    });
    await expect(client.decide(context)).rejects.toBeInstanceOf(ResponsesProviderError);
    await expect(client.decide(context)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    expect(() => new ZhizengzengResponsesClient({
      credentials: new FakeCredentials(),
      baseUrl: 'http://example.test/v1/responses',
      fetcher: async () => response(200, {}),
    })).toThrow('HTTPS');
  });
});
