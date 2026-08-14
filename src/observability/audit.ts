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
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

type PlainRecord = Record<string, unknown>;

function invalidEvent(): never {
  throw new Error('Invalid audit event.');
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

/**
 * Copies only enumerable own data properties from a plain JSON-like record.
 * Accessors, prototype-bearing instances, symbols, and dangerous keys are not input data.
 */
function plainRecord(value: unknown): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidEvent();
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidEvent();
  }

  const result: PlainRecord = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) {
      return invalidEvent();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return invalidEvent();
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function exactFields(record: PlainRecord, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    invalidEvent();
  }
}

function requiredString(record: PlainRecord, key: string): string {
  const value = record[key];
  if (!nonEmptyString(value)) {
    return invalidEvent();
  }
  return value;
}

function optionalString(record: PlainRecord, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== 'string') {
    return invalidEvent();
  }
  return value;
}

function optionalRecord(record: PlainRecord, key: string): PlainRecord | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  return plainRecord(record[key]);
}

function optionalSafeInteger(record: PlainRecord, key: string): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return invalidEvent();
  }
  return value;
}

function summarizeAction(value: PlainRecord): AuditActionSummary {
  exactFields(value, ['type', 'reason', 'path', 'command', 'content', 'contentBytes']);
  const type = requiredString(value, 'type');
  if (!isOneOf(type, ACTION_TYPES)) {
    return invalidEvent();
  }
  const reason = optionalString(value, 'reason');
  const path = optionalString(value, 'path');
  const command = optionalString(value, 'command');
  const content = optionalString(value, 'content');
  const contentBytes = optionalSafeInteger(value, 'contentBytes');
  if (contentBytes !== undefined && contentBytes < 0) {
    return invalidEvent();
  }

  return {
    type: redactText(type, 128),
    ...(reason !== undefined ? { reason: redactText(reason, 512) } : {}),
    ...(path !== undefined ? { path: redactText(path, 512) } : {}),
    ...(command !== undefined ? { command: redactText(command, 128) } : {}),
    ...(content !== undefined ? { contentBytes: Buffer.byteLength(content, 'utf8') } : {}),
    ...(content === undefined && contentBytes !== undefined ? { contentBytes } : {}),
  };
}

function sanitizePolicy(value: PlainRecord): AuditPolicyInput {
  exactFields(value, ['effect', 'ruleId', 'risk', 'reason']);
  const effect = requiredString(value, 'effect');
  const ruleId = requiredString(value, 'ruleId');
  const risk = requiredString(value, 'risk');
  const reason = optionalString(value, 'reason');
  if (!isOneOf(effect, POLICY_EFFECTS) || !isOneOf(risk, RISK_LEVELS)) {
    return invalidEvent();
  }
  return {
    effect,
    ruleId: redactText(ruleId, 128),
    risk,
    ...(reason !== undefined ? { reason: redactText(reason, 512) } : {}),
  };
}

function sanitizeTool(value: PlainRecord): AuditToolInput {
  exactFields(value, ['kind', 'ok', 'exitCode', 'errorCode', 'output']);
  const kind = requiredString(value, 'kind');
  const ok = value.ok;
  const exitCode = optionalSafeInteger(value, 'exitCode');
  const errorCode = optionalString(value, 'errorCode');
  const output = optionalString(value, 'output');
  if (!isOneOf(kind, ACTION_TYPES) || typeof ok !== 'boolean') {
    return invalidEvent();
  }
  return {
    kind: redactText(kind, 128),
    ok,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(errorCode !== undefined ? { errorCode: redactText(errorCode, 128) } : {}),
    ...(output !== undefined ? { output: redactText(output, 1024) } : {}),
  };
}

function sanitizeState(value: PlainRecord): AuditStateInput {
  exactFields(value, ['from', 'to', 'reason']);
  const from = requiredString(value, 'from');
  const to = requiredString(value, 'to');
  const reason = optionalString(value, 'reason');
  if (!isOneOf(from, SESSION_STATUSES) || !isOneOf(to, SESSION_STATUSES)) {
    return invalidEvent();
  }
  return {
    from: redactText(from, 128),
    to: redactText(to, 128),
    ...(reason !== undefined ? { reason: redactText(reason, 512) } : {}),
  };
}

function normalizeEventUnsafe(input: unknown): AuditRecord {
  const event = plainRecord(input);
  exactFields(event, ['sessionId', 'event', 'timestamp', 'action', 'policy', 'tool', 'state']);
  const sessionId = requiredString(event, 'sessionId');
  const eventType = requiredString(event, 'event');
  const timestamp = optionalString(event, 'timestamp');
  const action = optionalRecord(event, 'action');
  const policy = optionalRecord(event, 'policy');
  const tool = optionalRecord(event, 'tool');
  const state = optionalRecord(event, 'state');
  if (!isOneOf(eventType, EVENT_TYPES)) {
    return invalidEvent();
  }
  if (
    timestamp !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp)))
  ) {
    return invalidEvent();
  }

  return {
    timestamp: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
    sessionId: redactText(sessionId, 128),
    event: eventType,
    ...(action ? { action: summarizeAction(action) } : {}),
    ...(policy ? { policy: sanitizePolicy(policy) } : {}),
    ...(tool ? { tool: sanitizeTool(tool) } : {}),
    ...(state ? { state: sanitizeState(state) } : {}),
  };
}

function normalizeEvent(input: unknown): AuditRecord {
  try {
    return normalizeEventUnsafe(input);
  } catch {
    return invalidEvent();
  }
}

/** Append-only JSONL audit storage. It deliberately exposes no arbitrary payload field. */
export class AuditLog {
  public constructor(private readonly filePath: string) {}

  /** Runtime input is unknown until it has passed plain-record validation. */
  public async append(event: unknown): Promise<AuditRecord> {
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
        .map((line) => normalizeEvent(JSON.parse(line)));
    } catch {
      throw new Error('Unable to read audit log.');
    }
  }
}
