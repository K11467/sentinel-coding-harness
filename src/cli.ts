#!/usr/bin/env node

import { loadHarnessConfig, type LoadHarnessConfigOptions, type LoadedHarnessConfig } from './config/load.js';
import { createProductionRuntime } from './cli-runtime.js';
import { MacOSKeychain } from './credentials/keychain.js';
import { runMechanismScenarios } from './demo/scenarios.js';
import type { SessionState } from './domain/session.js';
import type { AuditRecord } from './observability/audit.js';
import { redactText } from './observability/redact.js';
import { PolicyEngine } from './security/policy.js';

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
  /** Provider-only read method. The CLI never prints its return value. */
  get?(): Promise<string>;
}

/** Adapter seam for provider/session/approval modules that are merged after T14. */
export interface CliRuntime {
  run(input: { task: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  resume(input: { sessionId: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  approve(input: { sessionId: string; actionHash: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  reject(input: { sessionId: string; actionHash: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  inspect?(input: { sessionId: string; config: LoadedHarnessConfig }): Promise<SessionState>;
  audit?(input: { sessionId: string; config: LoadedHarnessConfig }): Promise<AuditRecord[]>;
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

type HiddenInput = {
  readonly isTTY?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
  on?: (event: string, listener: (value: Buffer | string | Error) => void) => unknown;
  removeListener?: (event: string, listener: (value: Buffer | string | Error) => void) => unknown;
};

type HiddenOutput = {
  readonly isTTY?: boolean;
  write(value: string): unknown;
};

/**
 * Reads one credential only from an interactive terminal while raw mode is on.
 * No typed character is written to the terminal, command line, logs, or errors.
 */
export function readHiddenFromTty(input: HiddenInput = process.stdin, output: HiddenOutput = process.stderr): Promise<string | undefined> {
  if (
    input.isTTY !== true
    || output.isTTY !== true
    || typeof input.setRawMode !== 'function'
    || typeof input.on !== 'function'
    || typeof input.removeListener !== 'function'
  ) {
    throw new CliUnavailableError('凭据设置需要交互 TTY；非交互输入已被安全拒绝。');
  }

  const setRawMode = input.setRawMode;
  const subscribe = input.on;
  const unsubscribe = input.removeListener;

  output.write('请输入 API Key（隐藏输入，回车确认；Ctrl-C 取消）：');
  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;
    const cleanup = (): void => {
      unsubscribe('data', onData);
      unsubscribe('error', onData);
      setRawMode(false);
      input.pause?.();
    };
    const finish = (result: string | undefined, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      if (error === undefined) resolve(result);
      else reject(error);
    };
    const onData = (chunk: Buffer | string | Error): void => {
      if (chunk instanceof Error) {
        finish(undefined, new CliUnavailableError('隐藏凭据输入不可用；未保存任何内容。'));
        return;
      }
      for (const character of (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)) {
        if (character === '\u0003') {
          finish(undefined);
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    setRawMode(true);
    input.resume?.();
    subscribe('data', onData);
    subscribe('error', onData);
  });
}

function demoSession(): SessionState {
  return {
    id: 'demo-mechanisms',
    status: 'completed',
    step: 0,
    task: '运行离线确定性机制演示。',
    stopReason: 'finished',
    recentActions: [],
    recentFeedback: [],
  };
}

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
      await runMechanismScenarios();
      return demoSession();
    },
  };
}

function supportsProviderCredentials(credentials: CredentialStore): credentials is CredentialStore & { get(): Promise<string> } {
  return typeof credentials.get === 'function';
}

function defaultRuntime(credentials: CredentialStore): CliRuntime {
  if (!supportsProviderCredentials(credentials)) return unavailableRuntime();
  const runtime = createProductionRuntime({ credentials });
  return {
    ...runtime,
    async demo() {
      await runMechanismScenarios();
      return demoSession();
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
      throw new CliUsageError('不支持的选项。');
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
  return '用法：sentinel <config check|run <task>|resume <session>|approve <session> <hash>|reject|deny <session> <hash>|inspect <session>|audit <session>|credentials status|credentials set|credentials clear|demo> [--config <path>]';
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

const actionTypes = new Set(['list_files', 'read_file', 'write_file', 'run_command', 'run_tests', 'remember', 'finish']);
const policyEffects = new Set(['allow', 'require_approval', 'deny']);
const policyRisks = new Set(['low', 'medium', 'high', 'critical']);
const sessionStatuses = new Set(['created', 'running', 'waiting_approval', 'completed', 'stopped', 'blocked', 'failed', 'budget_exhausted', 'cancelled']);

function safeDisplay(value: unknown, maxBytes = 256): string {
  return typeof value === 'string'
    ? redactText(value.replace(/[\r\n\0]/g, ' '), maxBytes)
    : 'unknown';
}

function safeEnum(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

/** Displays only approval metadata, never a pending write body or command output. */
function inspectionSummary(session: SessionState, config: LoadedHarnessConfig): string {
  const lines = [sessionSummary(session)];
  if (session.status !== 'waiting_approval' || session.pendingAction === undefined) return lines.join('\n');

  const { action, actionHash } = session.pendingAction;
  const details = action.type === 'list_files'
    ? action.path === undefined ? '' : `，path=${safeDisplay(action.path)}`
    : action.type === 'read_file' || action.type === 'write_file'
      ? `，path=${safeDisplay(action.path)}`
      : action.type === 'run_command'
        ? `，command=${safeDisplay(action.command)}`
        : '';
  const decision = new PolicyEngine(config).decide(action);
  lines.push(`待审批：type=${action.type}${details}，actionHash=${safeDisplay(actionHash)}`);
  lines.push(`策略：effect=${safeEnum(decision.effect, policyEffects)}，rule=${safeDisplay(decision.ruleId)}，risk=${safeEnum(decision.risk, policyRisks)}，reason=${safeDisplay(decision.reason)}`);
  return lines.join('\n');
}

/** Converts one normalized audit record through a fixed, non-serializing display allowlist. */
function auditSummary(record: AuditRecord): string {
  const actionType = safeEnum(record.action?.type, actionTypes);
  switch (record.event) {
    case 'policy_decision':
      return `策略：action=${actionType}，effect=${safeEnum(record.policy?.effect, policyEffects)}，rule=${safeDisplay(record.policy?.ruleId)}，risk=${safeEnum(record.policy?.risk, policyRisks)}，reason=${safeDisplay(record.policy?.reason)}`;
    case 'tool_result': {
      const exitCode = Number.isSafeInteger(record.tool?.exitCode) ? `，exitCode=${record.tool!.exitCode}` : '';
      const errorCode = record.tool?.errorCode === undefined ? '' : `，error=${safeDisplay(record.tool.errorCode)}`;
      const output = record.tool?.output === undefined ? '' : `，summary=${safeDisplay(record.tool.output)}`;
      return `工具：action=${actionType}，kind=${safeEnum(record.tool?.kind, actionTypes)}，ok=${record.tool?.ok === true ? 'true' : 'false'}${exitCode}${errorCode}${output}`;
    }
    case 'state_transition': {
      const reason = record.state?.reason === undefined ? '' : `，reason=${safeDisplay(record.state.reason)}`;
      return `状态：from=${safeEnum(record.state?.from, sessionStatuses)}，to=${safeEnum(record.state?.to, sessionStatuses)}${reason}`;
    }
    default:
      return '审计：未识别条目。';
  }
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

  if (command === 'inspect' || command === 'audit') {
    if (positional.length !== 1 || !isSafeIdentifier(positional[0]!)) {
      throw new CliUsageError(`${command} 需要一个安全的 session 标识。`);
    }
    const input = { sessionId: positional[0]!, config };
    if (command === 'inspect') {
      if (runtime.inspect === undefined) throw new CliUnavailableError('当前运行环境未提供持久会话检查功能。');
      writeStdout(inspectionSummary(await runtime.inspect(input), config));
      return EXIT.OK;
    }
    if (runtime.audit === undefined) throw new CliUnavailableError('当前运行环境未提供审计读取功能。');
    const records = await runtime.audit(input);
    writeStdout(`审计记录：${records.length}。`);
    for (const record of records) {
      writeStdout(auditSummary(record));
    }
    return EXIT.OK;
  }

  throw new CliUsageError(`未知会话命令：${command}`);
}

async function runCredentials(
  args: readonly string[],
  credentials: CredentialStore,
  readHidden: () => Promise<string | undefined>,
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
  const credentials = dependencies.credentials ?? new MacOSKeychain();
  const runtime = dependencies.runtime ?? defaultRuntime(credentials);
  const readHidden = dependencies.readHidden ?? readHiddenFromTty;

  try {
    rejectApiKeyArgument(argv);
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      writeStdout(usage());
      return EXIT.OK;
    }

    if (argv[0] === 'credentials') {
      return await runCredentials(argv.slice(1), credentials, readHidden, writeStdout);
    }

    if (argv[0] === 'demo') {
      if (argv.length !== 1) throw new CliUsageError('demo 不接受额外参数。');
      const report = await runMechanismScenarios();
      for (const scenario of report.scenarios) {
        writeStdout(`演示 ${scenario.name}：通过。`);
      }
      return EXIT.OK;
    }

    if (argv[0] === 'run' || argv[0] === 'resume' || argv[0] === 'approve' || argv[0] === 'reject' || argv[0] === 'deny' || argv[0] === 'inspect' || argv[0] === 'audit') {
      const command = argv[0] === 'deny' ? 'reject' : argv[0];
      return await runSessionCommand(command, argv.slice(1), loadConfig, cwd, credentials, runtime, writeStdout);
    }

    if (argv[0] !== 'config' || argv[1] !== 'check') {
      throw new CliUsageError(`未知命令。${usage()}`);
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
