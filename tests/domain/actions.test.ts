import { describe, expect, test } from 'vitest';
import { ActionParser } from '../../src/domain/actions.js';
import { parseHarnessConfig } from '../../src/domain/config.js';
import { sessionStateSchema } from '../../src/domain/session.js';

const parser = new ActionParser(() => 'action-test-id');

function expectInvalid(
  input: unknown,
  code: 'invalid_json' | 'schema_invalid' | 'semantic_invalid'
): void {
  const result = parser.parse(input);
  expect(result).toMatchObject({ ok: false, error: { code } });
  if (!result.ok) {
    expect(result.error.message.length).toBeGreaterThan(0);
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

describe('ActionParser', () => {
  test('为有效 envelope 注入 parser 生成的 id，LLM 输入不得带 id', () => {
    const result = parser.parse({ type: 'finish', reason: '任务已完成', summary: '完成摘要' });

    expect(result).toEqual({
      ok: true,
      action: { id: 'action-test-id', type: 'finish', reason: '任务已完成', summary: '完成摘要' }
    });
    expectInvalid({ type: 'finish', reason: '任务已完成', summary: '完成摘要', id: 'model-id' }, 'schema_invalid');
  });

  test('拒绝无效 JSON，并返回统一且可审计的失败形状', () => {
    expectInvalid('{"type":', 'invalid_json');
  });

  test.each([
    [{ type: 'read_file', reason: '读取文件' }, 'read_file 缺 path'],
    [{ type: 'write_file', reason: '写文件', path: 'a.txt' }, 'write_file 缺 content'],
    [{ type: 'run_command', reason: '运行命令', command: 'npm' }, 'run_command 缺 args'],
    [{ type: 'remember', reason: '保存笔记' }, 'remember 缺 note'],
    [{ type: 'finish', reason: '结束任务' }, 'finish 缺 summary']
  ])('拒绝各 action type 的必填字段：%s', (input, _description) => {
    expectInvalid(input, 'schema_invalid');
  });

  test.each([
    { type: 'read_file', reason: '读取文件', path: 'src/index.ts', content: 'unused' },
    { type: 'run_tests', reason: '运行测试', command: 'npm' },
    { type: 'list_files', reason: '列目录', path: null },
    { type: 'read_file', reason: '读取文件', path: undefined },
    { type: 'finish', reason: '结束', summary: '完成', extra: undefined }
  ])('拒绝未知、未使用、null 或 undefined 字段', (input) => {
    expectInvalid(input, 'schema_invalid');
  });

  test('保留空 content 和空 args 的契约差异，并允许 list_files 省略 path', () => {
    const write = parser.parse({ type: 'write_file', reason: '清空文件', path: 'empty.txt', content: '' });
    const command = parser.parse({ type: 'run_command', reason: '执行无参数命令', command: 'pwd', args: [] });
    const list = parser.parse({ type: 'list_files', reason: '列出工作区根' });

    expect(write).toMatchObject({ ok: true, action: { content: '' } });
    expect(command).toMatchObject({ ok: true, action: { command: 'pwd', args: [] } });
    expect(list).toEqual({ ok: true, action: { id: 'action-test-id', type: 'list_files', reason: '列出工作区根' } });
    expectInvalid({ type: 'read_file', reason: '读取文件', path: '' }, 'schema_invalid');
    expectInvalid({ type: 'run_command', reason: '执行', command: 'pwd', args: [''] }, 'schema_invalid');
  });

  test('执行 reason/note/summary 的长度和非空限制', () => {
    expectInvalid({ type: 'run_tests', reason: '' }, 'schema_invalid');
    expectInvalid({ type: 'run_tests', reason: 'a'.repeat(501) }, 'schema_invalid');
    expectInvalid({ type: 'remember', reason: '保存', note: '' }, 'schema_invalid');
    expectInvalid({ type: 'remember', reason: '保存', note: 'a'.repeat(301) }, 'schema_invalid');
    expectInvalid({ type: 'finish', reason: '完成', summary: '' }, 'schema_invalid');
    expectInvalid({ type: 'finish', reason: '完成', summary: 'a'.repeat(1001) }, 'schema_invalid');
  });

  test.each([
    ['npm test', []],
    ['npm', ['test; rm -rf /']],
    ['npm', ['test|cat']],
    ['npm', ['test&']],
    ['npm', ['test>out']],
    ['npm', ['test`id`']],
    ['npm', ['test$HOME']],
    ['npm', ['$(id)']],
    ['npm', ['test\nnext']],
    ['npm\u0000bin', []]
  ])('以 semantic_invalid 拒绝 shell 控制字符：%s %j', (command, args) => {
    expectInvalid({ type: 'run_command', reason: '执行命令', command, args }, 'semantic_invalid');
  });
});

describe('HarnessConfig', () => {
  test('冻结安全默认值并将缺省 workspaceRoot 解析为绝对真实路径', () => {
    const config = parseHarnessConfig({}, process.cwd());

    expect(config.workspaceRoot).toBe(process.cwd());
    expect(config.maxSteps).toBe(6);
    expect(config.maxCostCny).toBe(70);
    expect(config.allowedCommands).toEqual([]);
    expect(config.policyRules).toEqual([]);
  });

  test('严格拒绝顶层与嵌套未知字段，并校验数值界限', () => {
    expect(() => parseHarnessConfig({ extra: true })).toThrow();
    expect(() => parseHarnessConfig({ allowedCommands: [{ command: 'npm', argsPrefix: [], extra: true }] })).toThrow();
    expect(() => parseHarnessConfig({ policyRules: [{ id: 'p1', effect: 'allow', risk: 'low', match: { extra: true } }] })).toThrow();
    expect(() => parseHarnessConfig({ maxSteps: 0 })).toThrow();
    expect(() => parseHarnessConfig({ maxSteps: 13 })).toThrow();
    expect(() => parseHarnessConfig({ maxCostCny: 0 })).toThrow();
    expect(() => parseHarnessConfig({ maxCostCny: 71 })).toThrow();
  });
});

describe('SessionState', () => {
  const base = {
    id: 'session-1',
    status: 'waiting_approval',
    step: 1,
    task: '完成任务',
    recentActions: [],
    recentFeedback: [],
    pendingAction: {
      action: { id: 'action-1', type: 'finish', reason: '完成任务', summary: '完成摘要' },
      actionHash: 'hash-1'
    }
  };

  test('接受规范 status、完整 pending action 和限定 stopReason', () => {
    expect(sessionStateSchema.parse(base)).toMatchObject(base);
    expect(sessionStateSchema.parse({ ...base, status: 'stopped', stopReason: 'max_steps', pendingAction: undefined })).toMatchObject({
      status: 'stopped',
      stopReason: 'max_steps'
    });
  });

  test('拒绝超出最近摘要上限和未知 status/stopReason', () => {
    const actionSummary = { id: 'action-1', type: 'finish', reason: '完成', createdAt: '2026-01-01T00:00:00.000Z' };
    const feedback = { category: 'passed', summary: '测试通过', actionId: 'action-1', createdAt: '2026-01-01T00:00:00.000Z' };

    expect(() => sessionStateSchema.parse({ ...base, recentActions: Array(9).fill(actionSummary) })).toThrow();
    expect(() => sessionStateSchema.parse({ ...base, recentFeedback: Array(9).fill(feedback) })).toThrow();
    expect(() => sessionStateSchema.parse({ ...base, status: 'unknown' })).toThrow();
    expect(() => sessionStateSchema.parse({ ...base, stopReason: 'unknown' })).toThrow();
  });
});
