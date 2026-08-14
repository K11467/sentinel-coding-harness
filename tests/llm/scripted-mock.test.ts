import { describe, expect, test } from 'vitest';
import type { AgentContext, LLMClient } from '../../src/llm/client.js';
import { ScriptedMockLLM } from '../../src/llm/scripted-mock.js';

function createContext(): AgentContext {
  return {
    task: '修复类型错误',
    workspace: '/workspace/project',
    availableActions: ['read_file', 'run_tests'],
    recentFeedback: [{ category: 'type_error', summary: 'src/index.ts: 类型不匹配' }],
    notes: ['先读取报错文件'],
    recentSteps: [{ action: 'read_file', summary: '已读取 src/index.ts' }]
  };
}

describe('ScriptedMockLLM', () => {
  test('按预设顺序异步返回输出', async () => {
    const client = new ScriptedMockLLM([{ type: 'read_file' }, { type: 'run_tests' }]);
    const context = createContext();

    await expect(client.decide(context)).resolves.toEqual({ type: 'read_file' });
    await expect(client.decide(context)).resolves.toEqual({ type: 'run_tests' });
  });

  test('记录每次 context 的独立快照，不受调用后 mutation 影响', async () => {
    const client = new ScriptedMockLLM([null]);
    const context = createContext();

    await client.decide(context);
    context.task = '已变更的任务';
    context.availableActions.push('finish');
    context.recentFeedback[0]!.summary = '已变更的反馈';
    context.notes.push('已变更的笔记');
    context.recentSteps[0]!.summary = '已变更的步骤';

    expect(client.contexts).toEqual([createContext()]);
    expect(client.contexts[0]).not.toBe(context);
    expect(client.contexts[0]!.recentFeedback[0]).not.toBe(context.recentFeedback[0]);
  });

  test('满足异步 LLMClient 形状', async () => {
    const client: LLMClient = new ScriptedMockLLM(['预设输出']);
    const result = client.decide(createContext());

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe('预设输出');
  });

  test('预设序列耗尽时返回可断言错误', async () => {
    const client = new ScriptedMockLLM([]);

    await expect(client.decide(createContext())).rejects.toThrow('ScriptedMockLLM response sequence exhausted');
  });
});
