import { z } from 'zod';
import { ActionParser, type Action } from '../domain/actions.js';
import { sessionStateSchema, type SessionState } from '../domain/session.js';
import { ApprovalStorageError, type ApprovalStateStore, type StoredSession } from '../core/session-store.js';
import { hashAction, type PolicyDecision } from './policy.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';

const nonEmptyStringSchema = z.string().min(1);
const actionHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

/** A one-time authorization bound to exactly one persisted pending action. */
export const approvalRecordSchema = z.object({
  sessionId: nonEmptyStringSchema,
  actionHash: actionHashSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'consumed', 'expired']),
  approvedAt: timestampSchema.optional(),
  rejectedAt: timestampSchema.optional(),
  consumedAt: timestampSchema.optional()
}).strict().superRefine((record, context) => {
  const createdAt = Date.parse(record.createdAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: '审批过期时间必须晚于创建时间。'
    });
  }
  if (record.status === 'approved' && record.approvedAt === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['approvedAt'], message: '已批准记录必须包含批准时间。' });
  }
  if (record.status === 'rejected' && record.rejectedAt === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['rejectedAt'], message: '已拒绝记录必须包含拒绝时间。' });
  }
  if (record.status === 'consumed' && (record.approvedAt === undefined || record.consumedAt === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['consumedAt'], message: '已消费记录必须包含批准和消费时间。' });
  }
});

export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export type ApprovalErrorCode =
  | 'approval_not_required'
  | 'action_invalid'
  | 'action_hash_mismatch'
  | 'session_not_found'
  | 'session_not_runnable'
  | 'approval_not_found'
  | 'approval_expired'
  | 'approval_rejected'
  | 'approval_consumed'
  | 'not_approved'
  | 'pending_mismatch'
  | 'policy_recheck_failed'
  | 'concurrent_update'
  | 'storage_invalid'
  | 'storage_failure';

export type ApprovalResult<T> =
  | { ok: true; record: ApprovalRecord; session?: SessionState; action?: Action }
  | { ok: false; error: { code: ApprovalErrorCode; message: string } };

export interface ApprovalPolicy {
  decide(action: Action): PolicyDecision;
}

export interface ApprovalServiceOptions {
  clock?: () => Date;
  /** Pending requests expire after this duration; defaults to five minutes. */
  ttlMs?: number;
}

const defaultTtlMs = 5 * 60 * 1_000;

/**
 * Deterministic HITL state machine. It grants an action to a future caller but
 * deliberately never dispatches that action itself.
 */
export class ApprovalService {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    private readonly sessions: ApprovalStateStore,
    private readonly policy: ApprovalPolicy,
    options: ApprovalServiceOptions = {}
  ) {
    this.now = options.clock ?? (() => new Date());
    this.ttlMs = Math.max(1, options.ttlMs ?? defaultTtlMs);
  }

  /** Persist a verified action as the only pending action for a running session. */
  async request(sessionId: string, action: Action, decision: PolicyDecision): Promise<ApprovalResult<ApprovalRecord>> {
    return this.attempt(async () => {
      if (!isVerifiedAction(action)) {
        return failure('action_invalid', '审批请求中的 action 未通过验证。');
      }
      const actionHash = hashAction(action);
      const currentDecision = this.policy.decide(action);
      if (decision.effect !== 'require_approval' || currentDecision.effect !== 'require_approval') {
        return failure('approval_not_required', '当前策略不要求审批，不能创建待审批动作。');
      }
      if (decision.actionHash !== actionHash || currentDecision.actionHash !== actionHash) {
        return failure('action_hash_mismatch', '策略 action hash 与待审批动作不匹配。');
      }

      const stored = await this.sessions.read(sessionId);
      if (stored === undefined) {
        return failure('session_not_found', '找不到需要审批的会话。');
      }
      if (stored.session.status !== 'running' || stored.session.pendingAction !== undefined) {
        return failure('session_not_runnable', '只有没有待办动作的 running 会话可以进入审批。');
      }

      const createdAt = this.now();
      const record = approvalRecordSchema.parse({
        sessionId,
        actionHash,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
        status: 'pending'
      });
      const next = sessionStateSchema.parse({
        ...stored.session,
        status: 'waiting_approval',
        pendingAction: { action: structuredClone(action), actionHash }
      });
      if (!await this.sessions.transaction({
        sessionId,
        expectedVersion: stored.version,
        expectedApproval: undefined,
        nextSession: next,
        nextApproval: record
      })) {
        return failure('concurrent_update', '会话或审批记录已被其他操作更新，审批请求未写入。');
      }
      return success(record, next);
    });
  }

  /** Return a strict, cloned record. Invalid persisted data is intentionally hidden. */
  async inspect(sessionId: string, actionHash: string): Promise<ApprovalRecord | undefined> {
    try {
      const record = await this.record(sessionId, actionHash);
      return record === undefined ? undefined : structuredClone(record);
    } catch {
      return undefined;
    }
  }

  /** Mark a matching request approved. The action is still not executable until claim/resume succeeds. */
  async approve(sessionId: string, actionHash: string): Promise<ApprovalResult<ApprovalRecord>> {
    return this.attempt(async () => {
      const record = await this.record(sessionId, actionHash);
      if (record === undefined) {
        return failure('approval_not_found', '找不到匹配会话和 action hash 的审批请求。');
      }
      if (record.status === 'consumed') {
        return failure('approval_consumed', '该审批已经被消费，不能重放。');
      }
      if (record.status === 'rejected') {
        return failure('approval_rejected', '该审批已被拒绝。');
      }
      const stored = await this.sessions.read(sessionId);
      if (stored === undefined) {
        return failure('session_not_found', '找不到需要审批的会话。');
      }
      if (this.isExpired(record)) {
        return this.expire(stored, record);
      }
      if (record.status === 'approved') {
        return success(record);
      }
      if (!pendingMatches(stored, actionHash)) {
        return failure('pending_mismatch', '会话待审批动作与审批记录不匹配。');
      }
      const approved = approvalRecordSchema.parse({
        ...record,
        status: 'approved',
        approvedAt: this.now().toISOString()
      });
      if (!await this.sessions.transaction({
        sessionId,
        expectedVersion: stored.version,
        expectedApproval: record,
        nextSession: stored.session,
        nextApproval: approved
      })) {
        return failure('concurrent_update', '会话或审批记录已被其他操作更新，批准未写入。');
      }
      return success(approved);
    });
  }

  /** Reject the exact pending action and transition the session into a legal terminal state. */
  async reject(sessionId: string, actionHash: string): Promise<ApprovalResult<ApprovalRecord>> {
    return this.attempt(async () => {
      const record = await this.record(sessionId, actionHash);
      if (record === undefined) {
        return failure('approval_not_found', '找不到匹配会话和 action hash 的审批请求。');
      }
      if (record.status === 'consumed') {
        return failure('approval_consumed', '已执行的审批不能再拒绝。');
      }
      if (record.status === 'rejected') {
        return failure('approval_rejected', '该审批已经被拒绝。');
      }
      const stored = await this.sessions.read(sessionId);
      if (stored === undefined) {
        return failure('session_not_found', '找不到需要审批的会话。');
      }
      if (!pendingMatches(stored, actionHash)) {
        return failure('pending_mismatch', '会话待审批动作与审批记录不匹配。');
      }
      const { pendingAction: _pendingAction, stopReason: _stopReason, ...active } = stored.session;
      const next = sessionStateSchema.parse({ ...active, status: 'stopped', stopReason: 'approval_denied' });
      const rejected = approvalRecordSchema.parse({
        ...record,
        status: 'rejected',
        rejectedAt: this.now().toISOString()
      });
      if (!await this.sessions.transaction({
        sessionId,
        expectedVersion: stored.version,
        expectedApproval: record,
        nextSession: next,
        nextApproval: rejected
      })) {
        return failure('concurrent_update', '会话或审批记录已被其他操作更新，拒绝未写入。');
      }
      return success(rejected, next);
    });
  }

  /**
   * Atomically consume an approved request, clear pendingAction, and return the
   * only action a future CLI is permitted to dispatch. This method never runs it.
   */
  async claim(sessionId: string, actionHash: string): Promise<ApprovalResult<ApprovalRecord>> {
    return this.attempt(async () => {
      const record = await this.record(sessionId, actionHash);
      if (record === undefined) {
        return failure('approval_not_found', '找不到匹配会话和 action hash 的审批请求。');
      }
      if (record.status === 'consumed') {
        return failure('approval_consumed', '该审批已经被消费，不能重放。');
      }
      if (record.status === 'rejected') {
        return failure('approval_rejected', '该审批已被拒绝。');
      }
      const stored = await this.sessions.read(sessionId);
      if (stored === undefined) {
        return failure('session_not_found', '找不到需要恢复的会话。');
      }
      if (this.isExpired(record)) {
        return this.expire(stored, record);
      }
      if (record.status !== 'approved') {
        return failure('not_approved', '动作尚未获得人工批准，不能恢复。');
      }
      if (!pendingMatches(stored, actionHash)) {
        return failure('pending_mismatch', '会话待审批动作与审批记录不匹配。');
      }
      const action = stored.session.pendingAction!.action;
      if (!isVerifiedAction(action)) {
        return failure('pending_mismatch', '持久化的待审批动作未通过验证。');
      }
      const rechecked = this.policy.decide(action);
      if (rechecked.effect === 'deny' || rechecked.actionHash !== actionHash) {
        return failure('policy_recheck_failed', '恢复前策略复核失败，动作不会执行。');
      }

      const { pendingAction: _pendingAction, stopReason: _stopReason, ...active } = stored.session;
      const next = sessionStateSchema.parse({ ...active, status: 'running' });
      const consumed = approvalRecordSchema.parse({
        ...record,
        status: 'consumed',
        consumedAt: this.now().toISOString()
      });
      if (!await this.sessions.transaction({
        sessionId,
        expectedVersion: stored.version,
        expectedApproval: record,
        nextSession: next,
        nextApproval: consumed
      })) {
        return failure('concurrent_update', '会话或审批记录已被其他操作更新，审批未消费。');
      }
      return success(consumed, next, action);
    });
  }

  /** Alias for CLI-facing resume terminology. */
  resume(sessionId: string, actionHash: string): Promise<ApprovalResult<ApprovalRecord>> {
    return this.claim(sessionId, actionHash);
  }

  private async record(sessionId: string, actionHash: string): Promise<ApprovalRecord | undefined> {
    const record = await this.sessions.getApproval(sessionId, actionHash);
    return record === undefined ? undefined : approvalRecordSchema.parse(record);
  }

  private isExpired(record: ApprovalRecord): boolean {
    return this.now().getTime() >= Date.parse(record.expiresAt);
  }

  private async expire(stored: StoredSession, record: ApprovalRecord): Promise<ApprovalResult<ApprovalRecord>> {
    const expired = approvalRecordSchema.parse({ ...record, status: 'expired' });
    if (!await this.sessions.transaction({
      sessionId: record.sessionId,
      expectedVersion: stored.version,
      expectedApproval: record,
      nextSession: stored.session,
      nextApproval: expired
    })) {
      return failure('concurrent_update', '会话或审批记录已被其他操作更新，过期状态未写入。');
    }
    return failure('approval_expired', '该审批已经过期。');
  }

  private async attempt(operation: () => Promise<ApprovalResult<ApprovalRecord>>): Promise<ApprovalResult<ApprovalRecord>> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApprovalStorageError && error.kind === 'invalid_state') {
        return failure('storage_invalid', '持久化审批状态无效，已拒绝恢复。');
      }
      return failure('storage_failure', '审批状态无法原子写入，动作不会执行。');
    }
  }
}

function success(record: ApprovalRecord, session?: SessionState, action?: Action): ApprovalResult<ApprovalRecord> {
  return {
    ok: true,
    record: structuredClone(record),
    ...(session === undefined ? {} : { session: structuredClone(session) }),
    ...(action === undefined ? {} : { action: structuredClone(action) })
  };
}

function failure(code: ApprovalErrorCode, message: string): ApprovalResult<never> {
  return { ok: false, error: { code, message } };
}

function pendingMatches(stored: StoredSession, actionHash: string): boolean {
  const parsed = sessionStateSchema.safeParse(stored.session);
  if (!parsed.success || parsed.data.status !== 'waiting_approval' || parsed.data.pendingAction === undefined) {
    return false;
  }
  const pending = parsed.data.pendingAction;
  return pending.actionHash === actionHash && hashAction(pending.action) === actionHash;
}

function isVerifiedAction(action: Action): boolean {
  const { id, ...envelope } = action;
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }
  const parsed = new ActionParser(() => id).parse(envelope);
  return parsed.ok && hashAction(parsed.action) === hashAction(action);
}
