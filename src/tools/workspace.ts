import { constants, realpathSync } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

/** The largest text file the harness may expose to an action. */
export const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;

export type WorkspaceToolKind = 'list' | 'read' | 'write';

export type WorkspaceToolErrorCode =
  | 'invalid_path'
  | 'symlink_escape'
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

type ExistingPathResult =
  | { ok: true; realPath: string; displayPath: string }
  | { ok: false; error: WorkspaceToolError };

type WritePathResult =
  | { ok: true; realPath: string; displayPath: string }
  | { ok: false; error: WorkspaceToolError };

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

/**
 * Controlled filesystem operations rooted at one already-authorized workspace.
 * Every existing target is canonicalized before it is observed or written.
 */
export class WorkspaceTools {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = realpathSync(resolve(workspaceRoot));
  }

  async list(path = '.'): Promise<ListWorkspaceResult> {
    const target = await this.resolveExisting('list', path);
    if (!target.ok) {
      return target.error;
    }

    try {
      const metadata = await stat(target.realPath);
      if (!metadata.isDirectory()) {
        return error('list', 'not_a_directory', '目标不是可列出的目录。');
      }
      const entries = await readdir(target.realPath);
      return { ok: true, kind: 'list', path: target.displayPath, entries: entries.sort() };
    } catch (caught) {
      return this.filesystemError('list', caught);
    }
  }

  async read(path: string): Promise<ReadWorkspaceResult> {
    const target = await this.resolveExisting('read', path);
    if (!target.ok) {
      return target.error;
    }

    try {
      const metadata = await stat(target.realPath);
      if (!metadata.isFile()) {
        return error('read', 'not_a_file', '目标不是可读取的常规文件。');
      }
      if (metadata.size > MAX_WORKSPACE_FILE_BYTES) {
        return error('read', 'file_too_large', '文件超过 256 KiB 读取上限。');
      }

      const content = await readFile(target.realPath);
      if (content.byteLength > MAX_WORKSPACE_FILE_BYTES) {
        return error('read', 'file_too_large', '文件超过 256 KiB 读取上限。');
      }
      if (content.includes(0)) {
        return error('read', 'binary_file', '拒绝读取包含 NUL 字节的二进制文件。');
      }
      try {
        return {
          ok: true,
          kind: 'read',
          path: target.displayPath,
          content: new TextDecoder('utf-8', { fatal: true }).decode(content)
        };
      } catch {
        return error('read', 'binary_file', '拒绝读取非 UTF-8 的二进制文件。');
      }
    } catch (caught) {
      return this.filesystemError('read', caught);
    }
  }

  async write(path: string, content: string): Promise<WriteWorkspaceResult> {
    if (typeof content !== 'string') {
      return error('write', 'io_error', '写入内容必须是字符串。');
    }
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) {
      return error('write', 'file_too_large', '写入内容超过 256 KiB 上限。');
    }

    const target = await this.resolveWritePath(path);
    if (!target.ok) {
      return target.error;
    }

    try {
      const handle = await open(
        target.realPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return { ok: true, kind: 'write', path: target.displayPath, bytesWritten: bytes.byteLength };
    } catch (caught) {
      return this.filesystemError('write', caught);
    }
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

      const canonicalTarget = resolve(canonicalParent, relative(dirname(candidate.path), candidate.path));
      try {
        const targetMetadata = await lstat(canonicalTarget);
        if (targetMetadata.isSymbolicLink()) {
          const resolvedTarget = await realpath(canonicalTarget);
          if (!isWithin(this.root, resolvedTarget)) {
            return { ok: false, error: error('write', 'symlink_escape', '写入目标的符号链接位于工作区外。') };
          }
          return { ok: true, realPath: resolvedTarget, displayPath: candidate.displayPath };
        }
      } catch (caught) {
        if (!isMissing(caught)) {
          return { ok: false, error: this.filesystemError('write', caught) };
        }
      }
      return { ok: true, realPath: canonicalTarget, displayPath: candidate.displayPath };
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

  private filesystemError(kind: WorkspaceToolKind, caught: unknown): WorkspaceToolError {
    if (isMissing(caught)) {
      return error(kind, 'path_not_found', '目标路径不存在。');
    }
    return error(kind, 'io_error', '工作区文件操作失败。');
  }
}
