import { createHash } from 'node:crypto';
import { basename, isAbsolute, win32 } from 'node:path';
import type { Action, ActionType } from '../domain/actions.js';
import type { HarnessConfig, PolicyRule } from '../domain/config.js';

export type PolicyEffect = 'allow' | 'require_approval' | 'deny';
export type PolicyRisk = 'low' | 'medium' | 'high' | 'critical';

export interface PolicyDecision {
  effect: PolicyEffect;
  ruleId: string;
  risk: PolicyRisk;
  reason: string;
  actionHash: string;
}

const networkCommands = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'telnet'
]);
const knownActionTypes = new Set<ActionType>([
  'list_files', 'read_file', 'write_file', 'run_command', 'run_tests', 'remember', 'finish'
]);
const sourceExtensions = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.kts', '.vue', '.svelte', '.css', '.scss', '.html'
]);

type PathAction = Extract<Action, { type: 'list_files' | 'read_file' | 'write_file' }>;
type CommandAction = Extract<Action, { type: 'run_command' }>;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? JSON.stringify(String(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

/** A stable digest binds an approval to all action fields without exposing them in a decision. */
export function hashAction(action: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(action), 'utf8').digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isVerifiedActionShape(value: unknown): value is Action {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.reason) || typeof value.type !== 'string' || !knownActionTypes.has(value.type as ActionType)) {
    return false;
  }
  switch (value.type) {
    case 'list_files':
      return value.path === undefined || isNonEmptyString(value.path);
    case 'read_file':
      return isNonEmptyString(value.path);
    case 'write_file':
      return isNonEmptyString(value.path) && typeof value.content === 'string';
    case 'run_command':
      return isNonEmptyString(value.command) && isStringArray(value.args);
    case 'run_tests':
      return true;
    case 'remember':
      return isNonEmptyString(value.note);
    case 'finish':
      return isNonEmptyString(value.summary);
  }
  return false;
}

function isPathAction(action: Action): action is PathAction {
  return action.type === 'list_files' || action.type === 'read_file' || action.type === 'write_file';
}

function isCommandAction(action: Action): action is CommandAction {
  return action.type === 'run_command';
}

function actionPath(action: Action): string | undefined {
  return isPathAction(action) ? action.path : undefined;
}

function normalizedSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
}

function hasWorkspaceEscape(path: string | undefined): boolean {
  if (path === undefined) {
    return false;
  }
  return isAbsolute(path) || win32.isAbsolute(path) || normalizedSegments(path).includes('..');
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const candidate = normalizedSegments(path).join('/');
  const expected = normalizedSegments(prefix).join('/');
  return expected.length > 0 && (candidate === expected || candidate.startsWith(`${expected}/`));
}

function commandName(command: string): string {
  return basename(command).toLowerCase();
}

function hasArg(args: string[], value: string): boolean {
  return args.some((arg) => arg.toLowerCase() === value);
}

function isRecursiveRemove(action: CommandAction): boolean {
  if (commandName(action.command) !== 'rm') {
    return false;
  }
  return action.args.some((arg) => arg === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg));
}

function isGitPush(action: CommandAction): boolean {
  return commandName(action.command) === 'git' && hasArg(action.args, 'push');
}

function isPrivilegeEscalation(action: CommandAction): boolean {
  return commandName(action.command) === 'sudo';
}

function isPublishCommand(action: CommandAction): boolean {
  const command = commandName(action.command);
  return (['npm', 'pnpm', 'yarn', 'bun'].includes(command) && hasArg(action.args, 'publish'))
    || (command === 'gh' && hasArg(action.args, 'release'));
}

function isDatabaseDestruction(action: CommandAction): boolean {
  const command = commandName(action.command);
  if (command === 'dropdb') {
    return true;
  }
  const argumentsText = action.args.join(' ').toLowerCase();
  return ['psql', 'mysql', 'mariadb', 'sqlite3', 'mysqladmin'].includes(command)
    && /\b(drop\s+(database|table)|truncate\s+table|mysqladmin\s+drop)\b/.test(argumentsText);
}

function isCiOrReleasePath(path: string): boolean {
  const segments = normalizedSegments(path).map((segment) => segment.toLowerCase());
  const name = segments.at(-1) ?? '';
  return segments.includes('.github')
    || segments.includes('.circleci')
    || name === '.gitlab-ci.yml'
    || name === 'jenkinsfile'
    || name === 'azure-pipelines.yml'
    || name === '.releaserc'
    || name === '.npmrc'
    || name.startsWith('release.config.')
    || (segments.includes('scripts') && /^release[._-]/.test(name));
}

function isSourcePath(path: string): boolean {
  const name = normalizedSegments(path).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 && sourceExtensions.has(name.slice(dot).toLowerCase());
}

function commandHasPrefix(action: CommandAction, prefix: string[]): boolean {
  return prefix.every((expected, index) => action.args[index] === expected);
}

function matchesRule(action: Action, rule: PolicyRule): boolean {
  const { match } = rule;
  if (match.types !== undefined && !match.types.includes(action.type as ActionType)) {
    return false;
  }
  if (match.commands !== undefined && (!isCommandAction(action) || !match.commands.includes(action.command))) {
    return false;
  }
  if (match.pathPrefixes !== undefined) {
    const path = actionPath(action);
    if (path === undefined || !match.pathPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) {
      return false;
    }
  }
  return true;
}

type MandatoryApproval = { ruleId: string; reason: string };

function mandatoryApproval(action: Action): MandatoryApproval | undefined {
  if (action.type === 'write_file' && isCiOrReleasePath(action.path)) {
    return { ruleId: 'approval.ci-release-config', reason: 'CI 或发布配置修改需要人工确认。' };
  }
  if (!isCommandAction(action)) {
    return undefined;
  }

  const command = commandName(action.command);
  if (command === 'rm') {
    return { ruleId: 'approval.delete-command', reason: '删除命令需要人工确认。' };
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(command) && ['install', 'i', 'add', 'update', 'ci'].includes(action.args[0] ?? '')) {
    return { ruleId: 'approval.dependency-install', reason: '依赖安装或更新需要人工确认。' };
  }
  if (networkCommands.has(command)) {
    return { ruleId: 'approval.network-command', reason: '可能访问网络的命令需要人工确认。' };
  }
  if (command === 'git') {
    return { ruleId: 'approval.git-command', reason: 'Git 操作需要人工确认。' };
  }
  return undefined;
}

/**
 * Deterministic action policy. Precedence is fixed: action-shape deny, hard
 * deny, mandatory approval, configured policy/allowlist, then safe defaults.
 */
export class PolicyEngine {
  constructor(private readonly config: HarnessConfig) {}

  decide(action: Action): PolicyDecision {
    const actionHash = hashAction(action);
    if (!isVerifiedActionShape(action)) {
      return {
        effect: 'deny',
        ruleId: 'deny.unknown-action',
        risk: 'critical',
        reason: '动作类型或结构未通过策略输入校验。',
        actionHash
      };
    }
    const decide = (effect: PolicyEffect, ruleId: string, risk: PolicyRisk, reason: string): PolicyDecision => ({
      effect,
      ruleId,
      risk,
      reason,
      actionHash
    });

    if (hasWorkspaceEscape(actionPath(action))) {
      return decide('deny', 'deny.workspace-boundary', 'critical', '动作路径不在受控工作区内。');
    }
    if (isCommandAction(action) && isRecursiveRemove(action)) {
      return decide('deny', 'deny.recursive-delete', 'critical', '递归删除命令不可执行。');
    }
    if (isCommandAction(action) && isGitPush(action)) {
      return decide('deny', 'deny.git-push', 'critical', '推送到远程仓库不可执行。');
    }
    if (isCommandAction(action) && isPrivilegeEscalation(action)) {
      return decide('deny', 'deny.privilege-escalation', 'critical', '提权命令不可执行。');
    }
    if (isCommandAction(action) && isPublishCommand(action)) {
      return decide('deny', 'deny.publish', 'critical', '发布命令不可执行。');
    }
    if (isCommandAction(action) && isDatabaseDestruction(action)) {
      return decide('deny', 'deny.database-destruction', 'critical', '破坏性数据库命令不可执行。');
    }

    const mandatory = mandatoryApproval(action);
    if (mandatory !== undefined) {
      return decide('require_approval', mandatory.ruleId, 'high', mandatory.reason);
    }

    const configuredRule = this.config.policyRules.find((rule) => matchesRule(action, rule));
    if (configuredRule !== undefined) {
      return decide(configuredRule.effect, configuredRule.id, configuredRule.risk, '命中显式配置策略。');
    }

    if (isCommandAction(action) && this.config.allowedCommands.some((rule) => rule.command === action.command && commandHasPrefix(action, rule.argsPrefix))) {
      return decide('allow', 'allow.allowed-command', 'low', '命中受控命令白名单。');
    }

    if (action.type === 'list_files') {
      return decide('allow', 'allow.workspace-list', 'low', '工作区目录列举为只读操作。');
    }
    if (action.type === 'read_file') {
      return decide('allow', 'allow.workspace-read', 'low', '工作区文件读取为只读操作。');
    }
    if (action.type === 'run_tests') {
      return decide('allow', 'allow.run-tests', 'low', '受控测试工具可执行。');
    }
    if (action.type === 'remember') {
      return decide('allow', 'allow.remember', 'low', '受限长度的本地记忆可保存。');
    }
    if (action.type === 'finish') {
      return decide('allow', 'allow.finish', 'low', '结束动作不访问工作区或外部资源。');
    }
    if (action.type === 'write_file') {
      if (isSourcePath(action.path)) {
        return decide('allow', 'allow.source-write', 'low', '普通源文件写入可执行。');
      }
      return decide('require_approval', 'approval.unknown-write', 'high', '非普通源文件写入需要人工确认。');
    }

    const command = commandName(action.command);
    if (command === 'npm' && action.args[0] === 'test') {
      return decide('allow', 'allow.npm-test', 'low', '受控 npm 测试命令可执行。');
    }
    if (command === 'npm' && action.args[0] === 'run' && action.args[1] === 'lint') {
      return decide('allow', 'allow.npm-run-lint', 'low', '受控 npm lint 命令可执行。');
    }
    return decide('require_approval', 'approval.unknown-command', 'high', '未识别命令需要人工确认。');
  }
}
