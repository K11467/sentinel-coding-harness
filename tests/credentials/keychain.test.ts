import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  MacOSKeychain,
  SECURITY_EXECUTABLE,
  nodeSecurityProcessRunner,
  type SecurityProcessOptions,
  type SecurityProcessResult,
  type SecurityProcessRunner,
} from '../../src/credentials/keychain.js';

const execFileAsync = promisify(execFile);

class FakeProcessRunner implements SecurityProcessRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options: SecurityProcessOptions }> = [];

  constructor(private readonly result: SecurityProcessResult = { exitCode: 0 }) {}

  async spawn(command: string, args: readonly string[], options: SecurityProcessOptions): Promise<SecurityProcessResult> {
    this.calls.push({ command, args, options });
    return this.result;
  }
}

function macosKeychain(runner = new FakeProcessRunner()): MacOSKeychain {
  return new MacOSKeychain({ platform: 'darwin', runner });
}

describe('MacOSKeychain', () => {
  test('set 仅经受控 stdin 传递内存 secret，命令参数中没有 key', async () => {
    const secret = 'test-secret-never-in-args';
    const runner = new FakeProcessRunner();

    await macosKeychain(runner).set(secret);

    expect(runner.calls).toEqual([
      {
        command: SECURITY_EXECUTABLE,
        args: ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        options: { shell: false, stdin: `${secret}\n${secret}\n` },
      },
    ]);
    expect(runner.calls[0]!.args.join(' ')).not.toContain(secret);
  });

  test('status 只返回存在与否，且不回显 security 输出', async () => {
    const secret = 'status-secret-must-not-escape';
    const runner = new FakeProcessRunner({ exitCode: 0, stdout: secret, stderr: secret });

    await expect(macosKeychain(runner).status()).resolves.toEqual({ exists: true });
    expect(runner.calls[0]).toEqual({
      command: SECURITY_EXECUTABLE,
      args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      options: { shell: false },
    });
  });

  test('取消或空输入给出可操作的无密钥错误，且不启动进程', async () => {
    const runner = new FakeProcessRunner();
    const keychain = macosKeychain(runner);

    await expect(keychain.set(undefined)).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
    await expect(keychain.set('')).rejects.toMatchObject({ code: 'INPUT_MISSING' });
    expect(runner.calls).toHaveLength(0);
  });

  test('非 macOS 拒绝操作，不调用 security', async () => {
    const runner = new FakeProcessRunner();
    const keychain = new MacOSKeychain({ platform: 'linux', runner });

    await expect(keychain.status()).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    expect(runner.calls).toHaveLength(0);
  });

  test('status 对缺失 item 仅报告不存在', async () => {
    const runner = new FakeProcessRunner({ exitCode: 44, stderr: 'The specified item could not be found in the keychain.' });

    await expect(macosKeychain(runner).status()).resolves.toEqual({ exists: false });
  });

  test('clear 仅删除固定 item，缺失时给出操作性错误', async () => {
    const runner = new FakeProcessRunner({ exitCode: 44, stderr: 'not found' });

    await expect(macosKeychain(runner).clear()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(runner.calls[0]).toEqual({
      command: SECURITY_EXECUTABLE,
      args: ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      options: { shell: false },
    });
  });

  test('Keychain 锁定和命令错误均脱敏，不带 stderr 中的 secret', async () => {
    const secret = 'error-secret-must-not-escape';
    const runner = new FakeProcessRunner({ exitCode: 1, stderr: `User interaction is not allowed: ${secret}` });

    await expect(macosKeychain(runner).clear()).rejects.toMatchObject({ code: 'KEYCHAIN_LOCKED' });
    await expect(macosKeychain(runner).clear()).rejects.not.toThrow(secret);
  });

  test('get 只将 -w stdout 作为内存返回值，不进入 status、错误或日志', async () => {
    const value = 'provider-memory-only-value';
    const runner = new FakeProcessRunner({ exitCode: 0, stdout: value });
    const keychain = macosKeychain(runner);

    await expect(keychain.get()).resolves.toBe(value);
    expect(runner.calls).toEqual([
      {
        command: SECURITY_EXECUTABLE,
        args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        options: { shell: false },
      },
    ]);
  });

  test('readSecret 的 stdout 或 stderr 不会进入异常', async () => {
    const value = 'read-output-must-not-escape';
    const runner = new FakeProcessRunner({ exitCode: 1, stdout: value, stderr: `not permitted: ${value}` });

    await expect(macosKeychain(runner).readSecret()).rejects.not.toThrow(value);
  });

  test.skipIf(process.platform !== 'darwin')('使用临时 Keychain 验证 set、find 与 delete，不接触默认 Keychain', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'harness-keychain-'));
    const temporaryKeychain = join(temporaryDirectory, 'credentials.keychain-db');
    const temporaryPassword = randomUUID();
    const value = `dummy-${randomUUID()}`;
    let created = false;

    const temporarySecurity = async (args: readonly string[]): Promise<void> => {
      try {
        await execFileAsync(SECURITY_EXECUTABLE, args, { timeout: 5_000 });
      } catch {
        throw new Error('临时 Keychain 命令失败');
      }
    };

    try {
      await temporarySecurity(['create-keychain', '-p', temporaryPassword, temporaryKeychain]);
      created = true;
      await temporarySecurity(['unlock-keychain', '-p', temporaryPassword, temporaryKeychain]);

      const temporaryRunner: SecurityProcessRunner = {
        spawn(command, args, options) {
          return nodeSecurityProcessRunner.spawn(command, [...args, temporaryKeychain], options);
        },
      };
      const keychain = new MacOSKeychain({ platform: 'darwin', runner: temporaryRunner });

      await keychain.set(value);
      await expect(keychain.status()).resolves.toEqual({ exists: true });
      expect((await keychain.readSecret()) === value).toBe(true);
      await keychain.clear();
      await expect(keychain.status()).resolves.toEqual({ exists: false });
    } finally {
      if (created) {
        await temporarySecurity(['delete-keychain', temporaryKeychain]).catch(() => undefined);
      }
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 15_000);
});
