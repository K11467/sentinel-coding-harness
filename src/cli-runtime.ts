import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type LoadedHarnessConfig } from './config/load.js';
import { AgentLoop, type ActionDispatcher, type DispatcherFeedback } from './core/agent-loop.js';
import { FileSessionStore } from './core/file-session-store.js';
import { ToolDispatcher } from './core/tool-dispatcher.js';
import type { ApprovalStateStore } from './core/session-store.js';
import { ActionParser, type Action } from './domain/actions.js';
import { feedbackSummarySchema, sessionStateSchema, type SessionState } from './domain/session.js';
import { FeedbackSummarizer } from './feedback/summarizer.js';
import type { CredentialReader } from './llm/zhizengzeng-responses.js';
import { ZhizengzengResponsesClient } from './llm/zhizengzeng-responses.js';
import type { LLMClient } from './llm/client.js';
import { AuditLog, type AuditRecord } from './observability/audit.js';
import { ApprovalService } from './security/approval.js';
import { PolicyEngine, type PolicyDecision } from './security/policy.js';
import { CommandTools } from './tools/commands.js';
import { WorkspaceTools } from './tools/workspace.js';

export interface RuntimeCommandInput {
  readonly config: LoadedHarnessConfig;
}

export interface RuntimeRunInput extends RuntimeCommandInput {
  readonly task: string;
}

export interface RuntimeSessionInput extends RuntimeCommandInput {
  readonly sessionId: string;
}

export interface RuntimeApprovalInput extends RuntimeSessionInput {
  readonly actionHash: string;
}

export interface ProductionRuntime {
  run(input: RuntimeRunInput): Promise<SessionState>;
  resume(input: RuntimeSessionInput): Promise<SessionState>;
  approve(input: RuntimeApprovalInput): Promise<SessionState>;
  reject(input: RuntimeApprovalInput): Promise<SessionState>;
  inspect(input: RuntimeSessionInput): Promise<SessionState>;
  audit(input: RuntimeSessionInput): Promise<AuditRecord[]>;
}

export interface ProductionRuntimeOptions {
  /** The provider receives this reader unchanged and can retrieve only with get(). */
  readonly credentials: CredentialReader;
  readonly clientFactory?: (input: { credentials: CredentialReader; config: LoadedHarnessConfig }) => LLMClient;
  readonly sessionStoreFactory?: (statePath: string) => ApprovalStateStore;
  readonly auditLogFactory?: (auditPath: string) => AuditLog;
  /** Test seam; production uses ToolDispatcher over the fenced workspace and command tools. */
  readonly dispatcherFactory?: (input: { config: LoadedHarnessConfig; sessionId: string }) => ActionDispatcher;
  readonly sessionIdFactory?: () => string;
  readonly now?: () => Date;
}

class RuntimeOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeOperationError';
  }
}

type RuntimeParts = {
  readonly store: ApprovalStateStore;
  readonly policy: PolicyEngine;
  readonly approval: ApprovalService;
  readonly audit: AuditLog;
  readonly dispatcher: ActionDispatcher;
  readonly loop: AgentLoop;
};

const maxRecentFeedback = 8;

/**
 * Connects the CLI to durable sessions, the strictly validated provider, the
 * policy/approval state machine, and the existing fenced tools. It does not
 * expose a raw credential value and has no non-tokenized command path.
 */
export function createProductionRuntime(options: ProductionRuntimeOptions): ProductionRuntime {
  const clientFactory = options.clientFactory ?? ((input: { credentials: CredentialReader; config: LoadedHarnessConfig }) =>
    new ZhizengzengResponsesClient({ credentials: input.credentials, model: input.config.model }));
  const sessionStoreFactory = options.sessionStoreFactory ?? ((statePath: string) => new FileSessionStore(statePath));
  const auditLogFactory = options.auditLogFactory ?? ((auditPath: string) => new AuditLog(auditPath));
  const sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());

  const partsFor = (config: LoadedHarnessConfig, sessionId: string): RuntimeParts => {
    const sentinelDirectory = join(config.workspaceRoot, '.sentinel');
    const store = sessionStoreFactory(join(sentinelDirectory, 'state.json'));
    const policy = new PolicyEngine(config);
    const approval = new ApprovalService(store, policy, { clock: now });
    const audit = auditLogFactory(join(sentinelDirectory, 'audit.jsonl'));
    const rawDispatcher = options.dispatcherFactory?.({ config, sessionId }) ?? new ToolDispatcher({
      workspace: new WorkspaceTools(config.workspaceRoot),
      commands: new CommandTools({
        allowedCommands: config.allowedCommands,
        workspaceRoot: config.workspaceRoot,
        testCommand: config.testCommand,
      }),
      feedback: new FeedbackSummarizer(),
    });
    const dispatcher = auditedDispatcher(rawDispatcher, audit, sessionId);
    const loop = new AgentLoop({
      config,
      client: clientFactory({ credentials: options.credentials, config }),
      parser: new ActionParser(),
      dispatcher,
      sessions: store,
      policy,
      approval,
      now,
      onPolicyDecision: async ({ sessionId, action, decision }) => {
        await appendPolicyDecision(audit, sessionId, action, decision);
      },
      onStateTransition: async ({ sessionId, from, to, stopReason }) => {
        await appendStateTransition(audit, sessionId, from, to, stopReason);
      },
    });
    return { store, policy, approval, audit, dispatcher, loop };
  };

  return {
    async run({ task, config }): Promise<SessionState> {
      const initial = sessionStateSchema.parse({
        id: sessionIdFactory(),
        status: 'created',
        step: 0,
        task,
        recentActions: [],
        recentFeedback: [],
      });
      const parts = partsFor(config, initial.id);
      return parts.loop.run(initial);
    },

    async resume({ sessionId, config }): Promise<SessionState> {
      const parts = partsFor(config, sessionId);
      const stored = await parts.store.read(sessionId);
      if (stored === undefined) throw new RuntimeOperationError('找不到指定会话。');
      if (stored.session.status !== 'running') {
        throw new RuntimeOperationError('该会话当前不能恢复；请检查审批或终止状态。');
      }
      return parts.loop.run(stored.session);
    },

    async approve({ sessionId, actionHash, config }): Promise<SessionState> {
      const parts = partsFor(config, sessionId);
      const approved = await parts.approval.approve(sessionId, actionHash);
      if (!approved.ok) throw new RuntimeOperationError('批准失败：审批请求不可用或状态已改变。');

      const claimed = await parts.approval.claim(sessionId, actionHash);
      if (!claimed.ok || claimed.action === undefined || claimed.session === undefined) {
        throw new RuntimeOperationError('批准后的动作未能安全领取；不会执行。');
      }

      try {
        // claim() already recomputes PolicyEngine, then this fresh dispatcher repeats
        // the workspace/path fence immediately before the only actual execution.
        await appendStateTransition(parts.audit, sessionId, 'waiting_approval', claimed.session.status);
        await appendPolicyDecision(parts.audit, sessionId, claimed.action, parts.policy.decide(claimed.action));
        const feedback = await parts.dispatcher.dispatch(claimed.action);
        const recorded = feedbackSummarySchema.safeParse({
          ...feedback,
          actionId: claimed.action.id,
          createdAt: now().toISOString(),
        });
        if (!recorded.success) throw new RuntimeOperationError('已批准动作的受控反馈无效；不会继续会话。');

        const resumed = sessionStateSchema.parse({
          ...claimed.session,
          recentFeedback: [...claimed.session.recentFeedback, recorded.data].slice(-maxRecentFeedback),
        });
        await parts.store.save(resumed);
        return await parts.loop.run(resumed);
      } catch {
        return settleClaimFailure(parts, sessionId, claimed.session);
      }
    },

    async reject({ sessionId, actionHash, config }): Promise<SessionState> {
      const parts = partsFor(config, sessionId);
      const rejected = await parts.approval.reject(sessionId, actionHash);
      if (!rejected.ok || rejected.session === undefined) {
        throw new RuntimeOperationError('拒绝失败：审批请求不可用或状态已改变。');
      }
      await appendStateTransition(parts.audit, sessionId, 'waiting_approval', rejected.session.status, rejected.session.stopReason);
      return rejected.session;
    },

    async inspect({ sessionId, config }): Promise<SessionState> {
      const { store } = partsFor(config, sessionId);
      const stored = await store.read(sessionId);
      if (stored === undefined) throw new RuntimeOperationError('找不到指定会话。');
      return stored.session;
    },

    async audit({ sessionId, config }): Promise<AuditRecord[]> {
      const { audit } = partsFor(config, sessionId);
      return (await audit.read()).filter((record) => record.sessionId === sessionId);
    },
  };
}

function auditedDispatcher(dispatcher: ActionDispatcher, audit: AuditLog, sessionId: string): ActionDispatcher {
  return {
    async dispatch(action: Action): Promise<DispatcherFeedback> {
      const feedback = await dispatcher.dispatch(action);
      await audit.append({
        sessionId,
        event: 'tool_result',
        action: auditAction(action),
        tool: {
          kind: action.type,
          ok: feedback.category === 'passed',
          output: feedback.summary,
        },
      });
      return feedback;
    },
  };
}

async function appendPolicyDecision(audit: AuditLog, sessionId: string, action: Action, decision: PolicyDecision): Promise<void> {
  await audit.append({
    sessionId,
    event: 'policy_decision',
    action: auditAction(action),
    policy: {
      effect: decision.effect,
      ruleId: decision.ruleId,
      risk: decision.risk,
      reason: decision.reason,
    },
  });
}

async function appendStateTransition(
  audit: AuditLog,
  sessionId: string,
  from: SessionState['status'],
  to: SessionState['status'],
  stopReason?: SessionState['stopReason'],
): Promise<void> {
  if (from === to) return;
  await audit.append({
    sessionId,
    event: 'state_transition',
    state: { from, to, ...(stopReason === undefined ? {} : { reason: stopReason }) },
  });
}

/** Never leave a claimed approval as running when its post-claim work fails. */
async function settleClaimFailure(parts: RuntimeParts, sessionId: string, claimed: SessionState): Promise<SessionState> {
  const { pendingAction: _pendingAction, stopReason: _stopReason, ...active } = claimed;
  const failed = sessionStateSchema.parse({ ...active, status: 'failed', stopReason: 'tool_error' });
  try {
    await parts.store.save(failed);
  } catch {
    // A storage failure cannot be recovered here; never surface a raw underlying error.
  }
  try {
    await appendStateTransition(parts.audit, sessionId, claimed.status, failed.status, failed.stopReason);
  } catch {
    // Audit is best effort after a failure; persisted state remains authoritative.
  }
  return failed;
}

function auditAction(action: Action): { type: Action['type']; reason: string; path?: string; command?: string; content?: string } {
  switch (action.type) {
    case 'list_files':
      return { type: action.type, reason: action.reason, ...(action.path === undefined ? {} : { path: action.path }) };
    case 'read_file':
      return { type: action.type, reason: action.reason, path: action.path };
    case 'write_file':
      return { type: action.type, reason: action.reason, path: action.path, content: action.content };
    case 'run_command':
      return { type: action.type, reason: action.reason, command: action.command };
    case 'run_tests':
    case 'remember':
    case 'finish':
      return { type: action.type, reason: action.reason };
  }
}
