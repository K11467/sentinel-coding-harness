import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const actionTypeSchema = z.enum([
  'list_files',
  'read_file',
  'write_file',
  'run_command',
  'run_tests',
  'remember',
  'finish'
]);

export type ActionType = z.infer<typeof actionTypeSchema>;

const reasonSchema = z.string().min(1).max(500);
const nonEmptyStringSchema = z.string().min(1);

const listFilesEnvelopeSchema = z.object({
  type: z.literal('list_files'),
  reason: reasonSchema,
  path: nonEmptyStringSchema.optional()
}).strict();

const readFileEnvelopeSchema = z.object({
  type: z.literal('read_file'),
  reason: reasonSchema,
  path: nonEmptyStringSchema
}).strict();

const writeFileEnvelopeSchema = z.object({
  type: z.literal('write_file'),
  reason: reasonSchema,
  path: nonEmptyStringSchema,
  content: z.string()
}).strict();

const runCommandEnvelopeSchema = z.object({
  type: z.literal('run_command'),
  reason: reasonSchema,
  command: nonEmptyStringSchema,
  args: z.array(nonEmptyStringSchema)
}).strict();

const runTestsEnvelopeSchema = z.object({
  type: z.literal('run_tests'),
  reason: reasonSchema
}).strict();

const rememberEnvelopeSchema = z.object({
  type: z.literal('remember'),
  reason: reasonSchema,
  note: z.string().min(1).max(300)
}).strict();

const finishEnvelopeSchema = z.object({
  type: z.literal('finish'),
  reason: reasonSchema,
  summary: z.string().min(1).max(1_000)
}).strict();

export const actionEnvelopeSchema = z.discriminatedUnion('type', [
  listFilesEnvelopeSchema,
  readFileEnvelopeSchema,
  writeFileEnvelopeSchema,
  runCommandEnvelopeSchema,
  runTestsEnvelopeSchema,
  rememberEnvelopeSchema,
  finishEnvelopeSchema
]);

export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>;

export type Action =
  | ({ id: string } & z.infer<typeof listFilesEnvelopeSchema>)
  | ({ id: string } & z.infer<typeof readFileEnvelopeSchema>)
  | ({ id: string } & z.infer<typeof writeFileEnvelopeSchema>)
  | ({ id: string } & z.infer<typeof runCommandEnvelopeSchema>)
  | ({ id: string } & z.infer<typeof runTestsEnvelopeSchema>)
  | ({ id: string } & z.infer<typeof rememberEnvelopeSchema>)
  | ({ id: string } & z.infer<typeof finishEnvelopeSchema>);

export type InvalidActionCode = 'invalid_json' | 'schema_invalid' | 'semantic_invalid';

export interface InvalidAction {
  ok: false;
  error: {
    code: InvalidActionCode;
    message: string;
    issues: string[];
  };
}

export interface ValidAction {
  ok: true;
  action: Action;
}

export type ActionParseResult = ValidAction | InvalidAction;
export type ActionIdFactory = () => string;

const forbiddenShellCharacters = /[\u0000\r\n;|&<>`$()]/;
const executableToken = /^[A-Za-z0-9._/-]+$/;

function hasUndefinedProperty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasUndefinedProperty);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.values(value).some((entry) => entry === undefined || hasUndefinedProperty(entry));
}

function schemaFailure(issues: string[]): InvalidAction {
  return {
    ok: false,
    error: {
      code: 'schema_invalid',
      message: '动作不符合严格结构约束。',
      issues
    }
  };
}

function semanticFailure(issues: string[]): InvalidAction {
  return {
    ok: false,
    error: {
      code: 'semantic_invalid',
      message: '动作字段不符合安全语义约束。',
      issues
    }
  };
}

function validateSemantics(envelope: ActionEnvelope): string[] {
  const issues: string[] = [];
  const path = envelope.type === 'list_files' || envelope.type === 'read_file' || envelope.type === 'write_file'
    ? envelope.path
    : undefined;

  if (path !== undefined && isAbsolute(path)) {
    issues.push('path 必须是相对路径。');
  }

  if (envelope.type === 'run_command') {
    if (!executableToken.test(envelope.command)) {
      issues.push('command 必须是单个可执行文件 token。');
    }
    if (forbiddenShellCharacters.test(envelope.command)) {
      issues.push('command 不得包含 shell 控制字符。');
    }
    if (envelope.args.some((arg) => forbiddenShellCharacters.test(arg))) {
      issues.push('args 不得包含 shell 控制字符。');
    }
  }

  return issues;
}

export class ActionParser {
  constructor(private readonly createId: ActionIdFactory = randomUUID) {}

  parse(input: unknown): ActionParseResult {
    let candidate = input;
    if (typeof input === 'string') {
      try {
        candidate = JSON.parse(input);
      } catch {
        return {
          ok: false,
          error: {
            code: 'invalid_json',
            message: '动作不是有效 JSON。',
            issues: ['无法解析完整 JSON 文本。']
          }
        };
      }
    }

    if (hasUndefinedProperty(candidate)) {
      return schemaFailure(['动作不得包含 undefined 字段。']);
    }

    const parsed = actionEnvelopeSchema.safeParse(candidate);
    if (!parsed.success) {
      return schemaFailure(parsed.error.issues.map((issue) => {
        const field = issue.path.length === 0 ? 'envelope' : issue.path.join('.');
        return `${field}: ${issue.message}`;
      }));
    }

    const semanticIssues = validateSemantics(parsed.data);
    if (semanticIssues.length > 0) {
      return semanticFailure(semanticIssues);
    }

    return { ok: true, action: { ...parsed.data, id: this.createId() } as Action };
  }
}
