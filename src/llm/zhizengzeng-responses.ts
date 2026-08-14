import type { AgentContext, LLMClient } from './client.js';
import { actionEnvelopeJsonSchema } from './action-schema.js';

export const DEFAULT_RESPONSES_URL = 'https://api.zhizengzeng.com/v1/responses';
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.4-mini';

export interface CredentialReader {
  get(): Promise<string>;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ResponsesProviderErrorCode =
  | 'CREDENTIAL_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE';

const errorMessages: Record<ResponsesProviderErrorCode, string> = {
  CREDENTIAL_ERROR: '无法读取 API 凭据；请先通过 credentials set 安全录入。',
  TIMEOUT: '模型请求超时；本轮未执行任何动作。',
  NETWORK_ERROR: '模型服务暂时不可达；本轮未执行任何动作。',
  RATE_LIMITED: '模型服务当前限流；请稍后重试。',
  PROVIDER_ERROR: '模型服务返回受控错误；本轮未执行任何动作。',
  INVALID_RESPONSE: '模型服务未返回完整动作 JSON；本轮未执行任何动作。',
};

export class ResponsesProviderError extends Error {
  constructor(readonly code: ResponsesProviderErrorCode) {
    super(errorMessages[code]);
    this.name = 'ResponsesProviderError';
  }
}

export interface UsageSummary {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ZhizengzengResponsesOptions {
  readonly credentials: CredentialReader;
  readonly fetcher?: FetchLike;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

interface ResponsesPayload {
  readonly output_text?: unknown;
  readonly output?: unknown;
  readonly usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function outputText(payload: ResponsesPayload): string | undefined {
  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) return payload.output_text;
  if (!Array.isArray(payload.output)) return undefined;
  for (const message of payload.output) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (isRecord(item) && typeof item.text === 'string' && item.text.length > 0) return item.text;
    }
  }
  return undefined;
}

function parseUsage(value: unknown): UsageSummary | undefined {
  if (!isRecord(value)) return undefined;
  const number = (key: string): number | undefined => {
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
  };
  const usage = { inputTokens: number('input_tokens'), outputTokens: number('output_tokens'), totalTokens: number('total_tokens') };
  return usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined ? undefined : usage;
}

/**
 * Minimal native-fetch Responses adapter. It never validates or executes the
 * returned text itself: the existing strict local ActionParser remains required.
 */
export class ZhizengzengResponsesClient implements LLMClient {
  private readonly credentials: CredentialReader;
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private latestUsage: UsageSummary | undefined;

  constructor(options: ZhizengzengResponsesOptions) {
    this.credentials = options.credentials;
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_RESPONSES_URL;
    this.model = options.model ?? DEFAULT_RESPONSES_MODEL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!this.baseUrl.startsWith('https://')) throw new Error('Responses endpoint 必须使用 HTTPS。');
    if (!this.model.trim()) throw new Error('模型名称不能为空。');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error('请求超时必须在 1–30000ms 内。');
  }

  get lastUsage(): UsageSummary | undefined {
    return this.latestUsage;
  }

  async decide(context: AgentContext): Promise<unknown> {
    let key: string;
    try {
      key = await this.credentials.get();
    } catch {
      throw new ResponsesProviderError('CREDENTIAL_ERROR');
    }
    if (!key) throw new ResponsesProviderError('CREDENTIAL_ERROR');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          store: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(context) }] }],
          text: { format: { type: 'json_schema', name: 'action_envelope', strict: true, schema: actionEnvelopeJsonSchema } },
        }),
      });
      if (!response.ok) throw new ResponsesProviderError(response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR');
      let payload: ResponsesPayload;
      try {
        payload = await response.json() as ResponsesPayload;
      } catch {
        throw new ResponsesProviderError('INVALID_RESPONSE');
      }
      const text = outputText(payload);
      if (!text) throw new ResponsesProviderError('INVALID_RESPONSE');
      this.latestUsage = parseUsage(payload.usage);
      return text;
    } catch (error) {
      if (error instanceof ResponsesProviderError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new ResponsesProviderError('TIMEOUT');
      throw new ResponsesProviderError('NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }
}
