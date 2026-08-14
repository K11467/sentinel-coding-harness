import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createProductionRuntime, type ProductionRuntimeOptions } from '../../src/cli-runtime.js';
import type { LoadedHarnessConfig } from '../../src/config/load.js';
import { ScriptedMockLLM } from '../../src/llm/scripted-mock.js';
import { AuditLog } from '../../src/observability/audit.js';

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-production-runtime-'));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

function config(workspaceRoot: string): LoadedHarnessConfig {
  return {
    workspaceRoot,
    model: 'mock-provider',
    maxSteps: 6,
    maxCostCny: 70,
    allowedCommands: [],
    policyRules: [],
    testCommand: { command: 'npm', args: ['test'] },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('production CLI runtime', () => {
  test('persists workspace-local state then approves, claims, redispatches, records feedback, and resumes the loop', async () => {
    const workspaceRoot = await workspace();
    const credentials = { get: vi.fn(async () => 'key-must-remain-in-memory') };
    const client = new ScriptedMockLLM([
      { type: 'write_file', reason: '需要人工确认的普通文本写入', path: 'review.md', content: 'approved content' },
      { type: 'finish', reason: '已完成受控修改', summary: '完成' },
    ]);
    const runtime = createProductionRuntime({
      credentials,
      sessionIdFactory: () => 'session-approved',
      clientFactory: ({ credentials: providerCredentials }) => {
        expect(providerCredentials).toBe(credentials);
        return {
          async decide(context) {
            await providerCredentials.get();
            return client.decide(context);
          },
        };
      },
    });

    const awaiting = await runtime.run({ task: '写入受控文件', config: config(workspaceRoot) });

    expect(awaiting).toMatchObject({ status: 'waiting_approval', id: 'session-approved', step: 1 });
    expect(awaiting.pendingAction?.action.type).toBe('write_file');
    await expect(access(join(workspaceRoot, '.sentinel', 'state.json'))).resolves.toBeUndefined();
    await expect(access(join(workspaceRoot, 'review.md'))).rejects.toThrow();

    const finished = await runtime.approve({
      sessionId: awaiting.id,
      actionHash: awaiting.pendingAction!.actionHash,
      config: config(workspaceRoot),
    });

    expect(finished).toMatchObject({ status: 'completed', stopReason: 'finished', step: 2 });
    expect(finished.recentFeedback).toEqual([
      expect.objectContaining({ actionId: awaiting.pendingAction!.action.id, category: 'passed' }),
    ]);
    await expect(readFile(join(workspaceRoot, 'review.md'), 'utf8')).resolves.toBe('approved content');
    expect(credentials.get).toHaveBeenCalledTimes(2);

    const inspected = await runtime.inspect({ sessionId: awaiting.id, config: config(workspaceRoot) });
    expect(inspected).toMatchObject({ status: 'completed', id: awaiting.id });
    const audit = await runtime.audit({ sessionId: awaiting.id, config: config(workspaceRoot) });
    const rawAudit = await readFile(join(workspaceRoot, '.sentinel', 'audit.jsonl'), 'utf8');
    expect(audit.some((entry) => entry.event === 'policy_decision')).toBe(true);
    expect(audit.some((entry) => entry.event === 'tool_result' && entry.tool?.kind === 'write_file')).toBe(true);
    expect(audit.filter((entry) => entry.event === 'state_transition').map((entry) => [entry.state?.from, entry.state?.to])).toEqual([
      ['created', 'running'],
      ['running', 'waiting_approval'],
      ['waiting_approval', 'running'],
      ['running', 'completed'],
    ]);
    expect(rawAudit).not.toContain('key-must-remain-in-memory');
    expect(rawAudit).not.toContain('approved content');
  });

  test('reject transitions the durable pending action without dispatching it', async () => {
    const workspaceRoot = await workspace();
    const client = new ScriptedMockLLM([
      { type: 'write_file', reason: '需要人工确认的普通文本写入', path: 'reject.md', content: 'must not be written' },
    ]);
    const runtime = createProductionRuntime({
      credentials: { get: async () => 'unused' },
      sessionIdFactory: () => 'session-rejected',
      clientFactory: () => client,
    });

    const awaiting = await runtime.run({ task: '请求受控写入', config: config(workspaceRoot) });
    const rejected = await runtime.reject({
      sessionId: awaiting.id,
      actionHash: awaiting.pendingAction!.actionHash,
      config: config(workspaceRoot),
    });

    expect(rejected).toMatchObject({ status: 'stopped', stopReason: 'approval_denied' });
    await expect(access(join(workspaceRoot, 'reject.md'))).rejects.toThrow();
  });

  test('records each created, running, and terminal transition for a non-approval run', async () => {
    const workspaceRoot = await workspace();
    const runtime = createProductionRuntime({
      credentials: { get: async () => 'unused' },
      sessionIdFactory: () => 'session-finish',
      clientFactory: () => new ScriptedMockLLM([{ type: 'finish', reason: '完成', summary: '完成' }]),
    });

    await runtime.run({ task: '完成安全任务', config: config(workspaceRoot) });
    const audit = await runtime.audit({ sessionId: 'session-finish', config: config(workspaceRoot) });

    expect(audit.filter((entry) => entry.event === 'state_transition').map((entry) => [entry.state?.from, entry.state?.to])).toEqual([
      ['created', 'running'],
      ['running', 'completed'],
    ]);
  });

  test.each(['dispatcher', 'policy-audit', 'feedback'] as const)(
    'converges a claimed action to failed/tool_error when %s fails',
    async (failure) => {
      const workspaceRoot = await workspace();
      const client = new ScriptedMockLLM([
        { type: 'write_file', reason: '需要人工确认的普通文本写入', path: 'failure.md', content: 'must not be written' },
      ]);
      let policyWrites = 0;
      const audit = new class extends AuditLog {
        override async append(event: unknown) {
          if (failure === 'policy-audit' && (event as { event?: unknown }).event === 'policy_decision' && ++policyWrites === 2) {
            throw new Error('Authorization: Bearer audit-failure-secret');
          }
          return super.append(event);
        }
      }(join(workspaceRoot, '.sentinel', 'audit.jsonl'));
      const runtime = createProductionRuntime({
        credentials: { get: async () => 'unused' },
        sessionIdFactory: () => `session-${failure}`,
        clientFactory: () => client,
        auditLogFactory: () => audit,
        dispatcherFactory: () => ({
          async dispatch() {
            if (failure === 'dispatcher') throw new Error('Authorization: Bearer dispatcher-failure-secret');
            if (failure === 'feedback') {
              return Object.defineProperty({}, 'category', {
                enumerable: true,
                get: () => { throw new Error('Authorization: Bearer feedback-failure-secret'); },
              }) as never;
            }
            return { category: 'passed' as const, summary: '不应到达' };
          },
        }),
      } as ProductionRuntimeOptions);

      const awaiting = await runtime.run({ task: '请求故障注入写入', config: config(workspaceRoot) });
      const result = await runtime.approve({
        sessionId: awaiting.id,
        actionHash: awaiting.pendingAction!.actionHash,
        config: config(workspaceRoot),
      });

      expect(result).toMatchObject({ status: 'failed', stopReason: 'tool_error' });
      await expect(runtime.inspect({ sessionId: awaiting.id, config: config(workspaceRoot) })).resolves.toMatchObject({
        status: 'failed', stopReason: 'tool_error',
      });
      await expect(access(join(workspaceRoot, 'failure.md'))).rejects.toThrow();
      const persistedAudit = await readFile(join(workspaceRoot, '.sentinel', 'audit.jsonl'), 'utf8');
      expect(persistedAudit).not.toContain('failure-secret');
    },
  );
});
