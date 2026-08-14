import type { FeedbackSummary } from '../domain/session.js';

/** The only command data accepted by the feedback classifier. */
export interface ControlledTestResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

export type SummarizedFeedback = Pick<FeedbackSummary, 'category' | 'summary'>;

export const MAX_FEEDBACK_INPUT_CHARS = 4 * 1024;
export const MAX_FEEDBACK_SUMMARY_CHARS = 512;

const typeErrorPattern = /\b(?:error\s+TS\d+|TypeError)\b/i;
const assertionFailurePattern = /\b(?:AssertionError|assertion failed)\b/i;

/**
 * Converts a captured, already-controlled test command result into a small,
 * safe feedback item. It never executes a command or retains its raw output.
 */
export class FeedbackSummarizer {
  summarize(result: ControlledTestResult): SummarizedFeedback {
    const category = this.categorize(result);
    if (category === 'passed') {
      return { category, summary: '测试通过。' };
    }

    const details = compact(this.safeOutput(result));
    if (details.length === 0) {
      return {
        category,
        summary: category === 'timeout'
          ? '测试超时。'
          : `命令失败（退出码 ${result.exitCode}）。`
      };
    }

    return {
      category,
      summary: limit(`${summaryPrefix(category)}${details}`, MAX_FEEDBACK_SUMMARY_CHARS)
    };
  }

  private categorize(result: ControlledTestResult): FeedbackSummary['category'] {
    if (result.timedOut) {
      return 'timeout';
    }
    if (result.exitCode === 0) {
      return 'passed';
    }

    const output = this.safeOutput(result);
    if (typeErrorPattern.test(output)) {
      return 'type_error';
    }
    if (assertionFailurePattern.test(output)) {
      return 'assertion_failed';
    }
    return 'command_error';
  }

  private safeOutput(result: ControlledTestResult): string {
    return redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(0, MAX_FEEDBACK_INPUT_CHARS));
  }
}

function redact(text: string): string {
  return text
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]');
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function limit(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function summaryPrefix(category: Exclude<FeedbackSummary['category'], 'passed'>): string {
  switch (category) {
    case 'assertion_failed':
      return '断言失败：';
    case 'type_error':
      return '类型错误：';
    case 'command_error':
      return '命令失败：';
    case 'timeout':
      return '测试超时：';
  }
}
