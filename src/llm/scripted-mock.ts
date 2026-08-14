import type { AgentContext, LLMClient } from './client.js';

export class ScriptedMockLLM implements LLMClient {
  readonly contexts: AgentContext[] = [];
  private readonly responses: unknown[];

  constructor(responses: readonly unknown[]) {
    this.responses = [...responses];
  }

  async decide(context: AgentContext): Promise<unknown> {
    this.contexts.push(structuredClone(context));

    if (this.responses.length === 0) {
      throw new Error('ScriptedMockLLM response sequence exhausted');
    }

    return this.responses.shift();
  }
}
