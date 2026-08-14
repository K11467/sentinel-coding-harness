import type { SessionState } from '../domain/session.js';
import type { ApprovalRecord } from '../security/approval.js';

export interface SessionStore {
  save(session: SessionState): Promise<void>;
}

/** A versioned snapshot used to make approval-state changes compare-and-set. */
export interface StoredSession {
  session: SessionState;
  version: number;
}

/**
 * Session persistence needed by state machines that must not overwrite a
 * concurrently changed pending action.
 */
export interface AtomicSessionStore extends SessionStore {
  read(id: string): Promise<StoredSession | undefined>;
  compareAndSet(id: string, expectedVersion: number, next: SessionState): Promise<boolean>;
}

/** Durable approval-record access for CLI commands that reconstruct a service. */
export interface ApprovalRecordStore {
  saveApproval(record: ApprovalRecord): Promise<void>;
  getApproval(sessionId: string, actionHash: string): Promise<ApprovalRecord | undefined>;
}

/** A single durable update that binds a session transition to its approval record. */
export interface ApprovalTransaction {
  sessionId: string;
  expectedVersion: number;
  expectedApproval: ApprovalRecord | undefined;
  nextSession: SessionState;
  nextApproval: ApprovalRecord;
}

export interface ApprovalStateStore extends AtomicSessionStore, ApprovalRecordStore {
  transaction(change: ApprovalTransaction): Promise<boolean>;
}

export class ApprovalStorageError extends Error {
  constructor(
    readonly kind: 'invalid_state' | 'io_failure',
    message = '审批状态存储不可用。'
  ) {
    super(message);
    this.name = 'ApprovalStorageError';
  }
}

/** A deterministic store for the loop and its offline tests. */
export class InMemorySessionStore implements ApprovalStateStore {
  private readonly history: SessionState[] = [];
  private readonly current = new Map<string, StoredSession>();
  private readonly approvals = new Map<string, ApprovalRecord>();

  /** History is exposed only as cloned snapshots, never as mutable storage. */
  get saved(): SessionState[] {
    return structuredClone(this.history);
  }

  async save(session: SessionState): Promise<void> {
    const previous = this.current.get(session.id);
    this.write(session, (previous?.version ?? -1) + 1);
  }

  get(id: string): SessionState | undefined {
    const stored = this.current.get(id);
    return stored === undefined ? undefined : structuredClone(stored.session);
  }

  async read(id: string): Promise<StoredSession | undefined> {
    const stored = this.current.get(id);
    return stored === undefined ? undefined : structuredClone(stored);
  }

  async compareAndSet(id: string, expectedVersion: number, next: SessionState): Promise<boolean> {
    const current = this.current.get(id);
    if (current === undefined || current.version !== expectedVersion || next.id !== id) {
      return false;
    }
    this.write(next, expectedVersion + 1);
    return true;
  }

  async saveApproval(record: ApprovalRecord): Promise<void> {
    this.approvals.set(approvalKey(record.sessionId, record.actionHash), structuredClone(record));
  }

  async getApproval(sessionId: string, actionHash: string): Promise<ApprovalRecord | undefined> {
    const record = this.approvals.get(approvalKey(sessionId, actionHash));
    return record === undefined ? undefined : structuredClone(record);
  }

  async transaction(change: ApprovalTransaction): Promise<boolean> {
    const current = this.current.get(change.sessionId);
    if (current === undefined || current.version !== change.expectedVersion || change.nextSession.id !== change.sessionId) {
      return false;
    }
    const key = approvalKey(change.sessionId, change.nextApproval.actionHash);
    const approval = this.approvals.get(key);
    if (!approvalEquals(approval, change.expectedApproval)) {
      return false;
    }
    this.write(change.nextSession, change.expectedVersion + 1);
    this.approvals.set(key, structuredClone(change.nextApproval));
    return true;
  }

  private write(session: SessionState, version: number): void {
    const snapshot = structuredClone(session);
    this.current.set(snapshot.id, { session: snapshot, version });
    this.history.push(structuredClone(snapshot));
  }
}

function approvalKey(sessionId: string, actionHash: string): string {
  return `${sessionId}\u0000${actionHash}`;
}

export function approvalRecordKey(sessionId: string, actionHash: string): string {
  return approvalKey(sessionId, actionHash);
}

export function approvalEquals(actual: ApprovalRecord | undefined, expected: ApprovalRecord | undefined): boolean {
  if (actual === undefined || expected === undefined) {
    return actual === expected;
  }
  return actual.sessionId === expected.sessionId
    && actual.actionHash === expected.actionHash
    && actual.createdAt === expected.createdAt
    && actual.expiresAt === expected.expiresAt
    && actual.status === expected.status
    && actual.approvedAt === expected.approvedAt
    && actual.rejectedAt === expected.rejectedAt
    && actual.consumedAt === expected.consumedAt;
}
