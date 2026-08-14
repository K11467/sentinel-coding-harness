import type { CommandRule, PolicyRule } from '../domain/config.js';

/** Defaults remain explicit so a minimal harness.yaml cannot broaden policy. */
export const DEFAULT_MODEL = 'gpt-5.4-mini';
export const DEFAULT_MAX_STEPS = 6;
export const DEFAULT_MAX_COST_CNY = 70;

export const DEFAULT_ALLOWED_COMMANDS: readonly CommandRule[] = Object.freeze([]);
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = Object.freeze([]);

export const DEFAULT_HARNESS_CONFIG = Object.freeze({
  model: DEFAULT_MODEL,
  maxSteps: DEFAULT_MAX_STEPS,
  maxCostCny: DEFAULT_MAX_COST_CNY,
  allowedCommands: DEFAULT_ALLOWED_COMMANDS,
  policyRules: DEFAULT_POLICY_RULES
});
