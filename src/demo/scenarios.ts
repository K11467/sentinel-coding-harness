import { AgentLoop, InMemorySessionStore, type ActionDispatcher } from '../core/agent-loop.js';
import { ToolDispatcher } from '../core/tool-dispatcher.js';
import type { Action } from '../domain/actions.js';
import { ActionParser } from '../domain/actions.js';
import type { HarnessConfig } from '../domain/config.js';
import type { SessionState } from '../domain/session.js';
import { ContextSensitiveMockLLM } from '../llm/context-sensitive-mock.js';
import { ScriptedMockLLM } from '../llm/scripted-mock.js';
import { ApprovalService } from '../security/approval.js';
import { PolicyEngine } from '../security/policy.js';

const demoTime = new Date('2026-08-14T00:00:00.000Z');

export interface DangerousActionScenario {
  name: 'dangerous-action';
  status: 'blocked';
  stopReason: 'policy_denied';
  dispatchedActions: 0;
}

export interface FeedbackAdaptationScenario {
  name: 'feedback-adaptation';
  status: 'completed';
  firstAction: 'run_tests';
  nextAction: 'remember';
  feedbackCategory: 'assertion_failed';
  feedbackObserved: true;
}

export interface ApprovalOnceScenario {
  name: 'approval-once';
  waitingStatus: 'waiting_approval';
  resumedStatus: 'running';
  claimedAction: 'write_file';
  approvalStatus: 'consumed';
  replayError: 'approval_consumed';
}

export type MechanismScenario = DangerousActionScenario | FeedbackAdaptationScenario | ApprovalOnceScenario;

/** Stable, side-effect-free result for the later CLI demo adapter. */
export interface MechanismScenarioReport {
  passed: true;
  scenarios: [DangerousActionScenario, FeedbackAdaptationScenario, ApprovalOnceScenario];
}

/**
 * Demonstrates that an explicitly dangerous command is stopped by policy before
 * an ActionDispatcher can receive it. No command process is created.
 */
export async function runDangerousActionScenario(): Promise<DangerousActionScenario> {
  const store = new InMemorySessionStore();
  const dispatcher = new TrackingDispatcher();
  const loop = new AgentLoop({
    config: demoConfig(),
    client: new ScriptedMockLLM([{
      type: 'run_command',
      reason: '尝试递归删除临时目录',
      command: 'rm',
      args: ['-rf', 'tmp']
    }]),
    parser: parser('dangerous'),
    dispatcher,
    sessions: store,
    now: () => demoTime
  });

  const session = await loop.run(createdSession('demo-dangerous'));
  requireInvariant(session.status === 'blocked' && session.stopReason === 'policy_denied', '危险动作未被策略阻止。');
  requireInvariant(dispatcher.actions.length === 0, '危险动作在策略拒绝后仍被分发。');

  return {
    name: 'dangerous-action',
    status: 'blocked',
    stopReason: 'policy_denied',
    dispatchedActions: 0
  };
}

/**
 * Runs a controlled fake test failure through ToolDispatcher. The mock LLM can
 * produce its second action only when the summarized verifier feedback reaches
 * AgentContext; no test command or workspace operation is executed.
 */
export async function runFeedbackAdaptationScenario(): Promise<FeedbackAdaptationScenario> {
  let testCalls = 0;
  const dispatcher = new ToolDispatcher({
    workspace: inertWorkspace(),
    commands: {
      async runCommand() {
        return { ok: true as const, kind: 'command' as const, exitCode: 0 as const, output: '', truncated: false };
      },
      async runTests() {
        testCalls += 1;
        return {
          ok: false as const,
          kind: 'tests' as const,
          exitCode: 1,
          output: 'AssertionError: expected controlled fixture to pass',
          truncated: false,
          errorCode: 'nonzero_exit' as const
        };
      }
    }
  });
  const client = new ContextSensitiveMockLLM({
    firstResponse: { type: 'run_tests', reason: '验证受控演示' },
    expectedFeedback: { category: 'assertion_failed', summary: '断言失败（退出码 1）。' },
    feedbackResponse: { type: 'remember', reason: '依据失败摘要调整下一步', note: '先检查失败断言' },
    finalResponse: { type: 'finish', reason: '演示完成', summary: '反馈已被消费' }
  });
  const loop = new AgentLoop({
    config: demoConfig(),
    client,
    parser: parser('feedback'),
    dispatcher,
    sessions: new InMemorySessionStore(),
    now: () => demoTime
  });

  const session = await loop.run(createdSession('demo-feedback'));
  const actionTypes = session.recentActions.map((action) => action.type);
  requireInvariant(session.status === 'completed' && session.stopReason === 'finished', '反馈演示未正常结束。');
  requireInvariant(testCalls === 1, '受控测试替身调用次数不正确。');
  requireInvariant(client.feedbackMatched, '上下文敏感 mock 未收到失败反馈。');
  requireInvariant(actionTypes.join(',') === 'run_tests,remember,finish', '失败反馈未导致下一动作改变。');

  return {
    name: 'feedback-adaptation',
    status: 'completed',
    firstAction: 'run_tests',
    nextAction: 'remember',
    feedbackCategory: 'assertion_failed',
    feedbackObserved: true
  };
}

/**
 * Exercises the T07 state machine directly: request persists the pending
 * action, approve authorizes it, and claim consumes it exactly once. Claim
 * returns an action for a future CLI; it never dispatches or writes a file.
 */
export async function runApprovalOnceScenario(): Promise<ApprovalOnceScenario> {
  const store = new InMemorySessionStore();
  const policy = new PolicyEngine(demoConfig());
  const service = new ApprovalService(store, policy, { clock: () => demoTime });
  const initial = runningSession('demo-approval');
  const action = parseAction(parser('approval'), {
    type: 'write_file',
    reason: '修改受控元数据',
    path: 'package.json',
    content: '{"private":true}'
  });
  await store.save(initial);

  const decision = policy.decide(action);
  const requested = await service.request(initial.id, action, decision);
  requireInvariant(requested.ok, '需要审批的动作未能创建待办记录。');
  const waiting = store.get(initial.id);
  requireInvariant(waiting?.status === 'waiting_approval' && waiting.pendingAction?.actionHash === decision.actionHash, '待办动作没有与审批记录绑定。');

  const approved = await service.approve(initial.id, decision.actionHash);
  requireInvariant(approved.ok && approved.record.status === 'approved', '待办动作未被批准。');
  const claimed = await service.claim(initial.id, decision.actionHash);
  requireInvariant(claimed.ok && claimed.record.status === 'consumed' && claimed.action?.type === 'write_file', '批准动作未能恢复。');
  const replay = await service.claim(initial.id, decision.actionHash);
  requireInvariant(!replay.ok && replay.error.code === 'approval_consumed', '已消费审批被重复恢复。');
  const resumed = store.get(initial.id);
  requireInvariant(resumed?.status === 'running' && resumed.pendingAction === undefined, '审批消费后会话状态不正确。');

  return {
    name: 'approval-once',
    waitingStatus: 'waiting_approval',
    resumedStatus: 'running',
    claimedAction: 'write_file',
    approvalStatus: 'consumed',
    replayError: 'approval_consumed'
  };
}

/** Run all deterministic mechanisms in a fixed order for a future CLI adapter. */
export async function runMechanismScenarios(): Promise<MechanismScenarioReport> {
  return {
    passed: true,
    scenarios: [
      await runDangerousActionScenario(),
      await runFeedbackAdaptationScenario(),
      await runApprovalOnceScenario()
    ]
  };
}

class TrackingDispatcher implements ActionDispatcher {
  readonly actions: Action[] = [];

  async dispatch(action: Action): Promise<{ category: 'passed'; summary: string }> {
    this.actions.push(structuredClone(action));
    return { category: 'passed', summary: '不应执行危险动作。' };
  }
}

function demoConfig(): HarnessConfig {
  return {
    workspaceRoot: '/demo/workspace',
    model: 'deterministic-demo',
    maxSteps: 4,
    maxCostCny: 1,
    allowedCommands: [],
    policyRules: []
  };
}

function createdSession(id: string): SessionState {
  return {
    id,
    status: 'created',
    step: 0,
    task: '运行确定性安全机制演示',
    recentActions: [],
    recentFeedback: []
  };
}

function runningSession(id: string): SessionState {
  return { ...createdSession(id), status: 'running' };
}

function parser(prefix: string): ActionParser {
  let actionNumber = 0;
  return new ActionParser(() => `${prefix}-action-${++actionNumber}`);
}

function parseAction(parser: ActionParser, input: unknown): Action {
  const parsed = parser.parse(input);
  if (!parsed.ok) {
    throw new Error(`演示 action 无效：${parsed.error.message}`);
  }
  return parsed.action;
}

function inertWorkspace() {
  return {
    async list(path = '.') {
      return { ok: true as const, kind: 'list' as const, path, entries: [] };
    },
    async read(path: string) {
      return { ok: true as const, kind: 'read' as const, path, content: '' };
    },
    async write(path: string, content: string) {
      return { ok: true as const, kind: 'write' as const, path, bytesWritten: content.length };
    }
  };
}

function requireInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
