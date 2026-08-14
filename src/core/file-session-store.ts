import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { sessionStateSchema, type SessionState } from '../domain/session.js';
import { approvalRecordSchema, type ApprovalRecord } from '../security/approval.js';
import {
  ApprovalStorageError,
  approvalEquals,
  approvalRecordKey,
  type ApprovalStateStore,
  type ApprovalTransaction,
  type StoredSession
} from './session-store.js';

const persistedSessionSchema = z.object({
  version: z.number().int().min(0),
  session: sessionStateSchema
}).strict();

const persistedStateSchema = z.object({
  format: z.literal(1),
  sessions: z.record(persistedSessionSchema),
  approvals: z.record(approvalRecordSchema)
}).strict().superRefine((state, context) => {
  for (const [sessionId, stored] of Object.entries(state.sessions)) {
    if (stored.session.id !== sessionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sessions', sessionId], message: '会话 key 必须与 session.id 一致。' });
    }
  }
  for (const [key, record] of Object.entries(state.approvals)) {
    if (key !== approvalRecordKey(record.sessionId, record.actionHash)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['approvals', key], message: '审批记录 key 必须绑定 sessionId 和 actionHash。' });
    }
  }
});

type PersistedState = z.infer<typeof persistedStateSchema>;

export interface FileSessionStoreOperations {
  readText(path: string): Promise<string>;
  ensureDirectory(path: string): Promise<void>;
  createLock(path: string): Promise<void>;
  writeNewText(path: string, contents: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface FileSessionStoreOptions {
  operations?: Partial<FileSessionStoreOperations>;
}

const defaultOperations: FileSessionStoreOperations = {
  readText: async (path) => readFile(path, 'utf8'),
  ensureDirectory: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
  createLock: async (path) => writeFile(path, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  writeNewText: async (path, contents) => writeFile(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  chmod: async (path, mode) => chmod(path, mode),
  rename: async (from, to) => rename(from, to),
  remove: async (path) => unlink(path)
};

/**
 * Local JSON persistence for sessions and approval records. Every approval
 * transaction serializes one aggregate file to a 0600 sibling temp file and
 * atomically replaces the prior file with rename.
 */
export class FileSessionStore implements ApprovalStateStore {
  private readonly operations: FileSessionStoreOperations;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: FileSessionStoreOptions = {}
  ) {
    this.operations = { ...defaultOperations, ...options.operations };
  }

  async save(session: SessionState): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      const previous = state.sessions[session.id];
      state.sessions[session.id] = {
        version: (previous?.version ?? -1) + 1,
        session: structuredClone(session)
      };
      await this.persist(state);
    });
  }

  async read(id: string): Promise<StoredSession | undefined> {
    return this.exclusive(async () => {
      const stored = (await this.load()).sessions[id];
      return stored === undefined ? undefined : structuredClone(stored);
    });
  }

  async compareAndSet(id: string, expectedVersion: number, next: SessionState): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.load();
      const current = state.sessions[id];
      if (current === undefined || current.version !== expectedVersion || next.id !== id) {
        return false;
      }
      state.sessions[id] = { version: expectedVersion + 1, session: structuredClone(next) };
      await this.persist(state);
      return true;
    });
  }

  async saveApproval(record: ApprovalRecord): Promise<void> {
    const parsed = approvalRecordSchema.parse(record);
    await this.exclusive(async () => {
      const state = await this.load();
      state.approvals[approvalRecordKey(parsed.sessionId, parsed.actionHash)] = structuredClone(parsed);
      await this.persist(state);
    });
  }

  async getApproval(sessionId: string, actionHash: string): Promise<ApprovalRecord | undefined> {
    return this.exclusive(async () => {
      const record = (await this.load()).approvals[approvalRecordKey(sessionId, actionHash)];
      return record === undefined ? undefined : structuredClone(record);
    });
  }

  async transaction(change: ApprovalTransaction): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.load();
      const current = state.sessions[change.sessionId];
      if (current === undefined || current.version !== change.expectedVersion || change.nextSession.id !== change.sessionId) {
        return false;
      }
      const key = approvalRecordKey(change.sessionId, change.nextApproval.actionHash);
      if (!approvalEquals(state.approvals[key], change.expectedApproval)) {
        return false;
      }
      const session = sessionStateSchema.parse(change.nextSession);
      const approval = approvalRecordSchema.parse(change.nextApproval);
      state.sessions[change.sessionId] = { version: change.expectedVersion + 1, session: structuredClone(session) };
      state.approvals[key] = structuredClone(approval);
      await this.persist(state);
      return true;
    });
  }

  private async load(): Promise<PersistedState> {
    let raw: string;
    try {
      raw = await this.operations.readText(this.filePath);
    } catch (error) {
      if (isNotFound(error)) {
        return { format: 1, sessions: {}, approvals: {} };
      }
      throw new ApprovalStorageError('io_failure', '无法读取审批状态文件。');
    }
    try {
      return persistedStateSchema.parse(JSON.parse(raw));
    } catch {
      throw new ApprovalStorageError('invalid_state', '审批状态文件不符合严格结构。');
    }
  }

  private async persist(state: PersistedState): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(persistedStateSchema.parse(state));
    } catch {
      throw new ApprovalStorageError('invalid_state', '待写入的审批状态不符合严格结构。');
    }
    const directory = dirname(this.filePath);
    const temporaryPath = join(directory, `.${randomUUID()}.approval-state.tmp`);
    let replaced = false;
    try {
      await this.operations.ensureDirectory(directory);
      await this.operations.writeNewText(temporaryPath, serialized);
      await this.operations.chmod(temporaryPath, 0o600);
      await this.operations.rename(temporaryPath, this.filePath);
      replaced = true;
    } catch {
      throw new ApprovalStorageError('io_failure', '无法原子写入审批状态文件。');
    } finally {
      if (!replaced) {
        await this.operations.remove(temporaryPath).catch(() => undefined);
      }
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.withFileLock(operation);
    } finally {
      release!();
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const directory = dirname(this.filePath);
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 1_000;
    await this.operations.ensureDirectory(directory);
    while (true) {
      try {
        await this.operations.createLock(lockPath);
        break;
      } catch (error) {
        if (!isAlreadyExists(error) || Date.now() >= deadline) {
          throw new ApprovalStorageError('io_failure', '无法获取审批状态文件锁。');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      return await operation();
    } finally {
      try {
        await this.operations.remove(lockPath);
      } catch {
        throw new ApprovalStorageError('io_failure', '无法释放审批状态文件锁。');
      }
    }
  }
}

function isNotFound(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST';
}
