import type { AgentFeedback, AgentContext, LLMClient } from './client.js';

export interface ContextSensitiveMockOptions {
  firstResponse: unknown;
  expectedFeedback: AgentFeedback;
  feedbackResponse: unknown;
  finalResponse: unknown;
}

/**
 * Deterministic test double that proves a second action is conditional on a
 * particular feedback item being present in AgentContext.
 */
export class ContextSensitiveMockLLM implements LLMClient {
  readonly contexts: AgentContext[] = [];
  feedbackMatched = false;
  private calls = 0;

  constructor(private readonly options: ContextSensitiveMockOptions) {}

  async decide(context: AgentContext): Promise<unknown> {
    this.contexts.push(structuredClone(context));
    this.calls += 1;

    if (this.calls === 1) {
      return this.options.firstResponse;
    }
    if (this.calls === 2) {
      this.feedbackMatched = context.recentFeedback.some((feedback) => (
        feedback.category === this.options.expectedFeedback.category
        && feedback.summary === this.options.expectedFeedback.summary
      ));
      if (!this.feedbackMatched) {
        throw new Error('expected verifier feedback was not present in AgentContext');
      }
      return this.options.feedbackResponse;
    }
    if (this.calls === 3) {
      return this.options.finalResponse;
    }
    throw new Error('ContextSensitiveMockLLM response sequence exhausted');
  }
}
