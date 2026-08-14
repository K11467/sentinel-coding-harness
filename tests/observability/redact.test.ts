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
    `plain ${['sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')}`,
    'short sk-safe',
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

  test('完整隐藏 JSON Authorization header 的值', () => {
    expect(redactText('{"Authorization":"Bearer sk-json-secret"}')).toBe('{"Authorization":"[REDACTED]"}');
  });

  test('以 UTF-8 字节数安全截断多字节内容', () => {
    const result = truncateUtf8('你好世界', 9);

    expect(result).toBe('你好…');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(9);
  });

  test('只处理 own entries，并安全标记 getter、循环、过深和危险键', () => {
    const inherited = Object.create({ accessToken: 'inherited-access-token' }) as { label: string };
    inherited.label = 'safe';
    const getterInput = Object.defineProperty({}, 'details', {
      enumerable: true,
      get: () => {
        throw new Error('getter-secret-at-/private/path');
      },
    });
    const cycle: Record<string, unknown> = { secretKey: 'cycle-secret' };
    cycle.self = cycle;
    let deep: Record<string, unknown> = { privateKey: 'deep-private-key' };
    for (let index = 0; index < 20; index += 1) {
      deep = { next: deep };
    }
    const protoInput = JSON.parse('{"safe":"yes","__proto__":{"accessToken":"proto-secret"}}') as Record<string, unknown>;

    const result = redact({ inherited, getterInput, cycle, deep, protoInput });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ inherited: { label: 'safe' }, getterInput: { details: '[REDACTED]' } });
    expect(serialized).not.toContain('inherited-access-token');
    expect(serialized).not.toContain('getter-secret-at-/private/path');
    expect(serialized).not.toContain('cycle-secret');
    expect(serialized).not.toContain('deep-private-key');
    expect(serialized).not.toContain('proto-secret');
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

  test.each([
    ['apiKey', 'apiKey=raw-api-camel-secret'],
    ['api_key', '{"api_key":"raw-api-under-secret"}'],
    ['api-key', 'X-API-Key: raw-api-header-secret'],
    ['clientSecret', 'clientSecret=raw-client-camel-secret'],
    ['client_secret', 'https://example.test/?client_secret=raw-client-query-secret'],
    ['accessToken', 'accessToken=raw-access-camel-secret'],
    ['access_token', '{"access_token":"raw-access-under-secret"}'],
    ['secretKey', 'secretKey=raw-secret-key'],
    ['privateKey', '{"privateKey":"raw-private-key"}'],
  ])('隐藏 %s 的原始值，不进入字符串、嵌套值或审计输出', async (field, input) => {
    const rawValue = input.match(/raw-[a-z-]+/)?.[0];
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-audit-sensitive-'));
    const filePath = join(directory, 'audit.jsonl');
    const audit = new AuditLog(filePath);

    const text = redactText(input);
    const nested = redact({ nested: { [field]: rawValue }, note: input });
    await audit.append({
      sessionId: 'session-sensitive',
      event: 'policy_decision',
      action: { type: 'write_file', reason: input },
      policy: { effect: 'allow', ruleId: 'safe-write', risk: 'low' },
    });

    const rawLog = await readFile(filePath, 'utf8');
    const readBack = await audit.read();

    expect(rawValue).toBeDefined();
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(rawValue as string);
    expect(JSON.stringify(nested)).not.toContain(rawValue as string);
    expect(rawLog).not.toContain(rawValue as string);
    expect(JSON.stringify(readBack)).not.toContain(rawValue as string);
  });

  test('拒绝 getter、继承属性和 JSON 原型污染，并折叠异常详情', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-audit-invalid-'));
    const audit = new AuditLog(join(directory, 'audit.jsonl'));
    const getterEvent = Object.defineProperties({}, {
      sessionId: {
        enumerable: true,
        get: () => {
          throw new Error('secret-from-getter-/private/path');
        },
      },
      event: { enumerable: true, value: 'state_transition' },
    });
    const inheritedEvent = Object.create({ sessionId: 'inherited-session', event: 'state_transition' });
    const protoEvent = JSON.parse(
      '{"sessionId":"session-1","event":"state_transition","__proto__":{"privateKey":"proto-private-secret"}}',
    );

    for (const event of [getterEvent, inheritedEvent, protoEvent]) {
      await expect(audit.append(event as never)).rejects.toThrow('Invalid audit event.');
      await expect(audit.append(event as never)).rejects.not.toThrow(/secret|path/);
    }
  });

  test.each([0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝不安全的工具 exitCode：%s',
    async (exitCode) => {
      const directory = await mkdtemp(join(tmpdir(), 'sentinel-audit-exit-'));
      const audit = new AuditLog(join(directory, 'audit.jsonl'));

      await expect(
        audit.append({ sessionId: 'session-1', event: 'tool_result', tool: { kind: 'run_tests', ok: false, exitCode } }),
      ).rejects.toThrow('Invalid audit event.');
    },
  );
});
