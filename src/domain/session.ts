import { z } from 'zod';
import { actionTypeSchema, type Action, type ActionType } from './actions.js';

const nonEmptyStringSchema = z.string().min(1);
const reasonSchema = z.string().min(1).max(500);

const internalActionSchema = z.discriminatedUnion('type', [
  z.object({ id: nonEmptyStringSchema, type: z.literal('list_files'), reason: reasonSchema, path: nonEmptyStringSchema.optional() }).strict(),
  z.object({ id: nonEmptyStringSchema, type: z.literal('read_file'), reason: reasonSchema, path: nonEmptyStringSchema }).strict(),
  z.object({ id: nonEmptyStringSchema, type: z.literal('write_file'), reason: reasonSchema, path: nonEmptyStringSchema, content: z.string() }).strict(),
  z.object({ id: nonEmptyStringSchema, type: z.literal('run_command'), reason: reasonSchema, command: nonEmptyStringSchema, args: z.array(nonEmptyStringSchema) }).strict(),
  z.object({ id: nonEmptyStringSchema, type: z.literal('run_tests'), reason: reasonSchema }).strict(),
  z.object({ id: nonEmptyStringSchema, type: z.literal('remember'), reason: reasonSchema, note: z.string().min(1).max(300) }).strict(),
  z.object({ id: nonEmptyStringSchema, type: z.literal('finish'), reason: reasonSchema, summary: z.string().min(1).max(1_000) }).strict()
]);

export const sessionStatusSchema = z.enum([
  'created',
  'running',
  'waiting_approval',
  'completed',
  'stopped',
  'blocked',
  'failed',
  'budget_exhausted',
  'cancelled'
]);

export const stopReasonSchema = z.enum([
  'finished',
  'max_steps',
  'repeated_action',
  'invalid_action',
  'approval_denied',
  'user_cancelled',
  'budget_exhausted',
  'provider_error',
  'tool_error',
  'policy_denied'
]);

export const actionSummarySchema = z.object({
  id: nonEmptyStringSchema,
  type: actionTypeSchema,
  reason: reasonSchema,
  createdAt: z.string().datetime()
}).strict();

export const feedbackSummarySchema = z.object({
  category: z.enum(['passed', 'assertion_failed', 'type_error', 'command_error', 'timeout']),
  summary: nonEmptyStringSchema,
  actionId: nonEmptyStringSchema,
  createdAt: z.string().datetime()
}).strict();

export const pendingActionSchema = z.object({
  action: internalActionSchema,
  actionHash: nonEmptyStringSchema
}).strict();

export const sessionStateSchema = z.object({
  id: nonEmptyStringSchema,
  status: sessionStatusSchema,
  step: z.number().int().min(0),
  task: nonEmptyStringSchema,
  stopReason: stopReasonSchema.optional(),
  recentActions: z.array(actionSummarySchema).max(8),
  recentFeedback: z.array(feedbackSummarySchema).max(8),
  pendingAction: pendingActionSchema.optional()
}).strict();

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type StopReason = z.infer<typeof stopReasonSchema>;
export type ActionSummary = z.infer<typeof actionSummarySchema>;
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;
export type PendingAction = { action: Action; actionHash: string };
export type SessionState = Omit<z.infer<typeof sessionStateSchema>, 'pendingAction'> & {
  pendingAction?: PendingAction;
};

export function summarizeAction(action: Action, createdAt: string): ActionSummary {
  return {
    id: action.id,
    type: action.type as ActionType,
    reason: action.reason,
    createdAt
  };
}
