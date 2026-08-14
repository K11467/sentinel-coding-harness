import type { ActionType } from '../domain/actions.js';

export interface AgentFeedback {
  category: string;
  summary: string;
}

export interface AgentStep {
  action: string;
  summary: string;
}

export interface AgentContext {
  task: string;
  workspace: string;
  availableActions: ActionType[];
  recentFeedback: AgentFeedback[];
  notes: string[];
  recentSteps: AgentStep[];
}

export interface LLMClient {
  decide(context: AgentContext): Promise<unknown>;
}
