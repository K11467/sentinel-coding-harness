import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { parseDocument } from 'yaml';
import {
  commandRuleSchema,
  parseHarnessConfig,
  policyRuleSchema,
  type HarnessConfig
} from '../domain/config.js';
import { DEFAULT_HARNESS_CONFIG } from './defaults.js';

const executableToken = /^[A-Za-z0-9._/-]+$/;
const forbiddenShellCharacters = /[\u0000\r\n;|&<>`$()]/;
const dependencyCommands = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const dangerousCommandNames = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'telnet', 'rm', 'git', 'sudo', 'dropdb'
]);
const dependencyOperations = new Set(['install', 'i', 'add', 'update', 'ci', 'publish']);
const interpreterAndWrapperCommands = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ash', 'ksh', 'csh', 'tcsh',
  'pwsh', 'powershell', 'cmd', 'cmd.exe', 'env',
  'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'pypy', 'perl', 'ruby', 'php', 'lua', 'rscript',
  'npx', 'tsx', 'ts-node', 'babel-node', 'jsc', 'qjs', 'd8',
  'command', 'exec', 'eval', 'source', 'xargs', 'timeout', 'nice', 'nohup', 'setsid', 'stdbuf'
]);
const interpreterSemanticArguments = new Set([
  '-c', '-e', '--eval', '--execute', '--command', '-command', '/c', '/k'
]);

const trustedTestCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string().min(1))
}).strict();

const configFileSchema = z.object({
  workspaceRoot: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  maxSteps: z.number().int().min(1).max(12).optional(),
  maxCostCny: z.number().min(1).max(70).optional(),
  allowedCommands: z.array(commandRuleSchema).optional(),
  policyRules: z.array(policyRuleSchema).optional(),
  testCommand: trustedTestCommandSchema
}).strict();

export interface TrustedTestCommand {
  command: string;
  args: string[];
}

export interface LoadedHarnessConfig extends HarnessConfig {
  /** This command originates only from a validated local config file. */
  testCommand: TrustedTestCommand;
}

export interface LoadHarnessConfigOptions {
  /** Defaults to the calling process cwd, which is also the workspaceRoot base. */
  cwd?: string;
  /** Defaults to <cwd>/harness.yaml. */
  configPath?: string;
}

export class HarnessConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessConfigLoadError';
  }
}

function diagnosticFromZod(error: z.ZodError): string {
  const fields = error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '配置根对象' : issue.path.join('.');
    return `${path}: ${issue.message}`;
  });
  return `配置无效：${fields.join('；')}`;
}

function isSafeToken(value: string): boolean {
  return executableToken.test(value) && !forbiddenShellCharacters.test(value) && !/\s/.test(value);
}

function isSafeArgument(value: string): boolean {
  return !forbiddenShellCharacters.test(value);
}

function commandName(command: string): string {
  return basename(command).toLowerCase();
}

function isInterpreterSemanticArgument(argument: string): boolean {
  const normalized = argument.toLowerCase();
  return interpreterSemanticArguments.has(normalized)
    || /^(?:-[ce].+|--(?:eval|execute|command)=)/.test(normalized);
}

function assertConservativeExecutable(command: string, field: string): string {
  if (!isSafeToken(command)) {
    throw new HarnessConfigLoadError(`配置无效：${field} 必须是单个安全可执行文件 token。`);
  }
  const name = commandName(command);
  if (interpreterAndWrapperCommands.has(name)) {
    throw new HarnessConfigLoadError(`危险 allow 配置：${field} 不得使用解释器或 wrapper ${name}。`);
  }
  return name;
}

function assertConservativeArguments(argumentsList: readonly string[], field: string): void {
  if (argumentsList.some((arg) => !isSafeArgument(arg))) {
    throw new HarnessConfigLoadError(`配置无效：${field} 不得包含 shell 控制字符。`);
  }
  if (argumentsList.some(isInterpreterSemanticArgument)) {
    throw new HarnessConfigLoadError(`危险 allow 配置：${field} 不得包含解释器执行语义。`);
  }
}

function isTrustedNpmPrefix(args: readonly string[]): boolean {
  return args[0] === 'test' || (args[0] === 'run' && args[1] === 'lint');
}

function assertTrustedTestCommand(command: TrustedTestCommand): void {
  assertConservativeArguments(command.args, 'testCommand.args');
  assertConservativeExecutable(command.command, 'testCommand.command');
  if (command.command !== 'npm' || !isTrustedNpmPrefix(command.args)) {
    throw new HarnessConfigLoadError('配置无效：testCommand 仅允许受信的 npm test 或 npm run lint 前缀。');
  }
}

function assertSafeAllowedCommands(config: Pick<HarnessConfig, 'allowedCommands'>): void {
  for (const rule of config.allowedCommands) {
    assertConservativeArguments(rule.argsPrefix, 'allowedCommands.argsPrefix');
    const name = assertConservativeExecutable(rule.command, 'allowedCommands.command');
    if (dangerousCommandNames.has(name)) {
      throw new HarnessConfigLoadError(`危险 allow 配置：allowedCommands 不得允许 ${name}。`);
    }
    if (dependencyCommands.has(name) && (rule.argsPrefix.length === 0 || dependencyOperations.has(rule.argsPrefix[0].toLowerCase()))) {
      throw new HarnessConfigLoadError('危险 allow 配置：allowedCommands 不得允许依赖安装、更新或发布。');
    }
    if (name === 'npm' && !isTrustedNpmPrefix(rule.argsPrefix)) {
      throw new HarnessConfigLoadError('危险 allow 配置：allowedCommands 中 npm 仅允许 test 或 run lint 前缀。');
    }
  }
}

function assertSafeAllowPolicies(config: Pick<HarnessConfig, 'policyRules'>): void {
  for (const rule of config.policyRules) {
    if (rule.effect !== 'allow') continue;

    const { match } = rule;
    const hasMatcher = (match.types?.length ?? 0) > 0
      || (match.pathPrefixes?.length ?? 0) > 0
      || (match.commands?.length ?? 0) > 0;
    if (!hasMatcher) {
      throw new HarnessConfigLoadError('危险 allow 配置：allow 策略必须包含非空 match 条件。');
    }

    if (match.types?.includes('run_command') && match.commands === undefined) {
      throw new HarnessConfigLoadError('危险 allow 配置：run_command 的 allow 策略必须限制具体 command。');
    }
    for (const command of match.commands ?? []) {
      const name = assertConservativeExecutable(command, 'policyRules.match.commands');
      if (dangerousCommandNames.has(name) || dependencyCommands.has(name)) {
        throw new HarnessConfigLoadError(`危险 allow 配置：策略不得允许 ${name}。`);
      }
    }
  }
}

function parseYamlConfig(source: string): unknown {
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new HarnessConfigLoadError('YAML 解析失败：配置文件语法无效。');
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new HarnessConfigLoadError('YAML 解析失败：不允许别名或无法安全转换的值。');
  }
}

/**
 * Loads only a local harness.yaml. The loader never reads credentials, and all
 * user-controlled values are validated before they reach the policy engine.
 */
export function loadHarnessConfig(options: LoadHarnessConfigOptions = {}): LoadedHarnessConfig {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? resolve(cwd, 'harness.yaml');
  let source: string;
  try {
    source = readFileSync(configPath, 'utf8');
  } catch {
    throw new HarnessConfigLoadError('无法读取 harness.yaml 配置文件。');
  }

  const raw = parseYamlConfig(source);
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HarnessConfigLoadError(diagnosticFromZod(parsed.error));
  }

  const { testCommand, ...input } = parsed.data;
  let config: HarnessConfig;
  try {
    config = parseHarnessConfig({ ...DEFAULT_HARNESS_CONFIG, ...input }, cwd);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new HarnessConfigLoadError(diagnosticFromZod(error));
    }
    throw new HarnessConfigLoadError('配置无效：workspaceRoot 必须是可访问的真实目录。');
  }

  assertTrustedTestCommand(testCommand);
  assertSafeAllowedCommands(config);
  assertSafeAllowPolicies(config);

  return {
    ...config,
    testCommand: { command: testCommand.command, args: [...testCommand.args] }
  };
}
