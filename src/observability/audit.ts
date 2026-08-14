import { appendFile, readFile } from 'node:fs/promises';
import { redactText } from './redact.js';

const EVENT_TYPES = ['state_transition', 'policy_decision', 'tool_result'] as const;
const ACTION_TYPES = ['list_files', 'read_file', 'write_file', 'run_command', 'run_tests', 'remember', 'finish'] as const;
const SESSION_STATUSES = [
  'created',
  'running',
  'waiting_approval',
  'completed',
  'stopped',
  'blocked',
  'failed',
  'budget_exhausted',
  'cancelled',
] as const;
const POLICY_EFFECTS = ['allow', 'require_approval', 'deny'] as const;
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

export type AuditEventType = (typeof EVENT_TYPES)[number];

export interface AuditActionInput {
  type: string;
  reason?: string;
  path?: string;
  command?: string;
  content?: string;
  contentBytes?: number;
}

export interface AuditPolicyInput {
  effect: (typeof POLICY_EFFECTS)[number];
  ruleId: string;
  risk: (typeof RISK_LEVELS)[number];
  reason?: string;
}

export interface AuditToolInput {
  kind: string;
  ok: boolean;
  exitCode?: number;
  errorCode?: string;
  output?: string;
}

export interface AuditStateInput {
  from: string;
  to: string;
  reason?: string;
}

/** Only these fixed fields are accepted for a single JSONL audit event. */
export interface AuditEventInput {
  sessionId: string;
  event: AuditEventType;
  timestamp?: string;
  action?: AuditActionInput;
  policy?: AuditPolicyInput;
  tool?: AuditToolInput;
  state?: AuditStateInput;
}

export interface AuditActionSummary {
  type: string;
  reason?: string;
  path?: string;
  command?: string;
  contentBytes?: number;
}

export interface AuditRecord {
  timestamp: string;
  sessionId: string;
  event: AuditEventType;
  action?: AuditActionSummary;
  policy?: AuditPolicyInput;
  tool?: AuditToolInput;
  state?: AuditStateInput;
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

function summarizeAction(action: AuditActionInput): AuditActionSummary {
  if (!isOneOf(action.type, ACTION_TYPES)) {
    throw new Error('Invalid audit event.');
  }

  const summary: AuditActionSummary = { type: redactText(action.type, 128) };
  if (typeof action.reason === 'string') summary.reason = redactText(action.reason, 512);
  if (typeof action.path === 'string') summary.path = redactText(action.path, 512);
  if (typeof action.command === 'string') summary.command = redactText(action.command, 128);
  if (typeof action.content === 'string') {
    summary.contentBytes = Buffer.byteLength(action.content, 'utf8');
  } else if (typeof action.contentBytes === 'number' && Number.isSafeInteger(action.contentBytes) && action.contentBytes >= 0) {
    summary.contentBytes = action.contentBytes;
  }
  return summary;
}

function sanitizePolicy(policy: AuditPolicyInput): AuditPolicyInput {
  if (!isOneOf(policy.effect, POLICY_EFFECTS) || !isOneOf(policy.risk, RISK_LEVELS) || !nonEmptyString(policy.ruleId)) {
    throw new Error('Invalid audit event.');
  }
  return {
    effect: policy.effect,
    ruleId: redactText(policy.ruleId, 128),
    risk: policy.risk,
    ...(typeof policy.reason === 'string' ? { reason: redactText(policy.reason, 512) } : {}),
  };
}

function sanitizeTool(tool: AuditToolInput): AuditToolInput {
  if (!isOneOf(tool.kind, ACTION_TYPES) || typeof tool.ok !== 'boolean') {
    throw new Error('Invalid audit event.');
  }
  return {
    kind: redactText(tool.kind, 128),
    ok: tool.ok,
    ...(typeof tool.exitCode === 'number' ? { exitCode: tool.exitCode } : {}),
    ...(typeof tool.errorCode === 'string' ? { errorCode: redactText(tool.errorCode, 128) } : {}),
    ...(typeof tool.output === 'string' ? { output: redactText(tool.output, 1024) } : {}),
  };
}

function sanitizeState(state: AuditStateInput): AuditStateInput {
  if (!isOneOf(state.from, SESSION_STATUSES) || !isOneOf(state.to, SESSION_STATUSES)) {
    throw new Error('Invalid audit event.');
  }
  return {
    from: redactText(state.from, 128),
    to: redactText(state.to, 128),
    ...(typeof state.reason === 'string' ? { reason: redactText(state.reason, 512) } : {}),
  };
}

function normalizeEvent(event: AuditEventInput): AuditRecord {
  if (!nonEmptyString(event.sessionId) || !isOneOf(event.event, EVENT_TYPES)) {
    throw new Error('Invalid audit event.');
  }
  if (
    event.timestamp !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(event.timestamp) || Number.isNaN(Date.parse(event.timestamp)))
  ) {
    throw new Error('Invalid audit event.');
  }

  return {
    timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
    sessionId: redactText(event.sessionId, 128),
    event: event.event,
    ...(event.action ? { action: summarizeAction(event.action) } : {}),
    ...(event.policy ? { policy: sanitizePolicy(event.policy) } : {}),
    ...(event.tool ? { tool: sanitizeTool(event.tool) } : {}),
    ...(event.state ? { state: sanitizeState(event.state) } : {}),
  };
}

/** Append-only JSONL audit storage. It deliberately exposes no arbitrary payload field. */
export class AuditLog {
  public constructor(private readonly filePath: string) {}

  public async append(event: AuditEventInput): Promise<AuditRecord> {
    const record = normalizeEvent(event);
    try {
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
    } catch {
      throw new Error('Unable to write audit log.');
    }
    return record;
  }

  public async read(): Promise<AuditRecord[]> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      return contents
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => normalizeEvent(JSON.parse(line) as AuditEventInput));
    } catch {
      throw new Error('Unable to read audit log.');
    }
  }
}
