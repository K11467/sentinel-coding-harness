import { describe, expect, test } from 'vitest';
import {
  FeedbackSummarizer,
  MAX_FEEDBACK_INPUT_BYTES,
  type ControlledTestResult
} from '../../src/feedback/summarizer.js';

function summarize(result: ControlledTestResult) {
  return new FeedbackSummarizer().summarize(result);
}

describe('FeedbackSummarizer', () => {
  test.each([
    [{ exitCode: 0 }, 'passed'],
    [{ exitCode: 1, stderr: 'AssertionError: expected true to be false' }, 'assertion_failed'],
    [{ exitCode: 2, stderr: 'error TS2322: Type string is not assignable to type number' }, 'type_error'],
    [{ exitCode: 127, stderr: 'command not found' }, 'command_error'],
    [{ exitCode: 1, timedOut: true, stderr: 'AssertionError: late failure' }, 'timeout']
  ] as const)('受控结果归类为 %s', (result, category) => {
    expect(summarize(result).category).toBe(category);
  });

  test('分类优先级固定为 timeout、type error、assertion failure、command error、passed', () => {
    expect(summarize({ exitCode: 1, timedOut: true, stderr: 'error TS2322\nAssertionError' }).category).toBe('timeout');
    expect(summarize({ exitCode: 1, stderr: 'error TS2322\nAssertionError' }).category).toBe('type_error');
    expect(summarize({ exitCode: 1, stderr: 'AssertionError\ncommand failed' }).category).toBe('assertion_failed');
    expect(summarize({ exitCode: 0, stderr: 'AssertionError: stale diagnostic' }).category).toBe('passed');
  });

  test('先截断最多 4KiB 输入，且摘要只包含确定性结果', () => {
    const visible = 'AssertionError: expected one value\n';
    const hiddenTail = 'tail-must-not-appear';
    const result = summarize({
      exitCode: 1,
      stderr: visible + 'x'.repeat(MAX_FEEDBACK_INPUT_BYTES) + hiddenTail
    });

    expect(result.category).toBe('assertion_failed');
    expect(result.summary).toBe('断言失败（退出码 1）。');
    expect(result.summary).not.toContain(hiddenTail);
  });

  test('摘要脱敏 Authorization Bearer 与 sk 形式密钥', () => {
    const apiKey = ['sk', 'proj', 'abcDEF1234567890'].join('-');
    const result = summarize({
      exitCode: 1,
      stderr: `Authorization: Bearer very-secret-token\nrequest failed with ${apiKey}`
    });

    expect(result.summary).toBe('命令失败（退出码 1）。');
    expect(result.summary).not.toContain('very-secret-token');
    expect(result.summary).not.toContain(apiKey);
  });

  test('空输出给出稳定且可操作的摘要', () => {
    expect(summarize({ exitCode: 0 })).toEqual({ category: 'passed', summary: '测试通过（退出码 0）。' });
    expect(summarize({ exitCode: 1 })).toEqual({ category: 'command_error', summary: '命令失败（退出码 1）。' });
  });

  test.each([
    ['大小写混合的 Basic Authorization', 'aUtHoRiZaTiOn: bAsIc basic-secret-value', 'basic-secret-value'],
    ['Token Authorization', 'Authorization: Token token-secret-value', 'token-secret-value'],
    ['JSON Authorization 字段', '{"Authorization":"Bearer json-secret-value"}', 'json-secret-value'],
    ['headers 中的 authorization 字段', 'headers: { authorization: "Bearer header-secret-value" }', 'header-secret-value'],
    ['Cookie', 'Cookie: session=cookie-secret-value', 'cookie-secret-value'],
    ['X-Api-Key', 'X-Api-Key: x-api-key-secret-value', 'x-api-key-secret-value'],
    ['api_key', 'api_key=api-key-secret-value', 'api-key-secret-value'],
    ['password', 'password: password-secret-value', 'password-secret-value'],
    ['PEM', '-----BEGIN PRIVATE KEY----- pem-secret-value -----END PRIVATE KEY-----', 'pem-secret-value'],
    ['长疑似密钥', `diagnostic ${'A'.repeat(96)}`, 'A'.repeat(96)]
  ])('%s 不会进入摘要', (_name, output, secret) => {
    const result = summarize({ exitCode: 1, stderr: output });

    expect(result.summary).not.toContain(secret);
  });

  test('多字节输出按 UTF-8 4KiB 边界截断后才分类', () => {
    const result = summarize({
      exitCode: 1,
      stdout: '你'.repeat(1365),
      stderr: 'AssertionError: this appears after 4KiB'
    });

    expect(result.category).toBe('command_error');
  });

  test('跨 4KiB 边界的敏感内容不会进入摘要', () => {
    const secret = 'cross-boundary-secret-should-not-leak';
    const result = summarize({
      exitCode: 1,
      stderr: `${'x'.repeat(480)}Authorization: Basic ${secret}${'y'.repeat(MAX_FEEDBACK_INPUT_BYTES)}`
    });

    expect(result.summary).not.toContain(secret);
  });
});
