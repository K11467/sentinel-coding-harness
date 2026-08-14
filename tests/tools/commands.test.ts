import { spawn } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import {
  CommandTools,
  MAX_COMMAND_OUTPUT_BYTES,
  type SpawnProcess
} from '../../src/tools/commands.js';

const node = process.execPath;

function testCommand(script = 'process.stdout.write("test command")') {
  return { command: node, args: ['-e', script] };
}

function tools(options: {
  allowedCommands?: { command: string; argsPrefix: string[] }[];
  testCommand?: { command: string; args: string[] };
  timeoutMs?: number;
  spawnProcess?: SpawnProcess;
} = {}) {
  return new CommandTools({
    allowedCommands: options.allowedCommands ?? [{ command: node, argsPrefix: ['-e'] }],
    testCommand: options.testCommand ?? testCommand(),
    timeoutMs: options.timeoutMs,
    spawnProcess: options.spawnProcess
  });
}

describe('CommandTools', () => {
  test.each(['node;echo blocked', 'node tool'])('拒绝带 shell 元字符或空格的 command，且不 spawn：%s', async (command) => {
    let calls = 0;
    const neverSpawn: SpawnProcess = () => {
      calls += 1;
      throw new Error('不应 spawn');
    };

    const result = await tools({ spawnProcess: neverSpawn }).runCommand(command, []);

    expect(result).toMatchObject({ ok: false, kind: 'command', errorCode: 'invalid_command' });
    expect(calls).toBe(0);
  });

  test('拒绝非字符串 args，且不 spawn', async () => {
    let calls = 0;
    const neverSpawn: SpawnProcess = () => {
      calls += 1;
      throw new Error('不应 spawn');
    };

    const result = await tools({ spawnProcess: neverSpawn }).runCommand(node, ['-e', 42] as unknown);

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_arguments' });
    expect(calls).toBe(0);
  });

  test('仅接受完整 command 与 argsPrefix 均匹配的 allowlist rule', async () => {
    let calls = 0;
    const neverSpawn: SpawnProcess = () => {
      calls += 1;
      throw new Error('不应 spawn');
    };
    const commandTools = tools({
      allowedCommands: [{ command: node, argsPrefix: ['--version'] }],
      spawnProcess: neverSpawn
    });

    const result = await commandTools.runCommand(node, ['-e', 'process.exitCode=0']);

    expect(result).toMatchObject({ ok: false, errorCode: 'command_not_allowed' });
    expect(calls).toBe(0);
  });

  test('以 shell:false 参数数组执行允许的命令并合并 stdout/stderr', async () => {
    const result = await tools().runCommand(node, [
      '-e',
      'process.stdout.write("out");process.stderr.write("err")'
    ]);

    expect(result).toEqual({
      ok: true,
      kind: 'command',
      exitCode: 0,
      output: 'outerr',
      truncated: false
    });
  });

  test('将非零退出码作为结构化失败返回', async () => {
    const result = await tools().runCommand(node, ['-e', 'process.stderr.write("failed");process.exitCode=3']);

    expect(result).toEqual({
      ok: false,
      kind: 'command',
      exitCode: 3,
      output: 'failed',
      truncated: false,
      errorCode: 'nonzero_exit'
    });
  });

  test('超时后杀死子进程并返回结构化 timeout', async () => {
    const result = await tools({ timeoutMs: 20 }).runCommand(node, [
      '-e',
      'setTimeout(() => process.stdout.write("late"), 1000)'
    ]);

    expect(result).toMatchObject({
      ok: false,
      kind: 'command',
      exitCode: null,
      errorCode: 'timeout',
      timedOut: true
    });
  });

  test('按 UTF-8 字节数将合并输出截断为最多 4 KiB', async () => {
    const result = await tools().runCommand(node, ['-e', 'process.stdout.write("😀".repeat(2000))']);

    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_BYTES);
    expect(result.output).toBe('😀'.repeat(1024));
  });

  test('runTests 不接受模型命令，只执行注入的受信 testCommand', async () => {
    const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
    const spawnProcess: SpawnProcess = (command, args, options) => {
      calls.push({ command, args, shell: options.shell });
      return spawn(command, [...args], options);
    };
    const injected = testCommand('process.stdout.write("injected test")');
    const commandTools = tools({
      allowedCommands: [],
      testCommand: injected,
      spawnProcess
    });

    const result = await commandTools.runTests();

    expect(result).toMatchObject({ ok: true, kind: 'tests', output: 'injected test' });
    expect(calls).toEqual([{ command: injected.command, args: injected.args, shell: false }]);
  });
});
