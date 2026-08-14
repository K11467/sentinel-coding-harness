import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const keychainSmokeEnabled = process.platform === 'darwin' && process.env.SENTINEL_KEYCHAIN_SMOKE === '1';

function defaultKeychainPath(stdout: string | undefined): string {
  const value = stdout?.trim().replace(/^"|"$/g, '');
  if (!value) throw new Error('无法读取当前默认 Keychain 路径。');
  return value;
}

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
        command: '/usr/bin/security',
        args: ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        options: { shell: false, stdin: `${secret}\n${secret}\n` },
      },
    ]);
    expect(runner.calls[0]!.args.join(' ')).not.toContain(secret);
    expect(Buffer.from(runner.calls[0]!.options.stdin ?? '', 'utf8')).toEqual(Buffer.from(`${secret}\n${secret}\n`, 'utf8'));
    expect(SECURITY_EXECUTABLE).toBe('/usr/bin/security');
  });

  test('status 只返回存在与否，且不回显 security 输出', async () => {
    const secret = 'status-secret-must-not-escape';
    const runner = new FakeProcessRunner({ exitCode: 0, stdout: secret, stderr: secret });

    await expect(macosKeychain(runner).status()).resolves.toEqual({ exists: true });
    expect(runner.calls[0]).toEqual({
      command: '/usr/bin/security',
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
      command: '/usr/bin/security',
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
        command: '/usr/bin/security',
        args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        options: { shell: false, captureStdout: true },
      },
    ]);
  });

  test('get 去除 security -w 添加的单个行结束符，不改变内存中的 key 内容', async () => {
    const value = 'provider-memory-only-value';
    const runner = new FakeProcessRunner({ exitCode: 0, stdout: `${value}\n` });

    await expect(macosKeychain(runner).get()).resolves.toBe(value);
  });

  test('readSecret 的 stdout 或 stderr 不会进入异常', async () => {
    const value = 'read-output-must-not-escape';
    const runner = new FakeProcessRunner({ exitCode: 1, stdout: value, stderr: `not permitted: ${value}` });

    await expect(macosKeychain(runner).readSecret()).rejects.not.toThrow(value);
  });

  test.runIf(keychainSmokeEnabled)('显式开启时仅在临时默认 Keychain 中验证随机虚拟凭据', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sentinel-keychain-smoke-'));
    const temporaryKeychain = join(temporaryDirectory, 'smoke.keychain-db');
    const identity = {
      service: `sentinel-smoke-service-${randomUUID()}`,
      account: `sentinel-smoke-account-${randomUUID()}`,
    };
    const secret = `sentinel-smoke-secret-${randomUUID()}`;
    let previousDefault: string | undefined;
    let temporaryKeychainCreated = false;
    let temporaryDefaultSelected = false;

    try {
      const defaultResult = await nodeSecurityProcessRunner.spawn(
        SECURITY_EXECUTABLE,
        ['default-keychain'],
        { shell: false, captureStdout: true },
      );
      expect(defaultResult.exitCode).toBe(0);
      previousDefault = defaultKeychainPath(defaultResult.stdout);

      expect(
        (await nodeSecurityProcessRunner.spawn(SECURITY_EXECUTABLE, ['create-keychain', temporaryKeychain], { shell: false })).exitCode,
      ).toBe(0);
      temporaryKeychainCreated = true;
      expect(
        (await nodeSecurityProcessRunner.spawn(SECURITY_EXECUTABLE, ['default-keychain', '-s', temporaryKeychain], { shell: false })).exitCode,
      ).toBe(0);
      temporaryDefaultSelected = true;

      const keychain = new MacOSKeychain({ platform: 'darwin', identity });
      await keychain.set(secret);
      await expect(keychain.status()).resolves.toEqual({ exists: true });
      await expect(keychain.get()).resolves.toBe(secret);
      await expect(keychain.clear()).resolves.toBeUndefined();
      await expect(keychain.status()).resolves.toEqual({ exists: false });
    } finally {
      if (temporaryDefaultSelected && previousDefault) {
        expect(
          (await nodeSecurityProcessRunner.spawn(SECURITY_EXECUTABLE, ['default-keychain', '-s', previousDefault], { shell: false })).exitCode,
        ).toBe(0);
      }
      if (temporaryKeychainCreated) {
        expect(
          (await nodeSecurityProcessRunner.spawn(SECURITY_EXECUTABLE, ['delete-keychain', temporaryKeychain], { shell: false })).exitCode,
        ).toBe(0);
      }
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
