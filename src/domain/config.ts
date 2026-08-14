import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { actionTypeSchema, type ActionType } from './actions.js';

const nonEmptyStringSchema = z.string().min(1);

export const commandRuleSchema = z.object({
  command: nonEmptyStringSchema,
  argsPrefix: z.array(nonEmptyStringSchema)
}).strict();

export const policyRuleSchema = z.object({
  id: nonEmptyStringSchema,
  effect: z.enum(['allow', 'require_approval', 'deny']),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  match: z.object({
    types: z.array(actionTypeSchema).optional(),
    pathPrefixes: z.array(nonEmptyStringSchema).optional(),
    commands: z.array(nonEmptyStringSchema).optional()
  }).strict()
}).strict();

const harnessConfigInputSchema = z.object({
  workspaceRoot: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema.optional(),
  maxSteps: z.number().int().min(1).max(12).optional(),
  maxCostCny: z.number().min(1).max(70).optional(),
  allowedCommands: z.array(commandRuleSchema).optional(),
  policyRules: z.array(policyRuleSchema).optional()
}).strict();

export type CommandRule = z.infer<typeof commandRuleSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type PolicyMatch = {
  types?: ActionType[];
  pathPrefixes?: string[];
  commands?: string[];
};

export interface HarnessConfig {
  workspaceRoot: string;
  model: string;
  maxSteps: number;
  maxCostCny: number;
  allowedCommands: CommandRule[];
  policyRules: PolicyRule[];
}

export function parseHarnessConfig(input: unknown, cwd = process.cwd()): HarnessConfig {
  const parsed = harnessConfigInputSchema.parse(input);
  const configuredRoot = parsed.workspaceRoot ?? cwd;

  return {
    workspaceRoot: realpathSync(resolve(cwd, configuredRoot)),
    model: parsed.model ?? 'gpt-5.4-mini',
    maxSteps: parsed.maxSteps ?? 6,
    maxCostCny: parsed.maxCostCny ?? 70,
    allowedCommands: parsed.allowedCommands ?? [],
    policyRules: parsed.policyRules ?? []
  };
}
