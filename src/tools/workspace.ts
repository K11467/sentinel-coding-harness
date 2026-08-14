import { constants, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

/** The largest text file the harness may expose to an action. */
export const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;

export type WorkspaceToolKind = 'list' | 'read' | 'write';

export type WorkspaceToolErrorCode =
  | 'invalid_path'
  | 'symlink_escape'
  | 'workspace_changed'
  | 'path_not_found'
  | 'not_a_directory'
  | 'not_a_file'
  | 'binary_file'
  | 'file_too_large'
  | 'io_error';

export interface WorkspaceToolError {
  ok: false;
  kind: WorkspaceToolKind;
  errorCode: WorkspaceToolErrorCode;
  message: string;
}

export interface ListWorkspaceSuccess {
  ok: true;
  kind: 'list';
  path: string;
  entries: string[];
}

export interface ReadWorkspaceSuccess {
  ok: true;
  kind: 'read';
  path: string;
  content: string;
}

export interface WriteWorkspaceSuccess {
  ok: true;
  kind: 'write';
  path: string;
  bytesWritten: number;
}

export type ListWorkspaceResult = ListWorkspaceSuccess | WorkspaceToolError;
export type ReadWorkspaceResult = ReadWorkspaceSuccess | WorkspaceToolError;
export type WriteWorkspaceResult = WriteWorkspaceSuccess | WorkspaceToolError;

/** Only tests may use this hook to deterministically exercise the spawn window. */
export interface WorkspaceToolsOptions {
  beforeWorkerStartForTesting?: () => void | Promise<void>;
}

type ExistingPathResult =
  | { ok: true; realPath: string; displayPath: string }
  | { ok: false; error: WorkspaceToolError };

type WritePathResult =
  | { ok: true; parentPath: string; name: string; displayPath: string }
  | { ok: false; error: WorkspaceToolError };

type WorkspaceIdentity = { device: string; inode: string };

type WorkerOperation = 'list' | 'read' | 'write';

interface WorkspaceWorkerInput {
  operation: WorkerOperation;
  workspaceRoot: string;
  workspaceDevice: string;
  workspaceInode: string;
  name?: string;
  content?: string;
}

type WorkspaceWorkerResponse =
  | { ok: true; entries?: string[]; content?: string; bytesWritten?: number }
  | { ok: false; errorCode: WorkspaceToolErrorCode };

const workerErrorCodes = new Set<WorkspaceToolErrorCode>([
  'symlink_escape',
  'workspace_changed',
  'path_not_found',
  'not_a_directory',
  'not_a_file',
  'binary_file',
  'file_too_large',
  'io_error'
]);

const workspaceWorkerSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(process.argv[1]);
const maximumFileBytes = 256 * 1024;

function controlledError(errorCode) {
  const exception = new Error(errorCode);
  exception.workspaceErrorCode = errorCode;
  return exception;
}

function isWithin(root, candidate) {
  const fromRoot = path.relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith('..' + path.sep) && !path.isAbsolute(fromRoot));
}

function requireName() {
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name !== path.basename(input.name)) {
    throw controlledError('io_error');
  }
  return input.name;
}

function verifyWorkspaceAndCwd() {
  const rootStats = fs.statSync(input.workspaceRoot, { bigint: true });
  if (String(rootStats.dev) !== input.workspaceDevice || String(rootStats.ino) !== input.workspaceInode) {
    throw controlledError('workspace_changed');
  }
  const canonicalRoot = fs.realpathSync(input.workspaceRoot);
  if (canonicalRoot !== input.workspaceRoot) {
    throw controlledError('workspace_changed');
  }
  const canonicalCwd = fs.realpathSync('.');
  if (!isWithin(canonicalRoot, canonicalCwd)) {
    throw controlledError('workspace_changed');
  }
}

function readTextFile() {
  const descriptor = fs.openSync(requireName(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw controlledError('not_a_file');
    }
    if (metadata.size > maximumFileBytes) {
      throw controlledError('file_too_large');
    }
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) {
        break;
      }
      offset += count;
    }
    const content = buffer.subarray(0, offset);
    if (content.includes(0)) {
      throw controlledError('binary_file');
    }
    try {
      return { ok: true, content: new TextDecoder('utf-8', { fatal: true }).decode(content) };
    } catch {
      throw controlledError('binary_file');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeTextFile() {
  if (typeof input.content !== 'string') {
    throw controlledError('io_error');
  }
  const content = Buffer.from(input.content, 'utf8');
  if (content.byteLength > maximumFileBytes) {
    throw controlledError('file_too_large');
  }
  const descriptor = fs.openSync(
    requireName(),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw controlledError('not_a_file');
    }
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, content);
    return { ok: true, bytesWritten: content.byteLength };
  } finally {
    fs.closeSync(descriptor);
  }
}

try {
  verifyWorkspaceAndCwd();
  let result;
  if (input.operation === 'list') {
    result = { ok: true, entries: fs.readdirSync('.').sort() };
  } else if (input.operation === 'read') {
    result = readTextFile();
  } else if (input.operation === 'write') {
    result = writeTextFile();
  } else {
    throw controlledError('io_error');
  }
  process.stdout.write(JSON.stringify(result));
} catch (caught) {
  const errorCode = caught && typeof caught.workspaceErrorCode === 'string'
    ? caught.workspaceErrorCode
    : caught && caught.code === 'ENOENT'
      ? 'path_not_found'
      : caught && caught.code === 'ELOOP'
        ? 'symlink_escape'
        : 'io_error';
  process.stdout.write(JSON.stringify({ ok: false, errorCode }));
}
`;

function error(kind: WorkspaceToolKind, errorCode: WorkspaceToolErrorCode, message: string): WorkspaceToolError {
  return { ok: false, kind, errorCode, message };
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === '..');
}

function isMissing(errorValue: unknown): boolean {
  return typeof errorValue === 'object' && errorValue !== null && 'code' in errorValue && errorValue.code === 'ENOENT';
}

function isWorkerErrorCode(value: unknown): value is WorkspaceToolErrorCode {
  return typeof value === 'string' && workerErrorCodes.has(value as WorkspaceToolErrorCode);
}

/**
 * Controlled filesystem operations rooted at one already-authorized workspace.
 * I/O is performed by a short-lived process whose current directory is anchored
 * before it verifies that both the workspace and the anchored directory remain safe.
 */
export class WorkspaceTools {
  private readonly root: string;
  private readonly workspaceIdentity: WorkspaceIdentity;

  constructor(workspaceRoot: string, private readonly options: WorkspaceToolsOptions = {}) {
    this.root = realpathSync(resolve(workspaceRoot));
    const rootStats = statSync(this.root, { bigint: true });
    this.workspaceIdentity = { device: String(rootStats.dev), inode: String(rootStats.ino) };
  }

  async list(path = '.'): Promise<ListWorkspaceResult> {
    const target = await this.resolveExisting('list', path);
    if (!target.ok) {
      return target.error;
    }

    const worker = await this.runWorker(target.realPath, { operation: 'list' });
    if (!worker.ok) {
      return this.workerError('list', worker.errorCode);
    }
    if (!Array.isArray(worker.entries) || worker.entries.some((entry) => typeof entry !== 'string')) {
      return error('list', 'io_error', '工作区工具返回了无效目录结果。');
    }
    return { ok: true, kind: 'list', path: target.displayPath, entries: worker.entries };
  }

  async read(path: string): Promise<ReadWorkspaceResult> {
    const target = await this.resolveExisting('read', path);
    if (!target.ok) {
      return target.error;
    }

    const worker = await this.runWorker(dirname(target.realPath), { operation: 'read', name: basename(target.realPath) });
    if (!worker.ok) {
      return this.workerError('read', worker.errorCode);
    }
    if (typeof worker.content !== 'string') {
      return error('read', 'io_error', '工作区工具返回了无效读取结果。');
    }
    return { ok: true, kind: 'read', path: target.displayPath, content: worker.content };
  }

  async write(path: string, content: string): Promise<WriteWorkspaceResult> {
    if (typeof content !== 'string') {
      return error('write', 'io_error', '写入内容必须是字符串。');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_WORKSPACE_FILE_BYTES) {
      return error('write', 'file_too_large', '写入内容超过 256 KiB 上限。');
    }

    const target = await this.resolveWritePath(path);
    if (!target.ok) {
      return target.error;
    }

    const worker = await this.runWorker(target.parentPath, { operation: 'write', name: target.name, content });
    if (!worker.ok) {
      return this.workerError('write', worker.errorCode);
    }
    if (typeof worker.bytesWritten !== 'number') {
      return error('write', 'io_error', '工作区工具返回了无效写入结果。');
    }
    return { ok: true, kind: 'write', path: target.displayPath, bytesWritten: worker.bytesWritten };
  }

  private async resolveExisting(kind: WorkspaceToolKind, input: string): Promise<ExistingPathResult> {
    const candidate = this.resolveCandidate(kind, input);
    if (!candidate.ok) {
      return candidate;
    }

    try {
      const canonicalPath = await realpath(candidate.path);
      if (!isWithin(this.root, canonicalPath)) {
        return { ok: false, error: error(kind, 'symlink_escape', '符号链接目标位于工作区外。') };
      }
      return { ok: true, realPath: canonicalPath, displayPath: candidate.displayPath };
    } catch (caught) {
      return { ok: false, error: this.filesystemError(kind, caught) };
    }
  }

  private async resolveWritePath(input: string): Promise<WritePathResult> {
    const candidate = this.resolveCandidate('write', input);
    if (!candidate.ok) {
      return candidate;
    }

    try {
      const canonicalParent = await realpath(dirname(candidate.path));
      if (!isWithin(this.root, canonicalParent)) {
        return { ok: false, error: error('write', 'symlink_escape', '写入父目录经符号链接位于工作区外。') };
      }
      return {
        ok: true,
        parentPath: canonicalParent,
        name: basename(candidate.path),
        displayPath: candidate.displayPath
      };
    } catch (caught) {
      return { ok: false, error: this.filesystemError('write', caught) };
    }
  }

  private resolveCandidate(kind: WorkspaceToolKind, input: string):
    | { ok: true; path: string; displayPath: string }
    | { ok: false; error: WorkspaceToolError } {
    if (typeof input !== 'string' || input.length === 0 || isAbsolute(input) || win32.isAbsolute(input) || hasParentTraversal(input)) {
      return { ok: false, error: error(kind, 'invalid_path', '路径必须是不含 .. 的相对工作区路径。') };
    }

    const candidate = resolve(this.root, input);
    if (!isWithin(this.root, candidate)) {
      return { ok: false, error: error(kind, 'invalid_path', '路径位于工作区外。') };
    }
    return { ok: true, path: candidate, displayPath: input };
  }

  private async runWorker(cwd: string, operation: Omit<WorkspaceWorkerInput, 'workspaceRoot' | 'workspaceDevice' | 'workspaceInode'>): Promise<WorkspaceWorkerResponse> {
    await this.options.beforeWorkerStartForTesting?.();
    const input: WorkspaceWorkerInput = {
      ...operation,
      workspaceRoot: this.root,
      workspaceDevice: this.workspaceIdentity.device,
      workspaceInode: this.workspaceIdentity.inode
    };

    return new Promise((resolveWorker) => {
      let output = '';
      let child;
      try {
        child = spawn(process.execPath, ['-e', workspaceWorkerSource, JSON.stringify(input)], {
          cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch {
        resolveWorker({ ok: false, errorCode: 'io_error' });
        return;
      }

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
      });
      child.once('error', () => {
        resolveWorker({ ok: false, errorCode: 'io_error' });
      });
      child.once('close', () => {
        try {
          const parsed: unknown = JSON.parse(output);
          if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed)) {
            resolveWorker({ ok: false, errorCode: 'io_error' });
            return;
          }
          if (parsed.ok === false && 'errorCode' in parsed && isWorkerErrorCode(parsed.errorCode)) {
            resolveWorker({ ok: false, errorCode: parsed.errorCode });
            return;
          }
          if (parsed.ok === true) {
            resolveWorker(parsed as WorkspaceWorkerResponse);
            return;
          }
        } catch {
          // The worker never returns raw errors to the caller.
        }
        resolveWorker({ ok: false, errorCode: 'io_error' });
      });
    });
  }

  private workerError(kind: WorkspaceToolKind, errorCode: WorkspaceToolErrorCode): WorkspaceToolError {
    const messages: Record<WorkspaceToolErrorCode, string> = {
      invalid_path: '路径必须是不含 .. 的相对工作区路径。',
      symlink_escape: '符号链接目标位于工作区外。',
      workspace_changed: '工作区在执行前发生变化，已安全拒绝操作。',
      path_not_found: '目标路径不存在。',
      not_a_directory: '目标不是可列出的目录。',
      not_a_file: '目标不是可读取或写入的常规文件。',
      binary_file: '拒绝读取二进制文件。',
      file_too_large: '文件超过 256 KiB 上限。',
      io_error: '工作区文件操作失败。'
    };
    return error(kind, errorCode, messages[errorCode]);
  }

  private filesystemError(kind: WorkspaceToolKind, caught: unknown): WorkspaceToolError {
    if (isMissing(caught)) {
      return error(kind, 'path_not_found', '目标路径不存在。');
    }
    return error(kind, 'io_error', '工作区文件操作失败。');
  }
}
