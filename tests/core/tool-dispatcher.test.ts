import { describe, expect, test } from 'vitest';
import { ActionParser, type Action, type ActionEnvelope } from '../../src/domain/actions.js';
import { ToolDispatcher } from '../../src/core/tool-dispatcher.js';

function action(input: ActionEnvelope): Action {
  const parsed = new ActionParser(() => 'action-1').parse(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.action;
}

describe('ToolDispatcher', () => {
  test('routes verified workspace and command actions through the controlled T04/T05 tools', async () => {
    const workspaceCalls: string[] = [];
    const commandCalls: string[] = [];
    const dispatcher = new ToolDispatcher({
      workspace: {
        async list(path = '.') {
          workspaceCalls.push(`list:${path}`);
          return { ok: true as const, kind: 'list' as const, path, entries: ['src'] };
        },
        async read(path: string) {
          workspaceCalls.push(`read:${path}`);
          return { ok: true as const, kind: 'read' as const, path, content: 'export {};' };
        },
        async write(path: string, content: string) {
          workspaceCalls.push(`write:${path}:${content}`);
          return { ok: true as const, kind: 'write' as const, path, bytesWritten: content.length };
        }
      },
      commands: {
        async runCommand(command: unknown, args: unknown) {
          commandCalls.push(`command:${String(command)}:${JSON.stringify(args)}`);
          return { ok: true as const, kind: 'command' as const, exitCode: 0 as const, output: 'done', truncated: false };
        },
        async runTests() {
          commandCalls.push('tests');
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

    expect(await dispatcher.dispatch(action({ type: 'list_files', reason: '查看目录', path: 'src' }))).toEqual({
      category: 'passed', summary: '工作区操作已完成。'
    });
    expect(await dispatcher.dispatch(action({ type: 'read_file', reason: '读取源码', path: 'src/app.ts' }))).toEqual({
      category: 'passed', summary: '工作区操作已完成。'
    });
    expect(await dispatcher.dispatch(action({ type: 'write_file', reason: '写入源码', path: 'src/app.ts', content: 'export {};' }))).toEqual({
      category: 'passed', summary: '工作区操作已完成。'
    });
    expect(await dispatcher.dispatch(action({ type: 'run_command', reason: '运行检查', command: 'node', args: ['--version'] }))).toEqual({
      category: 'passed', summary: '测试通过（退出码 0）。'
    });
    expect(await dispatcher.dispatch(action({ type: 'run_tests', reason: '运行受控测试' }))).toEqual({
      category: 'assertion_failed', summary: '断言失败（退出码 1）。'
    });

    expect(workspaceCalls).toEqual(['list:src', 'read:src/app.ts', 'write:src/app.ts:export {};']);
    expect(commandCalls).toEqual(['command:node:["--version"]', 'tests']);
  });

  test('returns a stable safe feedback item for a controlled workspace rejection', async () => {
    const dispatcher = new ToolDispatcher({
      workspace: {
        async list() {
          return { ok: false as const, kind: 'list' as const, errorCode: 'symlink_escape' as const, message: 'outside-secret-path' };
        },
        async read() {
          throw new Error('not used');
        },
        async write() {
          throw new Error('not used');
        }
      },
      commands: {
        async runCommand() {
          throw new Error('not used');
        },
        async runTests() {
          throw new Error('not used');
        }
      }
    });

    const feedback = await dispatcher.dispatch(action({ type: 'list_files', reason: '越界查看', path: 'linked' }));

    expect(feedback).toEqual({ category: 'command_error', summary: '工作区操作失败（symlink_escape）。' });
    expect(feedback.summary).not.toContain('outside-secret-path');
  });
});
