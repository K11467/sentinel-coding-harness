import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionStore } from '../../src/core/session-store.js';
import { FileSessionStore } from '../../src/core/file-session-store.js';
import type { Action, ActionEnvelope } from '../../src/domain/actions.js';
import { ActionParser } from '../../src/domain/actions.js';
import type { SessionState } from '../../src/domain/session.js';
import { ApprovalService } from '../../src/security/approval.js';
import { PolicyEngine, type PolicyDecision } from '../../src/security/policy.js';
import type { HarnessConfig } from '../../src/domain/config.js';

const now = new Date('2026-08-14T00:00:00.000Z');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

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

async function requested(overrides: { ttlMs?: number; clock?: () => Date } = {}) {
  const store = new InMemorySessionStore();
  const initial = session();
  await store.save(initial);
  const policy = new PolicyEngine(config());
  const service = new ApprovalService(store, policy, {
    clock: overrides.clock ?? (() => now),
    ttlMs: overrides.ttlMs
  });
  const pending = action({ type: 'write_file', reason: '更新项目元数据', path: 'package.json', content: '{"private":true}' });
  const decision = policy.decide(pending);
  const request = await service.request(initial.id, pending, decision);

  expect(request).toMatchObject({ ok: true });
  return { store, policy, service, pending, decision, request };
}

async function stateFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-approval-'));
  temporaryDirectories.push(directory);
  return join(directory, 'approval-state.json');
}

async function requestedInFile(options: { ttlMs?: number; clock?: () => Date; statePath?: string } = {}) {
  const statePath = options.statePath ?? await stateFilePath();
  const store = new FileSessionStore(statePath);
  const initial = session();
  await store.save(initial);
  const policy = new PolicyEngine(config());
  const service = new ApprovalService(store, policy, {
    clock: options.clock ?? (() => now),
    ttlMs: options.ttlMs
  });
  const pending = action({ type: 'write_file', reason: '更新项目元数据', path: 'package.json', content: '{"private":true}' });
  const decision = policy.decide(pending);

  expect(await service.request(initial.id, pending, decision)).toMatchObject({ ok: true });
  return { statePath, store, policy, service, pending, decision };
}

describe('ApprovalService', () => {
  it('persists a session-bound, expiring approval record as a clone', async () => {
    const { service, store, decision } = await requested({ ttlMs: 1_000 });
    const record = await service.inspect('session-1', decision.actionHash);

    expect(record).toMatchObject({
      sessionId: 'session-1',
      actionHash: decision.actionHash,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 1_000).toISOString(),
      status: 'pending'
    });
    record!.status = 'consumed';
    const reconstructed = new ApprovalService(store, new PolicyEngine(config()), { clock: () => now });
    expect((await reconstructed.inspect('session-1', decision.actionHash))?.status).toBe('pending');
  });

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
    const { service, pending, decision, store } = await requested({ ttlMs: 1, clock: () => clock.value });
    clock.value = new Date(now.getTime() + 2);
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
    expect(store.get('session-1')!.pendingAction!.action).toMatchObject({ content: '{"private":true}' });

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
    expect(await service.request('session-1', pending, {
      ...policy.decide(pending),
      actionHash: 'sha256:wrong'
    })).toMatchObject({ ok: false, error: { code: 'action_hash_mismatch' } });
    expect(store.get('session-1')).toMatchObject({ status: 'running' });
  });

  it('keeps persisted snapshots cloned and rejects stale compare-and-set writes', async () => {
    const store = new InMemorySessionStore();
    await store.save(session());
    const first = await store.read('session-1');
    if (first === undefined) {
      throw new Error('expected stored session');
    }
    first.session.task = 'caller mutation';
    expect(store.get('session-1')?.task).toBe('调整受控配置');

    expect(await store.compareAndSet('session-1', first.version, { ...session(), task: 'first update' })).toBe(true);
    expect(await store.compareAndSet('session-1', first.version, { ...session(), task: 'stale overwrite' })).toBe(false);
    expect(store.get('session-1')?.task).toBe('first update');
  });

  it('reconstructs waiting approval state from a 0600 JSON file in a new store/service instance', async () => {
    const { statePath, decision, policy } = await requestedInFile();
    const reconstructedStore = new FileSessionStore(statePath);
    const reconstructed = new ApprovalService(reconstructedStore, policy, { clock: () => now });

    expect((await reconstructedStore.read('session-1'))?.session).toMatchObject({ status: 'waiting_approval' });
    expect(await reconstructed.inspect('session-1', decision.actionHash)).toMatchObject({ status: 'pending' });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it('does not leave a waiting session without its record when an atomic request rename fails', async () => {
    const statePath = await stateFilePath();
    const setupStore = new FileSessionStore(statePath);
    await setupStore.save(session());
    const policy = new PolicyEngine(config());
    const pending = action({ type: 'write_file', reason: '更新项目元数据', path: 'package.json', content: '{}' });
    const decision = policy.decide(pending);
    const failingStore = new FileSessionStore(statePath, {
      operations: { rename: async () => { throw new Error('injected rename failure'); } }
    });
    const service = new ApprovalService(failingStore, policy, { clock: () => now });

    expect(await service.request('session-1', pending, decision)).toMatchObject({ ok: false, error: { code: 'storage_failure' } });
    const restored = new FileSessionStore(statePath);
    expect((await restored.read('session-1'))?.session).toMatchObject({ status: 'running' });
    expect(await restored.getApproval('session-1', decision.actionHash)).toBeUndefined();
  });

  it('does not leave a restored running session with an unconsumed record when an atomic claim rename fails', async () => {
    const { statePath, service, policy, decision } = await requestedInFile();
    expect(await service.approve('session-1', decision.actionHash)).toMatchObject({ ok: true });
    const failingStore = new FileSessionStore(statePath, {
      operations: { rename: async () => { throw new Error('injected rename failure'); } }
    });
    const failingService = new ApprovalService(failingStore, policy, { clock: () => now });

    expect(await failingService.claim('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'storage_failure' } });
    const restored = new FileSessionStore(statePath);
    expect((await restored.read('session-1'))?.session).toMatchObject({ status: 'waiting_approval' });
    expect(await restored.getApproval('session-1', decision.actionHash)).toMatchObject({ status: 'approved' });
  });

  it('does not leave an approval_denied session without a rejected record when an atomic reject rename fails', async () => {
    const { statePath, policy, decision } = await requestedInFile();
    const failingStore = new FileSessionStore(statePath, {
      operations: { rename: async () => { throw new Error('injected rename failure'); } }
    });
    const failingService = new ApprovalService(failingStore, policy, { clock: () => now });

    expect(await failingService.reject('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'storage_failure' } });
    const restored = new FileSessionStore(statePath);
    expect((await restored.read('session-1'))?.session).toMatchObject({ status: 'waiting_approval' });
    expect(await restored.getApproval('session-1', decision.actionHash)).toMatchObject({ status: 'pending' });
  });

  it('fails closed for malformed approval records and at the exact expiry boundary', async () => {
    const clock = { value: now };
    const { statePath, service, policy, decision } = await requestedInFile({ ttlMs: 1, clock: () => clock.value });
    expect(await service.approve('session-1', decision.actionHash)).toMatchObject({ ok: true });
    clock.value = new Date(now.getTime() + 1);
    const atBoundary = new ApprovalService(new FileSessionStore(statePath), policy, { clock: () => clock.value, ttlMs: 1 });
    expect(await atBoundary.claim('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'approval_expired' } });

    const raw = JSON.parse(await readFile(statePath, 'utf8')) as { approvals: Record<string, { createdAt: string }> };
    const key = Object.keys(raw.approvals)[0]!;
    raw.approvals[key]!.createdAt = 'not-an-iso-date';
    await writeFile(statePath, JSON.stringify(raw), { mode: 0o600 });
    const malformed = new ApprovalService(new FileSessionStore(statePath), policy, { clock: () => clock.value });
    expect(await malformed.claim('session-1', decision.actionHash)).toMatchObject({ ok: false, error: { code: 'storage_invalid' } });
  });
});
