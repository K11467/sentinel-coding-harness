import type { FeedbackSummary } from '../domain/session.js';

/** The only command data accepted by the feedback classifier. */
export interface ControlledTestResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

export type SummarizedFeedback = Pick<FeedbackSummary, 'category' | 'summary'>;

export const MAX_FEEDBACK_INPUT_BYTES = 4 * 1024;

const typeErrorPattern = /\b(?:error\s+TS\d+|TypeError)\b/i;
const assertionFailurePattern = /\b(?:AssertionError|assertion failed)\b/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Converts a captured, already-controlled test command result into a small,
 * safe feedback item. Captured output is used only for local classification;
 * no stdout or stderr text is copied into the returned summary.
 */
export class FeedbackSummarizer {
  summarize(result: ControlledTestResult): SummarizedFeedback {
    const category = this.categorize(result);
    return {
      category,
      summary: `${summaryPrefix(category)}（退出码 ${result.exitCode}）。`
    };
  }

  private categorize(result: ControlledTestResult): FeedbackSummary['category'] {
    if (result.timedOut) {
      return 'timeout';
    }
    if (result.exitCode === 0) {
      return 'passed';
    }

    const output = this.classificationOutput(result);
    if (typeErrorPattern.test(output)) {
      return 'type_error';
    }
    if (assertionFailurePattern.test(output)) {
      return 'assertion_failed';
    }
    return 'command_error';
  }

  private classificationOutput(result: ControlledTestResult): string {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const bytes = encoder.encode(output);
    return bytes.byteLength <= MAX_FEEDBACK_INPUT_BYTES
      ? output
      : decoder.decode(bytes.subarray(0, MAX_FEEDBACK_INPUT_BYTES));
  }
}

function summaryPrefix(category: FeedbackSummary['category']): string {
  switch (category) {
    case 'passed':
      return '测试通过';
    case 'assertion_failed':
      return '断言失败';
    case 'type_error':
      return '类型错误';
    case 'command_error':
      return '命令失败';
    case 'timeout':
      return '测试超时';
  }
}
