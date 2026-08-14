import { loadHarnessConfig, type LoadHarnessConfigOptions, type LoadedHarnessConfig } from './config/load.js';
import { redactText } from './observability/redact.js';

/** Stable process-style results for CLI callers and the later executable wrapper. */
export const EXIT = {
  OK: 0,
  USAGE: 64,
  CONFIG: 78,
  UNAVAILABLE: 69,
  FAILURE: 70,
} as const;

export interface CliDependencies {
  cwd?: string;
  loadConfig?: (options: LoadHarnessConfigOptions) => LoadedHarnessConfig;
  credentials?: CredentialStore;
  readHidden?: () => Promise<string | undefined>;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

/** Narrow adapter implemented by T12 after its Keychain code is merged. */
export interface CredentialStore {
  status(): Promise<{ exists: boolean }>;
  set(value: string | undefined): Promise<void>;
  clear(): Promise<void>;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

class CliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUnavailableError';
  }
}

const unavailableCredentials: CredentialStore = {
  async status() {
    return { exists: false };
  },
  async set() {
    throw new CliUnavailableError('当前运行环境未提供 Keychain 凭据适配器；请完成 credentials 集成后重试。');
  },
  async clear() {
    throw new CliUnavailableError('当前运行环境未提供 Keychain 凭据适配器；请完成 credentials 集成后重试。');
  },
};

function parseConfigPath(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === '--config' && args[1]!.length > 0) {
    return args[1];
  }
  if (args.includes('--api-key') || args.some((arg) => arg.startsWith('--api-key='))) {
    throw new CliUsageError('不接受 --api-key；请使用 credentials set 并由系统 Keychain 保存凭据。');
  }
  throw new CliUsageError('参数无效；仅支持可选的 --config <path>。');
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message.length > 0
    ? error.message
    : '操作未完成。';
  return redactText(message, 1024);
}

function usage(): string {
  return '用法：sentinel <config check|credentials status|credentials set|credentials clear> [--config <path>]';
}

async function runCredentials(
  args: readonly string[],
  credentials: CredentialStore,
  readHidden: (() => Promise<string | undefined>) | undefined,
  writeStdout: (line: string) => void,
): Promise<number> {
  if (args.length !== 1) {
    throw new CliUsageError('credentials 仅支持 status、set 或 clear，且不接受凭据命令行参数。');
  }

  switch (args[0]) {
    case 'status': {
      const status = await credentials.status();
      writeStdout(status.exists ? '凭据状态：已配置。' : '凭据状态：未配置。请执行 credentials set。');
      return EXIT.OK;
    }
    case 'set': {
      if (readHidden === undefined) {
        throw new CliUnavailableError('当前运行环境未提供隐藏凭据输入；请完成 Keychain 凭据集成后重试。');
      }
      const secret = await readHidden();
      await credentials.set(secret);
      writeStdout('凭据已保存到系统安全存储。');
      return EXIT.OK;
    }
    case 'clear':
      await credentials.clear();
      writeStdout('凭据已清除。');
      return EXIT.OK;
    default:
      throw new CliUsageError('credentials 仅支持 status、set 或 clear。');
  }
}

/**
 * Command surface intentionally accepts argv and output sinks as dependencies.
 * This keeps parsing deterministic and prevents tests or future embedders from
 * requiring a real provider, Keychain, or process-global I/O.
 */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeStderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const cwd = dependencies.cwd ?? process.cwd();
  const loadConfig = dependencies.loadConfig ?? loadHarnessConfig;
  const credentials = dependencies.credentials ?? unavailableCredentials;

  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      writeStdout(usage());
      return EXIT.OK;
    }

    if (argv[0] === 'credentials') {
      return await runCredentials(argv.slice(1), credentials, dependencies.readHidden, writeStdout);
    }

    if (argv[0] !== 'config' || argv[1] !== 'check') {
      throw new CliUsageError(`未知命令：${argv.join(' ') || '(empty)'}。${usage()}`);
    }

    const configPath = parseConfigPath(argv.slice(2));
    const config = loadConfig({ cwd, configPath });
    writeStdout(`配置有效。workspaceRoot=${config.workspaceRoot}，maxSteps=${config.maxSteps}，maxCostCny=${config.maxCostCny}`);
    return EXIT.OK;
  } catch (error) {
    writeStderr(safeErrorMessage(error));
    if (error instanceof CliUsageError) return EXIT.USAGE;
    if (error instanceof CliUnavailableError) return EXIT.UNAVAILABLE;
    return argv[0] === 'config' ? EXIT.CONFIG : EXIT.FAILURE;
  }
}
