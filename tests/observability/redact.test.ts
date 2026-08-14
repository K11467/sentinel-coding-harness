import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AuditLog } from '../../src/observability/audit.js';
import { redact, redactText, truncateUtf8 } from '../../src/observability/redact.js';

describe('统一脱敏', () => {
  test.each([
    'Authorization: Bearer sk-live-secret-value',
    'authorization=Basic dXNlcjpzZWNyZXQ=',
    'AUTHORIZATION: Token top-secret',
    '{"Authorization":"Bearer sk-json-secret"}',
    'Cookie: session=very-secret; theme=dark',
    'set-cookie=auth=very-secret',
    'X-API-Key: sk-header-secret',
    'api_key=sk-query-secret&name=ok',
    'password=hunter2',
    'secret: whispered',
    'token=abc123',
    'plain sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    'encoded=sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz0123456789',
    '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
  ])('隐藏敏感文本：%s', (input) => {
    const output = redactText(input);

    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('sk-live-secret-value');
    expect(output).not.toContain('dXNlcjpzZWNyZXQ=');
    expect(output).not.toContain('very-secret');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('private-material');
  });

  test('递归脱敏对象和数组，且不改变原输入', () => {
    const input = {
      headers: { Authorization: 'Bearer sk-nested-secret', 'X-API-Key': 'key-secret' },
      nested: [{ password: 'do-not-log' }, { label: 'safe' }],
    };

    const result = redact(input);

    expect(result).toEqual({
      headers: { Authorization: '[REDACTED]', 'X-API-Key': '[REDACTED]' },
      nested: [{ password: '[REDACTED]' }, { label: 'safe' }],
    });
    expect(input.headers.Authorization).toBe('Bearer sk-nested-secret');
    expect(input.nested[0]?.password).toBe('do-not-log');
  });

  test('以 UTF-8 字节数安全截断多字节内容', () => {
    const result = truncateUtf8('你好世界', 7);

    expect(result).toBe('你好…');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(9);
  });
});

describe('AuditLog', () => {
  test('追加可读回的脱敏 JSONL 受控事件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-audit-'));
    const filePath = join(directory, 'audit.jsonl');
    const audit = new AuditLog(filePath);

    await audit.append({
      sessionId: 'session-1',
      event: 'policy_decision',
      action: {
        type: 'write_file',
        reason: 'Authorization: Bearer sk-action-secret',
        path: 'src/example.ts',
        content: 'x'.repeat(10_000),
      },
      policy: { effect: 'allow', ruleId: 'safe-write', risk: 'low', reason: 'ok' },
    });

    const raw = await readFile(filePath, 'utf8');
    const entries = await audit.read();

    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(raw).not.toContain('sk-action-secret');
    expect(raw).not.toContain('x'.repeat(100));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: 'session-1',
      event: 'policy_decision',
      action: { type: 'write_file', path: 'src/example.ts', contentBytes: 10_000 },
      policy: { effect: 'allow', ruleId: 'safe-write', risk: 'low' },
    });
    expect(entries[0]?.action).not.toHaveProperty('content');
    expect(entries[0]?.action?.reason).toContain('[REDACTED]');
  });

  test('写入失败只返回泛化错误，不泄露审计路径', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-audit-error-'));
    const audit = new AuditLog(directory);

    await expect(audit.append({ sessionId: 'session-1', event: 'state_transition' })).rejects.toThrow(
      'Unable to write audit log.',
    );
    await expect(audit.append({ sessionId: 'session-1', event: 'state_transition' })).rejects.not.toThrow(directory);
  });
});
