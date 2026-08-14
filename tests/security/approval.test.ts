import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../../src/core/session-store.js';
import type { Action, ActionEnvelope } from '../../src/domain/actions.js';
import { ActionParser } from '../../src/domain/actions.js';
import type { SessionState } from '../../src/domain/session.js';
import { ApprovalService } from '../../src/security/approval.js';
import { PolicyEngine, type PolicyDecision } from '../../src/security/policy.js';
import type { HarnessConfig } from '../../src/domain/config.js';

const now = new Date('2026-08-14T00:00:00.000Z');

function config(): HarnessConfig {
  return {
    workspaceRoot: '/workspace/project',
    model: 'test-model',
    maxSteps: 6,
    maxCostCny: 70,
    allowedCommands: [],
    policyRules: []
  };
}

function action(input: ActionEnvelope): Action {
  const parsed = new ActionParser(() => 'action-1').parse(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.action;
}

function session(id = 'session-1'): SessionState {
  return {
    id,
    status: 'running',
    step: 1,
    task: '调整受控配置',
    recentActions: [],
    recentFeedback: []
  };
}

async function requested(overrides: { ttlMs?: number; currentTime?: Date } = {}) {
  const store = new InMemorySessionStore();
  const initial = session();
  await store.save(initial);
  const policy = new PolicyEngine(config());
  const service = new ApprovalService(store, policy, {
    clock: () => overrides.currentTime ?? now,
    ttlMs: overrides.ttlMs
  });
  const pending = action({ type: 'write_file', reason: '更新项目元数据', path: 'package.json', content: '{"private":true}' });
  const decision = policy.decide(pending);
  const request = await service.request(initial.id, pending, decision);

  expect(request).toMatchObject({ ok: true });
  return { store, policy, service, pending, decision, request };
}

describe('ApprovalService', () => {
  it('does not release an action before approval', async () => {
    const { service, decision } = await requested();

    const claim = await service.claim('session-1', decision.actionHash);

    expect(claim).toMatchObject({ ok: false, error: { code: 'not_approved' } });
  });

  it('does not approve or release a wrong hash', async () => {
    const { service, store, pending } = await requested();

    expect(await service.approve('session-1', 'sha256:wrong')).toMatchObject({ ok: false, error: { code: 'approval_not_found' } });
    expect(await service.claim('session-1', 'sha256:wrong')).toMatchObject({ ok: false });
    expect(store.get('session-1')).toMatchObject({ status: 'waiting_approval', pendingAction: { action: pending } });
  });

  it('does not release an expired approval', async () => {
    const clock = { value: now };
    const { service, pending, decision, store } = await requested({ ttlMs: 1, currentTime: clock.value });
    clock.value = new Date(now.getTime() + 2);
    const expires = new ApprovalService(store, new PolicyEngine(config()), { clock: () => clock.value, ttlMs: 1 });

    expect(await expires.approve('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'approval_not_found' } });
    expect(await service.approve('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'approval_expired' } });
    expect(await service.claim('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'approval_expired' } });
    expect(store.get('session-1')).toMatchObject({ status: 'waiting_approval', pendingAction: { action: pending } });
  });

  it('consumes an approval atomically so it cannot be replayed', async () => {
    const { service, pending, decision, store } = await requested();

    expect(await service.approve('session-1', decision.actionHash)).toMatchObject({ ok: true });
    expect(await service.resume('session-1', decision.actionHash)).toMatchObject({ ok: true, action: pending, session: { status: 'running' } });
    expect(await service.claim('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'approval_consumed' } });
    expect(store.get('session-1')).toMatchObject({ status: 'running' });
    expect(store.get('session-1')?.pendingAction).toBeUndefined();
  });

  it('moves a rejected pending action into the approval_denied terminal state', async () => {
    const { service, decision, store } = await requested();

    expect(await service.reject('session-1', decision.actionHash)).toMatchObject({
      ok: true,
      session: { status: 'stopped', stopReason: 'approval_denied' }
    });
    expect(store.get('session-1')).toMatchObject({ status: 'stopped', stopReason: 'approval_denied' });
    expect(await service.claim('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'approval_rejected' } });
  });

  it('never releases a tampered stored pending action or a caller-mutated clone', async () => {
    const { service, decision, store } = await requested();
    const stored = store.get('session-1')!;
    stored.pendingAction!.action = action({ type: 'write_file', reason: '篡改内容', path: 'package.json', content: '{"private":false}' });
    expect(store.get('session-1')!.pendingAction!.action.content).toBe('{"private":true}');

    await store.save({
      ...store.get('session-1')!,
      pendingAction: {
        action: action({ type: 'write_file', reason: '篡改内容', path: 'package.json', content: '{"private":false}' }),
        actionHash: decision.actionHash
      }
    });
    expect(await service.approve('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'pending_mismatch' } });
    expect(await service.claim('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'not_approved' } });
  });

  it('accepts only require_approval decisions with a matching verified action hash', async () => {
    const store = new InMemorySessionStore();
    await store.save(session());
    const policy = new PolicyEngine(config());
    const service = new ApprovalService(store, policy, { clock: () => now });
    const pending = action({ type: 'write_file', reason: '更新项目元数据', path: 'package.json', content: '{}' });
    const decision: PolicyDecision = { ...policy.decide(pending), effect: 'allow' };

    expect(await service.request('session-1', pending, decision)).toMatchObject({ ok: false, error: { code: 'approval_not_required' } });
    expect(store.get('session-1')).toMatchObject({ status: 'running' });
  });
});
