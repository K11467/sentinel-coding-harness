import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { MemoryStore, type MemoryNote } from '../../src/memory/store.js';

const temporaryDirectories: string[] = [];

function createStore(now: () => Date = () => new Date('2026-08-14T10:00:00.000Z')): {
  filePath: string;
  store: MemoryStore;
} {
  const directory = mkdtempSync(join(tmpdir(), 'harness-memory-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'notes.jsonl');
  return { filePath, store: new MemoryStore(filePath, { now }) };
}

function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: 'note-1',
    scope: 'project',
    text: 'Use the checked-in formatter for TypeScript changes.',
    keywords: ['typescript', 'formatter'],
    createdAt: '2026-08-14T10:00:00.000Z',
    ...overrides
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MemoryStore', () => {
  test('以 JSONL 追加写入，并能由新实例重新加载', () => {
    const { filePath, store } = createStore();
    const saved = store.append(note());

    expect(saved).toEqual(note());
    expect(readFileSync(filePath, 'utf8')).toBe(JSON.stringify(note()) + '\n');
    expect(new MemoryStore(filePath).search('formatter')).toEqual([note()]);
  });

  test('按关键词重叠优先、再按新近度排序，完全相同时以 id 固定排序', () => {
    const { store } = createStore();
    store.append(note({ id: 'z-old', text: '旧的两个关键词', keywords: ['typescript', 'formatter'], createdAt: '2026-08-10T00:00:00.000Z' }));
    store.append(note({ id: 'a-new', text: '新的两个关键词', keywords: ['typescript', 'formatter'], createdAt: '2026-08-13T00:00:00.000Z' }));
    store.append(note({ id: 'b-one', text: '一个关键词但更新', keywords: ['typescript'], createdAt: '2026-08-14T00:00:00.000Z' }));
    store.append(note({ id: 'a-tie', text: '完全并列 A', keywords: ['typescript'], createdAt: '2026-08-14T00:00:00.000Z' }));

    expect(store.search('formatter typescript').map((item) => item.id)).toEqual(['a-new', 'z-old', 'a-tie', 'b-one']);
  });

  test('拒绝重复 note 和超过 300 字符的文本，且不写入文件', () => {
    const { filePath, store } = createStore();
    store.append(note());

    expect(() => store.append(note({ id: 'note-2' }))).toThrow(/duplicate.*scope.*text/i);
    expect(() => store.append(note({ id: 'note-3', text: 'a'.repeat(301) }))).toThrow(/text.*1.*300/i);
    expect(readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('最多返回五条匹配记忆', () => {
    const { store } = createStore();
    for (let index = 0; index < 6; index += 1) {
      store.append(note({
        id: `note-${index}`,
        text: `TypeScript note ${index}`,
        keywords: ['typescript'],
        createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
      }));
    }

    expect(store.search('typescript').map((item) => item.id)).toEqual(['note-5', 'note-4', 'note-3', 'note-2', 'note-1']);
  });

  test('对空查询和无匹配记忆返回可操作错误', () => {
    const { store } = createStore();
    store.append(note());

    expect(() => store.search('   ')).toThrow(/query.*keyword/i);
    expect(() => store.search('python')).toThrow(/no matching.*memory/i);
  });

  test('损坏的 JSONL 返回行号明确的错误，不静默忽略', () => {
    const { filePath, store } = createStore();
    writeFileSync(filePath, JSON.stringify(note()) + '\n{not valid json}\n', 'utf8');

    expect(() => store.search('formatter')).toThrow(/corrupt.*JSONL.*line 2/i);
  });
});
