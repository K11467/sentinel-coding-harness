import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CommandTools,
  MAX_COMMAND_OUTPUT_BYTES,
  type SpawnProcess
} from '../../src/tools/commands.js';

const node = process.execPath;
const temporaryPaths: string[] = [];

async function script(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-command-'));
  temporaryPaths.push(directory);
  const path = join(directory, 'command.js');
  await writeFile(path, source, 'utf8');
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function testCommand(script = 'process.stdout.write("test command")') {
  return { command: node, args: ['-e', script] };
}

function tools(options: {
  allowedCommands?: { command: string; argsPrefix: string[] }[];
  testCommand?: { command: string; args: string[] };
  timeoutMs?: number;
  spawnProcess?: SpawnProcess;
  workspaceRoot?: string;
} = {}) {
  return new CommandTools({
    allowedCommands: options.allowedCommands ?? [{ command: node, argsPrefix: ['-e'] }],
    testCommand: options.testCommand ?? testCommand(),
    timeoutMs: options.timeoutMs,
    spawnProcess: options.spawnProcess,
    workspaceRoot: options.workspaceRoot ?? process.cwd()
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

  test.each([
    ['NUL', ['safe\u0000arg']],
    ['换行', ['safe\narg']],
    ['分号', ['safe;arg']],
    ['管道', ['safe|arg']],
    ['与号', ['safe&arg']],
    ['重定向', ['safe>arg']],
    ['反引号', ['safe`arg']],
    ['美元符', ['safe$arg']],
    ['圆括号', ['safe(arg)']]
  ])('拒绝含 %s 的 args，且不 spawn', async (_name, args) => {
    let calls = 0;
    const neverSpawn: SpawnProcess = () => {
      calls += 1;
      throw new Error('不应 spawn');
    };

    const result = await tools({ spawnProcess: neverSpawn }).runCommand(node, args);

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
    const commandScript = await script('process.stdout.write("out");process.stderr.write("err")');
    const result = await tools({ allowedCommands: [{ command: node, argsPrefix: [] }] }).runCommand(node, [commandScript]);

    expect(result).toEqual({
      ok: true,
      kind: 'command',
      exitCode: 0,
      output: 'outerr',
      truncated: false
    });
  });

  test('将非零退出码作为结构化失败返回', async () => {
    const commandScript = await script('process.stderr.write("failed");process.exitCode=3');
    const result = await tools({ allowedCommands: [{ command: node, argsPrefix: [] }] }).runCommand(node, [commandScript]);

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
    const commandScript = await script('setTimeout(() => process.stdout.write("late"), 1000)');
    const result = await tools({
      allowedCommands: [{ command: node, argsPrefix: [] }],
      timeoutMs: 20
    }).runCommand(node, [commandScript]);

    expect(result).toMatchObject({
      ok: false,
      kind: 'command',
      exitCode: null,
      errorCode: 'timeout',
      timedOut: true
    });
  });

  test('按 UTF-8 字节数将合并输出截断为最多 4 KiB', async () => {
    const commandScript = await script('process.stdout.write("😀".repeat(2000))');
    const result = await tools({ allowedCommands: [{ command: node, argsPrefix: [] }] }).runCommand(node, [commandScript]);

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
    const testScript = await script('process.stdout.write("injected test")');
    const injected = { command: node, args: [testScript] };
    const commandTools = tools({
      allowedCommands: [],
      testCommand: injected,
      spawnProcess
    });

    const result = await commandTools.runTests();

    expect(result).toMatchObject({ ok: true, kind: 'tests', output: 'injected test' });
    expect(calls).toEqual([{ command: injected.command, args: injected.args, shell: false }]);
  });

  test('普通 args 中的空格合法且按单个参数传入', async () => {
    const commandScript = await script('process.stdout.write(process.argv[2])');
    const result = await tools({ allowedCommands: [{ command: node, argsPrefix: [] }] })
      .runCommand(node, [commandScript, 'value with spaces']);

    expect(result).toMatchObject({ ok: true, output: 'value with spaces' });
  });

  test('runCommand 和 runTests 均在已验证的 workspaceRoot 中启动', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sentinel-command-workspace-'));
    temporaryPaths.push(workspaceRoot);
    const commandScript = await script('process.stdout.write(process.cwd())');
    const commandTools = tools({
      allowedCommands: [{ command: node, argsPrefix: [] }],
      testCommand: { command: node, args: [commandScript] },
      workspaceRoot
    });

    await expect(commandTools.runCommand(node, [commandScript])).resolves.toMatchObject({ ok: true, output: workspaceRoot });
    await expect(commandTools.runTests()).resolves.toMatchObject({ ok: true, output: workspaceRoot });
  });

  test('timeout 杀死 detached 进程组，不遗留其启动的子进程', async () => {
    const commandScript = await script([
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(child.pid));',
      'setInterval(() => {}, 1000);'
    ].join('\n'));
    const startedAt = Date.now();
    const result = await tools({
      allowedCommands: [{ command: node, argsPrefix: [] }],
      timeoutMs: 500
    }).runCommand(node, [commandScript]);
    const childPid = Number(result.output);

    try {
      expect(result).toMatchObject({ ok: false, errorCode: 'timeout', timedOut: true });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      if (Number.isInteger(childPid) && childPid > 0) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The required behavior is that the process group was already gone.
        }
      }
    }
  });
});
