import { describe, expect, it } from 'vitest';
import { ActionParser, type Action, type ActionEnvelope } from '../../src/domain/actions.js';
import type { HarnessConfig } from '../../src/domain/config.js';
import { PolicyEngine } from '../../src/security/policy.js';

const workspaceRoot = '/workspace/project';

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    workspaceRoot,
    model: 'test-model',
    maxSteps: 6,
    maxCostCny: 70,
    allowedCommands: [],
    policyRules: [],
    ...overrides
  };
}

function action(input: ActionEnvelope): Action {
  const parsed = new ActionParser(() => 'action-1').parse(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.action;
}

function unsafeAction(input: ActionEnvelope): Action {
  return { ...input, id: 'unsafe-action' } as Action;
}

describe('PolicyEngine', () => {
  it.each([
    action({ type: 'run_command', reason: 'clean build output', command: 'rm', args: ['-rf', 'dist'] }),
    action({ type: 'run_command', reason: 'publish branch', command: 'git', args: ['push', 'origin', 'main'] }),
    action({ type: 'run_command', reason: 'elevate privileges', command: 'sudo', args: ['true'] }),
    action({ type: 'run_command', reason: 'drop database', command: 'dropdb', args: ['app'] })
  ])('denies irrevocably dangerous commands: $command', (dangerous) => {
    const decision = new PolicyEngine(config()).decide(dangerous);

    expect(decision.effect).toBe('deny');
    expect(decision.risk).toBe('critical');
    expect(decision.actionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    unsafeAction({ type: 'read_file', reason: 'inspect source', path: '../private.txt' }),
    unsafeAction({ type: 'write_file', reason: 'write outside', path: '/tmp/outside.ts', content: 'export {};' }),
    unsafeAction({ type: 'list_files', reason: 'windows path', path: 'C:\\outside' })
  ])('denies paths outside the workspace', (outside) => {
    const decision = new PolicyEngine(config()).decide(outside);

    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBe('deny.workspace-boundary');
  });

  it('requires approval for CI or release configuration writes', () => {
    const decision = new PolicyEngine(config()).decide(action({
      type: 'write_file',
      reason: 'adjust pipeline',
      path: '.github/workflows/ci.yml',
      content: 'name: ci'
    }));

    expect(decision).toMatchObject({
      effect: 'require_approval',
      ruleId: 'approval.ci-release-config',
      risk: 'high'
    });
  });

  it('allows reads, tests, remember, and the safe npm test command', () => {
    const engine = new PolicyEngine(config());

    expect(engine.decide(action({ type: 'read_file', reason: 'inspect', path: 'src/main.ts' })).effect).toBe('allow');
    expect(engine.decide(action({ type: 'run_tests', reason: 'verify' })).effect).toBe('allow');
    expect(engine.decide(action({ type: 'remember', reason: 'record', note: 'use strict schemas' })).effect).toBe('allow');
    expect(engine.decide(action({ type: 'run_command', reason: 'test', command: 'npm', args: ['test', '--', 'policy'] }))).toMatchObject({
      effect: 'allow',
      ruleId: 'allow.npm-test'
    });
  });

  it('allows ordinary source writes but conservatively pauses unknown writes', () => {
    const engine = new PolicyEngine(config());

    expect(engine.decide(action({ type: 'write_file', reason: 'add source', path: 'src/policy.ts', content: 'export {};' })).effect).toBe('allow');
    expect(engine.decide(action({ type: 'write_file', reason: 'update metadata', path: 'package.json', content: '{}' })).effect).toBe('require_approval');
  });

  it('matches allowed command rules by exact command and args prefix only', () => {
    const engine = new PolicyEngine(config({
      allowedCommands: [{ command: 'node', argsPrefix: ['scripts/check.mjs'] }]
    }));

    expect(engine.decide(action({ type: 'run_command', reason: 'check', command: 'node', args: ['scripts/check.mjs', '--fast'] })).effect).toBe('allow');
    expect(engine.decide(action({ type: 'run_command', reason: 'different script', command: 'node', args: ['scripts/check-other.mjs'] })).effect).toBe('require_approval');
    expect(engine.decide(action({ type: 'run_command', reason: 'different executable', command: 'nodejs', args: ['scripts/check.mjs'] })).effect).toBe('require_approval');
  });

  it('uses the first matching custom policy rule before allowed commands', () => {
    const engine = new PolicyEngine(config({
      allowedCommands: [{ command: 'node', argsPrefix: ['scripts/check.mjs'] }],
      policyRules: [
        {
          id: 'review-check',
          effect: 'require_approval',
          risk: 'medium',
          match: { types: ['run_command'], commands: ['node'] }
        },
        {
          id: 'later-allow',
          effect: 'allow',
          risk: 'low',
          match: { types: ['run_command'] }
        }
      ]
    }));

    expect(engine.decide(action({ type: 'run_command', reason: 'check', command: 'node', args: ['scripts/check.mjs'] }))).toMatchObject({
      effect: 'require_approval',
      ruleId: 'review-check',
      risk: 'medium'
    });
  });

  it('does not allow custom policy rules to bypass irrevocable denies', () => {
    const engine = new PolicyEngine(config({
      policyRules: [{
        id: 'unsafe-exception',
        effect: 'allow',
        risk: 'low',
        match: { types: ['run_command'], commands: ['git'] }
      }]
    }));

    expect(engine.decide(action({ type: 'run_command', reason: 'push', command: 'git', args: ['push'] }))).toMatchObject({
      effect: 'deny',
      ruleId: 'deny.git-push'
    });
  });

  it('creates a stable content-binding hash without putting file content in the reason', () => {
    const engine = new PolicyEngine(config());
    const secretContent = 'const apiToken = "do-not-log-me";';
    const first = engine.decide(action({ type: 'write_file', reason: 'save implementation', path: 'src/app.ts', content: secretContent }));
    const second = engine.decide(action({ type: 'write_file', reason: 'save implementation', path: 'src/app.ts', content: secretContent }));
    const changed = engine.decide(action({ type: 'write_file', reason: 'save implementation', path: 'src/app.ts', content: 'const apiToken = "changed";' }));

    expect(first.actionHash).toBe(second.actionHash);
    expect(first.actionHash).not.toBe(changed.actionHash);
    expect(first.reason).not.toContain(secretContent);
    expect(first.reason).not.toContain('do-not-log-me');
  });

  it('defaults unknown and network-like commands to approval', () => {
    const engine = new PolicyEngine(config());

    expect(engine.decide(action({ type: 'run_command', reason: 'download', command: 'curl', args: ['https://example.test'] }))).toMatchObject({
      effect: 'require_approval',
      ruleId: 'approval.network-command',
      risk: 'high'
    });
    expect(engine.decide(action({ type: 'run_command', reason: 'unknown', command: 'make', args: ['all'] }))).toMatchObject({
      effect: 'require_approval',
      ruleId: 'approval.unknown-command',
      risk: 'high'
    });
  });
});
