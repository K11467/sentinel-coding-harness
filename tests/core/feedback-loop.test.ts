import { describe, expect, test } from 'vitest';
import { AgentLoop, InMemorySessionStore, type ActionDispatcher } from '../../src/core/agent-loop.js';
import { ToolDispatcher } from '../../src/core/tool-dispatcher.js';
import { ActionParser, type Action } from '../../src/domain/actions.js';
import type { HarnessConfig } from '../../src/domain/config.js';
import type { SessionState } from '../../src/domain/session.js';
import { ScriptedMockLLM } from '../../src/llm/scripted-mock.js';
import { ApprovalService } from '../../src/security/approval.js';
import { PolicyEngine } from '../../src/security/policy.js';

const clock = () => new Date('2026-08-14T00:00:00.000Z');

function config(): HarnessConfig {
  return {
    workspaceRoot: '/workspace/project',
    model: 'mock-model',
    maxSteps: 6,
    maxCostCny: 70,
    allowedCommands: [],
    policyRules: []
  };
}

function createdSession(): SessionState {
  return {
    id: 'session-1',
    status: 'created',
    step: 0,
    task: '受控测试任务',
    recentActions: [],
    recentFeedback: []
  };
}

function parser(): ActionParser {
  let nextId = 0;
  return new ActionParser(() => `action-${++nextId}`);
}

function trackingDispatcher(): ActionDispatcher & { actions: Action[] } {
  return {
    actions: [],
    async dispatch(action) {
      this.actions.push(action);
      return { category: 'passed', summary: '已执行' };
    }
  };
}

function createLoop(options: {
  responses: unknown[];
  dispatcher: ActionDispatcher;
  policy?: PolicyEngine;
  approval?: ApprovalService;
  store?: InMemorySessionStore;
}) {
  const store = options.store ?? new InMemorySessionStore();
  const client = new ScriptedMockLLM(options.responses);
  const loop = new AgentLoop({
    config: config(),
    client,
    parser: parser(),
    dispatcher: options.dispatcher,
    sessions: store,
    now: clock,
    policy: options.policy,
    approval: options.approval
  });
  return { loop, store, client };
}

describe('AgentLoop governance and feedback integration', () => {
  test('a verifier-backed failed test is fed back before the mock selects a different action', async () => {
    let testCalls = 0;
    const dispatcher = new ToolDispatcher({
      workspace: {
        async list() { return { ok: true as const, kind: 'list' as const, path: '.', entries: [] }; },
        async read(path: string) { return { ok: true as const, kind: 'read' as const, path, content: '' }; },
        async write(path: string, content: string) { return { ok: true as const, kind: 'write' as const, path, bytesWritten: content.length }; }
      },
      commands: {
        async runCommand() { return { ok: true as const, kind: 'command' as const, exitCode: 0 as const, output: '', truncated: false }; },
        async runTests() {
          testCalls += 1;
          return {
            ok: false as const,
            kind: 'tests' as const,
            exitCode: 1,
            output: 'AssertionError: expected true to be false',
            truncated: false,
            errorCode: 'nonzero_exit' as const
          };
        }
      }
    });
    const { loop, client } = createLoop({
      dispatcher,
      responses: [
        { type: 'run_tests', reason: '验证当前方案' },
        { type: 'remember', reason: '根据失败改选', note: '先检查断言' },
        { type: 'finish', reason: '完成', summary: '已处理' }
      ]
    });

    const result = await loop.run(createdSession());

    expect(result).toMatchObject({ status: 'completed', stopReason: 'finished', step: 3 });
    expect(result.recentActions.map((item) => item.type)).toEqual(['run_tests', 'remember', 'finish']);
    expect(testCalls).toBe(1);
    expect(client.contexts[1]!.recentFeedback).toEqual([{ category: 'assertion_failed', summary: '断言失败（退出码 1）。' }]);
    expect(client.contexts[1]!.recentSteps.at(-1)).toEqual({ action: 'run_tests', summary: '验证当前方案' });
  });

  test('repeated action stops safely before the second dispatch', async () => {
    const dispatcher = trackingDispatcher();
    const { loop, client } = createLoop({
      dispatcher,
      responses: [
        { type: 'remember', reason: '记录约定', note: 'same note' },
        { type: 'remember', reason: '记录约定', note: 'same note' },
        { type: 'finish', reason: '不应请求', summary: '不应执行' }
      ]
    });

    const result = await loop.run(createdSession());

    expect(result).toMatchObject({ status: 'stopped', stopReason: 'repeated_action', step: 2 });
    expect(dispatcher.actions).toHaveLength(1);
    expect(client.contexts).toHaveLength(2);
  });

  test('allows exactly one format repair request, then stops without dispatching', async () => {
    const dispatcher = trackingDispatcher();
    const { loop, client } = createLoop({
      dispatcher,
      responses: [
        { type: 'read_file', reason: '缺少路径' },
        { type: 'run_command', reason: '缺少参数', command: 'node' },
        { type: 'finish', reason: '不应请求', summary: '不应执行' }
      ]
    });

    const result = await loop.run(createdSession());

    expect(result).toMatchObject({ status: 'stopped', stopReason: 'invalid_action', step: 0 });
    expect(dispatcher.actions).toEqual([]);
    expect(client.contexts).toHaveLength(2);
    expect(client.contexts[1]!.recentFeedback).toContainEqual({
      category: 'command_error',
      summary: '动作格式无效，请只返回符合协议的 JSON action。'
    });
  });

  test('deny never dispatches, while require_approval delegates pending persistence to T07', async () => {
    const deniedDispatcher = trackingDispatcher();
    const denied = createLoop({
      dispatcher: deniedDispatcher,
      responses: [{ type: 'run_command', reason: '递归删除', command: 'rm', args: ['-rf', 'tmp'] }]
    });

    const deniedResult = await denied.loop.run(createdSession());

    expect(deniedResult).toMatchObject({ status: 'blocked', stopReason: 'policy_denied', step: 1 });
    expect(deniedDispatcher.actions).toEqual([]);

    const store = new InMemorySessionStore();
    const policy = new PolicyEngine(config());
    const approval = new ApprovalService(store, policy, { clock });
    const approvalDispatcher = trackingDispatcher();
    const awaiting = createLoop({
      store,
      policy,
      approval,
      dispatcher: approvalDispatcher,
      responses: [{ type: 'write_file', reason: '修改元数据', path: 'package.json', content: '{}' }]
    });

    const awaitingResult = await awaiting.loop.run(createdSession());

    expect(awaitingResult).toMatchObject({ status: 'waiting_approval', step: 1, pendingAction: { action: { type: 'write_file' } } });
    expect(approvalDispatcher.actions).toEqual([]);
    expect(await approval.inspect('session-1', awaitingResult.pendingAction!.actionHash)).toMatchObject({ status: 'pending' });
  });
});
