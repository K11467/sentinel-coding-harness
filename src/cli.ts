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
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

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
  return '用法：sentinel config check [--config <path>]';
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

  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      writeStdout(usage());
      return EXIT.OK;
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
    return error instanceof CliUsageError ? EXIT.USAGE : EXIT.CONFIG;
  }
}
