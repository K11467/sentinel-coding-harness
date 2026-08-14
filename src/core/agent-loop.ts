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
import { hashAction, PolicyEngine, type PolicyDecision } from '../security/policy.js';
import type { ApprovalService } from '../security/approval.js';
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
  policy?: PolicyEngine;
  /** Optional until CLI wiring exists; missing approval infrastructure blocks safely. */
  approval?: ApprovalService;
  /** Durable observers may record a redacted policy decision before dispatch. */
  onPolicyDecision?: (input: { sessionId: string; action: Action; decision: PolicyDecision }) => Promise<void>;
}

export class AgentLoop {
  private readonly now: () => Date;
  private readonly policy: PolicyEngine;

  constructor(private readonly options: AgentLoopOptions) {
    this.now = options.now ?? (() => new Date());
    this.policy = options.policy ?? new PolicyEngine(options.config);
  }

  async run(initial: SessionState): Promise<SessionState> {
    let session = sessionStateSchema.parse(structuredClone(initial));
    let previousActionFingerprint: string | undefined;

    if (session.status === 'created') {
      session = this.toRunning(session);
      await this.options.sessions.save(session);
    }

    while (session.status === 'running') {
      if (session.step >= this.options.config.maxSteps) {
        return this.stop(session, 'stopped', 'max_steps');
      }

      const action = await this.requestActionWithOneRepair(session);
      if (action === 'provider_error') {
        return this.stop(session, 'failed', 'provider_error');
      }
      if (action === undefined) {
        return this.stop(session, 'stopped', 'invalid_action');
      }

      const actionFingerprint = fingerprint(action);
      session = this.recordAction(session, action);

      if (previousActionFingerprint === actionFingerprint) {
        return this.stop(session, 'stopped', 'repeated_action');
      }
      previousActionFingerprint = actionFingerprint;

      const decision = this.policy.decide(action);
      await this.options.onPolicyDecision?.({ sessionId: session.id, action, decision });
      if (decision.effect === 'deny') {
        return this.stop(session, 'blocked', 'policy_denied');
      }
      if (decision.effect === 'require_approval') {
        if (this.options.approval === undefined) {
          return this.stop(session, 'blocked', 'policy_denied');
        }
        try {
          await this.options.sessions.save(session);
          const requested = await this.options.approval.request(session.id, action, decision);
          if (!requested.ok || requested.session === undefined) {
            return this.stop(session, 'blocked', 'policy_denied');
          }
          return requested.session;
        } catch {
          return this.stop(session, 'blocked', 'policy_denied');
        }
      }

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

  private async requestActionWithOneRepair(session: SessionState): Promise<Action | 'provider_error' | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: unknown;
      try {
        response = await this.options.client.decide(this.createContext(
          session,
          attempt === 0 ? [] : [{ category: 'command_error', summary: '动作格式无效，请只返回符合协议的 JSON action。' }]
        ));
      } catch {
        return 'provider_error';
      }
      const parsed = this.options.parser.parse(response);
      if (parsed.ok) {
        return parsed.action;
      }
    }
    return undefined;
  }

  private createContext(session: SessionState, transientFeedback: AgentContext['recentFeedback'] = []): AgentContext {
    return {
      task: session.task,
      workspace: this.options.config.workspaceRoot,
      availableActions: [...availableActions],
      recentFeedback: [
        ...session.recentFeedback.map(({ category, summary }) => ({ category, summary })),
        ...transientFeedback.map(({ category, summary }) => ({ category, summary }))
      ],
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

/** Parser IDs are intentionally excluded so the same requested operation cannot spin forever. */
function fingerprint(action: Action): string {
  const { id: _id, ...envelope } = action;
  return hashAction(envelope);
}

export { InMemorySessionStore } from './session-store.js';
