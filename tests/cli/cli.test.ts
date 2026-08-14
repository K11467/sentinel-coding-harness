import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EXIT, runCli, type CliDependencies, type CliRuntime } from '../../src/cli.js';
import type { SessionState } from '../../src/domain/session.js';

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-cli-'));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

async function writeConfig(cwd: string, contents = 'testCommand: { command: npm, args: [test] }\n'): Promise<void> {
  await writeFile(join(cwd, 'harness.yaml'), contents, 'utf8');
}

function invoke(argv: string[], dependencies: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    code: runCli(argv, {
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
      ...dependencies,
    }),
  };
}

function session(id = 'session-1'): SessionState {
  return {
    id,
    status: 'completed',
    step: 1,
    task: 'safe test task',
    stopReason: 'finished',
    recentActions: [],
    recentFeedback: [],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('CLI config/check and error boundary', () => {
  test('config check reads harness.yaml and writes a non-sensitive summary to stdout', async () => {
    const cwd = await workspace();
    await writeConfig(cwd);
    const result = invoke(['config', 'check'], { cwd });

    await expect(result.code).resolves.toBe(EXIT.OK);
    expect(result.stdout).toEqual([expect.stringContaining('配置有效')]);
    expect(result.stdout.join('\n')).toContain(cwd);
    expect(result.stderr).toEqual([]);
  });

  test('unknown command has a stable usage exit and writes only stderr', async () => {
    const result = invoke(['publish']);

    await expect(result.code).resolves.toBe(EXIT.USAGE);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([expect.stringContaining('未知命令')]);
  });

  test('redacts injected config-loader failures before writing stderr', async () => {
    const secret = 'super-secret-value';
    const result = invoke(['config', 'check'], {
      loadConfig: () => {
        throw new Error(`apiKey=${secret}`);
      },
    });

    await expect(result.code).resolves.toBe(EXIT.CONFIG);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('\n')).not.toContain(secret);
    expect(result.stderr.join('\n')).toContain('[REDACTED]');
  });
});

describe('CLI credentials commands', () => {
  test('credentials status reports existence only and never a stored value', async () => {
    const storedValue = 'credential-value-must-not-be-printed';
    const result = invoke(['credentials', 'status'], {
      credentials: {
        status: async () => ({ exists: true }),
        set: async () => undefined,
        clear: async () => undefined,
      },
    });

    await expect(result.code).resolves.toBe(EXIT.OK);
    expect(result.stdout).toEqual(['凭据状态：已配置。']);
    expect(result.stdout.join('\n')).not.toContain(storedValue);
    expect(result.stderr).toEqual([]);
  });

  test('credentials set obtains a hidden value through injection and never echoes it', async () => {
    const enteredValue = 'input-value-must-not-be-printed';
    const received: string[] = [];
    const result = invoke(['credentials', 'set'], {
      readHidden: async () => enteredValue,
      credentials: {
        status: async () => ({ exists: false }),
        set: async (value) => {
          received.push(value ?? '');
        },
        clear: async () => undefined,
      },
    });

    await expect(result.code).resolves.toBe(EXIT.OK);
    expect(received).toEqual([enteredValue]);
    expect(result.stdout).toEqual(['凭据已保存到系统安全存储。']);
    expect([...result.stdout, ...result.stderr].join('\n')).not.toContain(enteredValue);
  });

  test('credentials clear delegates once and keeps subprocess-style failure text redacted', async () => {
    const storedValue = 'clear-error-value-must-not-be-printed';
    let clears = 0;
    const result = invoke(['credentials', 'clear'], {
      credentials: {
        status: async () => ({ exists: false }),
        set: async () => undefined,
        clear: async () => {
          clears += 1;
          throw new Error(`Authorization: Bearer ${storedValue}`);
        },
      },
    });

    await expect(result.code).resolves.toBe(EXIT.FAILURE);
    expect(clears).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('\n')).not.toContain(storedValue);
    expect(result.stderr.join('\n')).toContain('[REDACTED]');
  });
});

describe('CLI session commands and offline demo', () => {
  test('run without a configured credential gives actionable guidance before a provider runtime is called', async () => {
    const cwd = await workspace();
    await writeConfig(cwd);
    let runs = 0;
    const result = invoke(['run', 'add', 'a', 'test'], {
      cwd,
      credentials: {
        status: async () => ({ exists: false }),
        set: async () => undefined,
        clear: async () => undefined,
      },
      runtime: {
        run: async () => {
          runs += 1;
          return session();
        },
        resume: async () => session(),
        approve: async () => session(),
        reject: async () => session(),
        demo: async () => session('demo'),
      },
    });

    await expect(result.code).resolves.toBe(EXIT.UNAVAILABLE);
    expect(runs).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('\n')).toContain('credentials set');
  });

  test('run loads YAML and forwards the task only to an injected runtime after credential status succeeds', async () => {
    const cwd = await workspace();
    await writeConfig(cwd);
    const calls: string[] = [];
    const runtime: CliRuntime = {
      run: async ({ task, config }) => {
        calls.push(`${task}|${config.workspaceRoot}`);
        return session('run-1');
      },
      resume: async () => session(),
      approve: async () => session(),
      reject: async () => session(),
      demo: async () => session('demo'),
    };
    const result = invoke(['run', 'fix', 'the', 'test'], {
      cwd,
      runtime,
      credentials: {
        status: async () => ({ exists: true }),
        set: async () => undefined,
        clear: async () => undefined,
      },
    });

    await expect(result.code).resolves.toBe(EXIT.OK);
    expect(calls).toEqual([`fix the test|${cwd}`]);
    expect(result.stdout).toEqual([expect.stringContaining('run-1')]);
    expect(result.stderr).toEqual([]);
  });

  test.each([
    ['resume', ['resume', 'session-r'], 'resume'],
    ['approve', ['approve', 'session-a', 'sha256:expected'], 'approve'],
    ['reject', ['reject', 'session-d', 'sha256:expected'], 'reject'],
  ] as const)('%s forwards only validated identifiers to the injected runtime', async (_name, argv, method) => {
    const cwd = await workspace();
    await writeConfig(cwd);
    const calls: string[] = [];
    const runtime: CliRuntime = {
      run: async () => session(),
      resume: async ({ sessionId }) => {
        calls.push(`resume:${sessionId}`);
        return session(sessionId);
      },
      approve: async ({ sessionId, actionHash }) => {
        calls.push(`approve:${sessionId}:${actionHash}`);
        return session(sessionId);
      },
      reject: async ({ sessionId, actionHash }) => {
        calls.push(`reject:${sessionId}:${actionHash}`);
        return session(sessionId);
      },
      demo: async () => session('demo'),
    };
    const result = invoke([...argv], { cwd, runtime });

    await expect(result.code).resolves.toBe(EXIT.OK);
    expect(calls).toEqual(method === 'resume'
      ? ['resume:session-r']
      : [`${method}:${argv[1]}:${argv[2]}`]);
    expect(result.stderr).toEqual([]);
  });

  test('demo uses the built-in scripted mock without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = invoke(['demo']);

      await expect(result.code).resolves.toBe(EXIT.OK);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.stdout).toEqual([expect.stringContaining('demo-session')]);
      expect(result.stderr).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
