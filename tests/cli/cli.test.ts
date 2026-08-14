import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EXIT, runCli, type CliDependencies } from '../../src/cli.js';

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
        set: async (value) => received.push(value ?? ''),
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
