import { spawn } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'se-project';
export const KEYCHAIN_ACCOUNT = 'zhizengzeng-api-key';

export type KeychainErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INPUT_CANCELLED'
  | 'INPUT_MISSING'
  | 'KEYCHAIN_LOCKED'
  | 'NOT_FOUND'
  | 'COMMAND_FAILED';

const errorMessages: Record<KeychainErrorCode, string> = {
  UNSUPPORTED_PLATFORM: '凭据操作仅支持 macOS；请在 macOS 上使用系统 Keychain。',
  INPUT_CANCELLED: '已取消凭据输入；未保存任何内容。',
  INPUT_MISSING: '未提供 API Key；请重新使用隐藏输入完成设置。',
  KEYCHAIN_LOCKED: 'macOS Keychain 已锁定或不允许交互；请解锁 Keychain 后重试。',
  NOT_FOUND: '未找到该 Keychain 凭据；请先执行 credentials set。',
  COMMAND_FAILED: '无法完成 Keychain 操作；请检查 macOS Keychain 状态后重试。',
};

/** A safe, actionable error that deliberately excludes subprocess output. */
export class KeychainError extends Error {
  constructor(readonly code: KeychainErrorCode) {
    super(errorMessages[code]);
    this.name = 'KeychainError';
  }
}

export interface SecurityProcessOptions {
  /** Must remain false so the command is never evaluated by a shell. */
  readonly shell: false;
  /** Secret input is written directly to the child stdin and is never an argument. */
  readonly stdin?: string;
}

export interface SecurityProcessResult {
  readonly exitCode: number;
  /** Used only to classify a safe error; it is never returned or included in an Error. */
  readonly stderr?: string;
  readonly stdout?: string;
}

/** Injectable boundary around the macOS security executable. */
export interface SecurityProcessRunner {
  spawn(command: string, args: readonly string[], options: SecurityProcessOptions): Promise<SecurityProcessResult>;
}

const MAX_STDERR_BYTES = 4 * 1024;

/**
 * Production runner. It invokes security with an argv array, never a shell, and
 * writes the optional secret to the process pipe rather than command arguments.
 */
export const nodeSecurityProcessRunner: SecurityProcessRunner = {
  spawn(command, args, options) {
    return new Promise((resolve) => {
      let settled = false;
      let stderr = '';
      const finish = (result: SecurityProcessResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      let child;
      try {
        child = spawn(command, args, { shell: options.shell, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch {
        finish({ exitCode: 1 });
        return;
      }

      child.stderr.on('data', (chunk: Buffer | string) => {
        if (Buffer.byteLength(stderr, 'utf8') >= MAX_STDERR_BYTES) return;
        const remaining = MAX_STDERR_BYTES - Buffer.byteLength(stderr, 'utf8');
        stderr += Buffer.from(chunk).subarray(0, remaining).toString('utf8');
      });
      child.stdin.on('error', () => undefined);
      child.once('error', () => finish({ exitCode: 1 }));
      child.once('close', (code) => finish({ exitCode: code ?? 1, stderr }));

      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin);
      } else {
        child.stdin.end();
      }
    });
  },
};

export interface CredentialStatus {
  readonly exists: boolean;
}

export interface KeychainCredentialsOptions {
  readonly platform?: NodeJS.Platform | string;
  readonly runner?: SecurityProcessRunner;
}

/** Stores one fixed Harness API-key item in the login Keychain. */
export class MacOSKeychain {
  private readonly platform: NodeJS.Platform | string;
  private readonly runner: SecurityProcessRunner;

  constructor(options: KeychainCredentialsOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? nodeSecurityProcessRunner;
  }

  async set(secret: string | undefined): Promise<void> {
    this.assertMacOS();
    if (secret === undefined) throw new KeychainError('INPUT_CANCELLED');
    if (secret.length === 0) throw new KeychainError('INPUT_MISSING');

    const result = await this.runner.spawn(
      'security',
      ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { shell: false, stdin: secret },
    );
    this.assertSuccess(result);
  }

  async status(): Promise<CredentialStatus> {
    this.assertMacOS();
    const result = await this.runner.spawn(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      { shell: false },
    );
    if (result.exitCode === 0) return { exists: true };
    if (this.isMissing(result)) return { exists: false };
    this.assertSuccess(result);
    return { exists: false };
  }

  async clear(): Promise<void> {
    this.assertMacOS();
    const result = await this.runner.spawn(
      'security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      { shell: false },
    );
    this.assertSuccess(result);
  }

  private assertMacOS(): void {
    if (this.platform !== 'darwin') throw new KeychainError('UNSUPPORTED_PLATFORM');
  }

  private assertSuccess(result: SecurityProcessResult): void {
    if (result.exitCode === 0) return;
    if (this.isMissing(result)) throw new KeychainError('NOT_FOUND');
    if (this.isLocked(result)) throw new KeychainError('KEYCHAIN_LOCKED');
    throw new KeychainError('COMMAND_FAILED');
  }

  private isMissing(result: SecurityProcessResult): boolean {
    return result.exitCode === 44 || /(?:could not be found|not found)/i.test(result.stderr ?? '');
  }

  private isLocked(result: SecurityProcessResult): boolean {
    return /(?:keychain.*locked|interaction is not allowed|user interaction is not allowed)/i.test(result.stderr ?? '');
  }
}

/** Backwards-friendly name for callers that only need the credential store. */
export { MacOSKeychain as KeychainCredentials };
