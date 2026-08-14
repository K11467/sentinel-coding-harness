import { describe, expect, test } from 'vitest';
import type { HarnessConfig } from '../../src/domain/config.js';
import type { SessionState } from '../../src/domain/session.js';
import { ActionParser, type Action } from '../../src/domain/actions.js';
import { AgentLoop, InMemorySessionStore, type ActionDispatcher } from '../../src/core/agent-loop.js';
import { ScriptedMockLLM } from '../../src/llm/scripted-mock.js';

const clock = () => new Date('2026-08-14T00:00:00.000Z');

function config(maxSteps = 6): HarnessConfig {
  return {
    workspaceRoot: '/workspace/project',
    model: 'mock-model',
    maxSteps,
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
    task: '完成测试任务',
    recentActions: [],
    recentFeedback: []
  };
}

function parser(): ActionParser {
  let nextId = 0;
  return new ActionParser(() => `action-${++nextId}`);
}

function dispatcher(result: { category: 'passed' | 'assertion_failed' | 'type_error' | 'command_error' | 'timeout'; summary: string } = {
  category: 'passed',
  summary: '工具已完成'
}): ActionDispatcher & { actions: Action[] } {
  return {
    actions: [],
    async dispatch(action) {
      this.actions.push(action);
      return result;
    }
  };
}

function createLoop(options: {
  responses: unknown[];
  maxSteps?: number;
  actionDispatcher?: ActionDispatcher;
  store?: InMemorySessionStore;
}) {
  const store = options.store ?? new InMemorySessionStore();
  const client = new ScriptedMockLLM(options.responses);
  const actionDispatcher = options.actionDispatcher ?? dispatcher();
  const loop = new AgentLoop({
    config: config(options.maxSteps),
    client,
    parser: parser(),
    dispatcher: actionDispatcher,
    sessions: store,
    now: clock
  });

  return { loop, store, client, actionDispatcher: actionDispatcher as ActionDispatcher & { actions: Action[] } };
}

describe('AgentLoop', () => {
  test('finish 让 created/running 会话完成、保存状态且不调用 dispatcher', async () => {
    const { loop, store, actionDispatcher } = createLoop({
      responses: [{ type: 'finish', reason: '任务已完成', summary: '完成摘要' }]
    });

    const result = await loop.run(createdSession());

    expect(result).toMatchObject({ status: 'completed', stopReason: 'finished', step: 1 });
    expect(actionDispatcher.actions).toEqual([]);
    expect(store.saved.map((session) => session.status)).toEqual(['running', 'completed']);
    expect(store.saved.at(-1)).toEqual(result);
  });

  test('达到 config.maxSteps 后以 max_steps 停止且不会请求额外 action', async () => {
    const { loop, client, actionDispatcher } = createLoop({
      maxSteps: 1,
      responses: [
        { type: 'remember', reason: '先记录', note: '第一步' },
        { type: 'finish', reason: '不应请求', summary: '不应执行' }
      ]
    });

    const result = await loop.run(createdSession());

    expect(result).toMatchObject({ status: 'stopped', stopReason: 'max_steps', step: 1 });
    expect(client.contexts).toHaveLength(1);
    expect(actionDispatcher.actions).toHaveLength(1);
  });

  test('parser 拒绝 action 时安全停止且不调用 dispatcher', async () => {
    const { loop, actionDispatcher } = createLoop({
      responses: [
        { type: 'read_file', reason: '缺少 path' },
        { type: 'read_file', reason: '仍缺少 path' }
      ]
    });

    const result = await loop.run(createdSession());

    expect(result).toMatchObject({ status: 'stopped', stopReason: 'invalid_action', step: 0 });
    expect(actionDispatcher.actions).toEqual([]);
  });

  test('dispatcher 的确定性反馈进入下一轮 AgentContext', async () => {
    const { loop, client } = createLoop({
      responses: [
        { type: 'remember', reason: '记录信息', note: '已知失败' },
        { type: 'finish', reason: '完成任务', summary: '已完成' }
      ],
      actionDispatcher: dispatcher({ category: 'assertion_failed', summary: '测试断言失败：期望 true' })
    });

    await loop.run(createdSession());

    expect(client.contexts).toHaveLength(2);
    expect(client.contexts[1]!.recentFeedback).toEqual([
      { category: 'assertion_failed', summary: '测试断言失败：期望 true' }
    ]);
  });

  test.each([
    ['provider', () => ({ decide: async () => { throw new Error('provider secret details'); } }), 'failed', 'provider_error'],
    ['dispatcher', () => dispatcherWithError(), 'failed', 'tool_error']
  ])('%s 异常映射为规范 session 终态且不泄露原始异常', async (_name, createFailingDependency, status, stopReason) => {
    const store = new InMemorySessionStore();
    const failing = createFailingDependency();
    const loop = new AgentLoop({
      config: config(),
      client: 'decide' in failing
        ? failing
        : new ScriptedMockLLM([{ type: 'remember', reason: '调用工具', note: 'x' }]),
      parser: parser(),
      dispatcher: 'dispatch' in failing ? failing : dispatcher(),
      sessions: store,
      now: clock
    });

    const result = await loop.run(createdSession());

    expect(result).toMatchObject({ status, stopReason });
    expect(JSON.stringify(result)).not.toContain('secret details');
  });

  test('action 与 feedback 均只保留最近 8 条', async () => {
    const responses: unknown[] = Array.from({ length: 10 }, (_, index) => ({
      type: 'remember', reason: `记录第 ${index + 1} 步`, note: `note-${index + 1}`
    }));
    responses.push({ type: 'finish', reason: '结束', summary: '完成' });
    const { loop } = createLoop({ responses, maxSteps: 12 });

    const result = await loop.run(createdSession());

    expect(result).toMatchObject({ status: 'completed', stopReason: 'finished', step: 11 });
    expect(result.recentActions).toHaveLength(8);
    expect(result.recentFeedback).toHaveLength(8);
    expect(result.recentActions[0]!.id).toBe('action-4');
    expect(result.recentFeedback[0]!.actionId).toBe('action-3');
  });
});

function dispatcherWithError(): ActionDispatcher {
  return {
    async dispatch() {
      throw new Error('dispatcher secret details');
    }
  };
}
