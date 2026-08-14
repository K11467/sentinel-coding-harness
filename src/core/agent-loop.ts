import type { Action } from '../domain/actions.js';
import { ActionParser } from '../domain/actions.js';
import type { HarnessConfig } from '../domain/config.js';
import {
  feedbackSummarySchema,
  sessionStateSchema,
  summarizeAction,
  type FeedbackSummary,
  type SessionState,
  type SessionStatus,
  type StopReason
} from '../domain/session.js';
import type { AgentContext, LLMClient } from '../llm/client.js';
import { InMemorySessionStore, type SessionStore } from './session-store.js';

const availableActions: AgentContext['availableActions'] = [
  'list_files',
  'read_file',
  'write_file',
  'run_command',
  'run_tests',
  'remember',
  'finish'
];

const maxRecentItems = 8;

export interface DispatcherFeedback {
  category: FeedbackSummary['category'];
  summary: string;
}

export interface ActionDispatcher {
  dispatch(action: Action): Promise<DispatcherFeedback>;
}

export interface AgentLoopOptions {
  config: HarnessConfig;
  client: LLMClient;
  parser: ActionParser;
  dispatcher: ActionDispatcher;
  sessions: SessionStore;
  now?: () => Date;
}

export class AgentLoop {
  private readonly now: () => Date;

  constructor(private readonly options: AgentLoopOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async run(initial: SessionState): Promise<SessionState> {
    let session = sessionStateSchema.parse(structuredClone(initial));

    if (session.status === 'created') {
      session = this.toRunning(session);
      await this.options.sessions.save(session);
    }

    while (session.status === 'running') {
      if (session.step >= this.options.config.maxSteps) {
        return this.stop(session, 'stopped', 'max_steps');
      }

      let response: unknown;
      try {
        response = await this.options.client.decide(this.createContext(session));
      } catch {
        return this.stop(session, 'failed', 'provider_error');
      }

      const parsed = this.options.parser.parse(response);
      if (!parsed.ok) {
        return this.stop(session, 'stopped', 'invalid_action');
      }

      const action = parsed.action;
      session = this.recordAction(session, action);

      if (action.type === 'finish') {
        return this.stop(session, 'completed', 'finished');
      }

      let feedback: DispatcherFeedback;
      try {
        feedback = await this.options.dispatcher.dispatch(action);
      } catch {
        return this.stop(session, 'failed', 'tool_error');
      }

      const recordedFeedback = feedbackSummarySchema.safeParse({
        ...feedback,
        actionId: action.id,
        createdAt: this.now().toISOString()
      });
      if (!recordedFeedback.success) {
        return this.stop(session, 'failed', 'tool_error');
      }

      session = {
        ...session,
        recentFeedback: keepRecent([...session.recentFeedback, recordedFeedback.data])
      };
      sessionStateSchema.parse(session);
      await this.options.sessions.save(session);
    }

    return session;
  }

  private createContext(session: SessionState): AgentContext {
    return {
      task: session.task,
      workspace: this.options.config.workspaceRoot,
      availableActions: [...availableActions],
      recentFeedback: session.recentFeedback.map(({ category, summary }) => ({ category, summary })),
      notes: [],
      recentSteps: session.recentActions.map(({ type, reason }) => ({ action: type, summary: reason }))
    };
  }

  private recordAction(session: SessionState, action: Action): SessionState {
    const next = {
      ...session,
      step: session.step + 1,
      recentActions: keepRecent([...session.recentActions, summarizeAction(action, this.now().toISOString())])
    };
    return sessionStateSchema.parse(next);
  }

  private toRunning(session: SessionState): SessionState {
    const { pendingAction: _pendingAction, stopReason: _stopReason, ...active } = session;
    return sessionStateSchema.parse({ ...active, status: 'running' });
  }

  private async stop(session: SessionState, status: SessionStatus, stopReason: StopReason): Promise<SessionState> {
    const { pendingAction: _pendingAction, stopReason: _previousReason, ...terminal } = session;
    const next = sessionStateSchema.parse({ ...terminal, status, stopReason });
    await this.options.sessions.save(next);
    return next;
  }
}

function keepRecent<T>(items: T[]): T[] {
  return items.slice(-maxRecentItems);
}

export { InMemorySessionStore } from './session-store.js';
