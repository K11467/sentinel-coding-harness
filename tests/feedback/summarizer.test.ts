import { describe, expect, test } from 'vitest';
import {
  FeedbackSummarizer,
  MAX_FEEDBACK_INPUT_CHARS,
  MAX_FEEDBACK_SUMMARY_CHARS,
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

  test('先截断最多 4KiB 输入，且摘要保持简短', () => {
    const visible = 'AssertionError: expected one value\n';
    const hiddenTail = 'tail-must-not-appear';
    const result = summarize({
      exitCode: 1,
      stderr: visible + 'x'.repeat(MAX_FEEDBACK_INPUT_CHARS) + hiddenTail
    });

    expect(result.category).toBe('assertion_failed');
    expect(result.summary).toContain('AssertionError');
    expect(result.summary).not.toContain(hiddenTail);
    expect(result.summary.length).toBeLessThanOrEqual(MAX_FEEDBACK_SUMMARY_CHARS);
  });

  test('摘要脱敏 Authorization Bearer 与 sk 形式密钥', () => {
    const result = summarize({
      exitCode: 1,
      stderr: 'Authorization: Bearer very-secret-token\nrequest failed with sk-proj-abcDEF1234567890'
    });

    expect(result.summary).toContain('[REDACTED]');
    expect(result.summary).not.toContain('very-secret-token');
    expect(result.summary).not.toContain('sk-proj-abcDEF1234567890');
  });

  test('空输出给出稳定且可操作的摘要', () => {
    expect(summarize({ exitCode: 0 })).toEqual({ category: 'passed', summary: '测试通过。' });
    expect(summarize({ exitCode: 1 })).toEqual({ category: 'command_error', summary: '命令失败（退出码 1）。' });
  });
});
