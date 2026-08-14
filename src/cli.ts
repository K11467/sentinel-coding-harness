import { loadHarnessConfig, type LoadHarnessConfigOptions, type LoadedHarnessConfig } from './config/load.js';
import { AgentLoop, InMemorySessionStore } from './core/agent-loop.js';
import { ActionParser } from './domain/actions.js';
import type { HarnessConfig } from './domain/config.js';
import type { SessionState } from './domain/session.js';
import { ScriptedMockLLM } from './llm/scripted-mock.js';
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
  runtime?: CliRuntime;
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

/** Adapter seam for provider/session/approval modules that are merged after T14. */
export interface CliRuntime {
  run(input: { task: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  resume(input: { sessionId: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  approve(input: { sessionId: string; actionHash: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  reject(input: { sessionId: string; actionHash: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  demo(): Promise<SessionState>;
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

class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliConfigError';
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

function unavailableRuntime(): CliRuntime {
  const fail = async (): Promise<SessionState> => {
    throw new CliUnavailableError('当前运行环境未提供 Provider 或会话适配器；请完成运行时集成后重试。');
  };
  return {
    run: fail,
    resume: fail,
    approve: fail,
    reject: fail,
    async demo() {
      const client = new ScriptedMockLLM([{
        type: 'finish',
        reason: '离线 mock 演示安全结束。',
        summary: '离线 mock 演示已完成；没有访问网络或真实 Provider。',
      }]);
      const sessions = new InMemorySessionStore();
      const config: HarnessConfig = {
        workspaceRoot: process.cwd(),
        model: 'offline-scripted-mock',
        maxSteps: 1,
        maxCostCny: 1,
        allowedCommands: [],
        policyRules: [],
      };
      const loop = new AgentLoop({
        config,
        client,
        parser: new ActionParser(() => 'demo-finish-action'),
        dispatcher: { async dispatch() { return { category: 'passed', summary: 'demo 不会执行工具。' }; } },
        sessions,
      });
      return loop.run({
        id: 'demo-session',
        status: 'created',
        step: 0,
        task: '运行离线安全演示。',
        recentActions: [],
        recentFeedback: [],
      });
    },
  };
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

function rejectApiKeyArgument(argv: readonly string[]): void {
  if (argv.includes('--api-key') || argv.some((arg) => arg.startsWith('--api-key='))) {
    throw new CliUsageError('不接受 --api-key；请使用 credentials set 并由系统 Keychain 保存凭据。');
  }
}

function splitConfigArgument(args: readonly string[]): { positional: string[]; configPath?: string } {
  const positional: string[] = [];
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--config') {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--') || configPath !== undefined) {
        throw new CliUsageError('每个命令最多接受一个 --config <path>。');
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      throw new CliUsageError(`不支持的选项：${argument}`);
    }
    positional.push(argument);
  }
  return { positional, configPath };
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message.length > 0
    ? error.message
    : '操作未完成。';
  return redactText(message, 1024);
}

function usage(): string {
  return '用法：sentinel <config check|run <task>|resume <session>|approve <session> <hash>|reject <session> <hash>|credentials status|credentials set|credentials clear|demo> [--config <path>]';
}

function loadCliConfig(
  loadConfig: (options: LoadHarnessConfigOptions) => LoadedHarnessConfig,
  cwd: string,
  configPath: string | undefined,
): LoadedHarnessConfig {
  try {
    return loadConfig({ cwd, configPath });
  } catch (error) {
    throw new CliConfigError(safeErrorMessage(error));
  }
}

function sessionSummary(session: SessionState): string {
  const reason = session.stopReason === undefined ? '' : `，stopReason=${session.stopReason}`;
  return redactText(`会话 ${session.id}：status=${session.status}，step=${session.step}${reason}`, 1024);
}

async function runSessionCommand(
  command: string,
  args: readonly string[],
  loadConfig: (options: LoadHarnessConfigOptions) => LoadedHarnessConfig,
  cwd: string,
  credentials: CredentialStore,
  runtime: CliRuntime,
  writeStdout: (line: string) => void,
): Promise<number> {
  const { positional, configPath } = splitConfigArgument(args);
  const config = loadCliConfig(loadConfig, cwd, configPath);

  if (command === 'run') {
    if (positional.length === 0) throw new CliUsageError('run 需要非空任务文本。');
    const status = await credentials.status();
    if (!status.exists) {
      throw new CliUnavailableError('未配置凭据；请先执行 credentials set，再运行任务。');
    }
    const session = await runtime.run({ task: positional.join(' '), config });
    writeStdout(sessionSummary(session));
    return EXIT.OK;
  }

  if (command === 'resume') {
    if (positional.length !== 1 || !isSafeIdentifier(positional[0]!)) {
      throw new CliUsageError('resume 需要一个安全的 session 标识。');
    }
    const session = await runtime.resume({ sessionId: positional[0]!, config });
    writeStdout(sessionSummary(session));
    return EXIT.OK;
  }

  if ((command === 'approve' || command === 'reject')) {
    if (positional.length !== 2 || !isSafeIdentifier(positional[0]!) || !isSafeIdentifier(positional[1]!)) {
      throw new CliUsageError(`${command} 需要安全的 session 标识和 action hash。`);
    }
    const input = { sessionId: positional[0]!, actionHash: positional[1]!, config };
    const session = command === 'approve'
      ? await runtime.approve(input)
      : await runtime.reject(input);
    writeStdout(sessionSummary(session));
    return EXIT.OK;
  }

  throw new CliUsageError(`未知会话命令：${command}`);
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
  const runtime = dependencies.runtime ?? unavailableRuntime();

  try {
    rejectApiKeyArgument(argv);
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      writeStdout(usage());
      return EXIT.OK;
    }

    if (argv[0] === 'credentials') {
      return await runCredentials(argv.slice(1), credentials, dependencies.readHidden, writeStdout);
    }

    if (argv[0] === 'demo') {
      if (argv.length !== 1) throw new CliUsageError('demo 不接受额外参数。');
      const session = await runtime.demo();
      writeStdout(sessionSummary(session));
      return EXIT.OK;
    }

    if (argv[0] === 'run' || argv[0] === 'resume' || argv[0] === 'approve' || argv[0] === 'reject') {
      return await runSessionCommand(argv[0], argv.slice(1), loadConfig, cwd, credentials, runtime, writeStdout);
    }

    if (argv[0] !== 'config' || argv[1] !== 'check') {
      throw new CliUsageError(`未知命令：${argv.join(' ') || '(empty)'}。${usage()}`);
    }

    const configPath = parseConfigPath(argv.slice(2));
    const config = loadCliConfig(loadConfig, cwd, configPath);
    writeStdout(redactText(`配置有效。workspaceRoot=${config.workspaceRoot}，maxSteps=${config.maxSteps}，maxCostCny=${config.maxCostCny}`, 1024));
    return EXIT.OK;
  } catch (error) {
    writeStderr(safeErrorMessage(error));
    if (error instanceof CliUsageError) return EXIT.USAGE;
    if (error instanceof CliConfigError) return EXIT.CONFIG;
    if (error instanceof CliUnavailableError) return EXIT.UNAVAILABLE;
    return EXIT.FAILURE;
  }
}

/** Process entrypoint used by the compiled `sentinel` bin; imports remain side-effect free. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  return runCli(argv);
}

if (require.main === module) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = EXIT.FAILURE;
  });
}
