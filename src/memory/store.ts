import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const MAX_TEXT_LENGTH = 300;
const MAX_RESULTS = 5;

export interface MemoryNote {
  id: string;
  scope: string;
  text: string;
  keywords: string[];
  createdAt: string;
}

export interface MemoryNoteInput {
  scope: string;
  text: string;
  keywords: string[];
}

export interface MemoryStoreOptions {
  now?: () => Date;
  createId?: () => string;
}

export class MemoryStoreError extends Error {
  constructor(
    readonly code: 'INVALID_NOTE' | 'DUPLICATE_NOTE' | 'INVALID_QUERY' | 'NO_MATCH' | 'CORRUPT_JSONL' | 'IO_ERROR',
    message: string
  ) {
    super(message);
    this.name = 'MemoryStoreError';
  }
}

/** A small, local JSONL store whose search ordering is stable across runs. */
export class MemoryStore {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly filePath: string,
    options: MemoryStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  append(note: MemoryNote): MemoryNote {
    const validated = validateNote(note);
    const existing = this.readNotes();

    if (existing.some((item) => item.id === validated.id)) {
      throw new MemoryStoreError('DUPLICATE_NOTE', `Duplicate memory note id: ${validated.id}.`);
    }
    if (existing.some((item) => item.scope === validated.scope && item.text === validated.text)) {
      throw new MemoryStoreError('DUPLICATE_NOTE', 'Duplicate memory note: scope and text already exist.');
    }

    try {
      appendFileSync(this.filePath, `${JSON.stringify(validated)}\n`, 'utf8');
    } catch (error) {
      throw new MemoryStoreError('IO_ERROR', `Unable to append memory JSONL: ${messageOf(error)}.`);
    }

    return copyNote(validated);
  }

  save(note: MemoryNote): MemoryNote {
    return this.append(note);
  }

  remember(input: MemoryNoteInput): MemoryNote {
    return this.append({
      ...input,
      id: this.createId(),
      createdAt: this.now().toISOString()
    });
  }

  search(query: string | readonly string[]): MemoryNote[] {
    const queryKeywords = queryToKeywords(query);
    const matches = this.readNotes()
      .map((note) => ({ note, overlap: countOverlap(note.keywords, queryKeywords) }))
      .filter((item) => item.overlap > 0)
      .sort((left, right) => {
        if (right.overlap !== left.overlap) {
          return right.overlap - left.overlap;
        }
        const recentDifference = Date.parse(right.note.createdAt) - Date.parse(left.note.createdAt);
        if (recentDifference !== 0) {
          return recentDifference;
        }
        return left.note.id.localeCompare(right.note.id);
      })
      .slice(0, MAX_RESULTS)
      .map((item) => copyNote(item.note));

    if (matches.length === 0) {
      throw new MemoryStoreError('NO_MATCH', 'No matching memory found for the query keywords.');
    }
    return matches;
  }

  retrieve(query: string | readonly string[]): MemoryNote[] {
    return this.search(query);
  }

  private readNotes(): MemoryNote[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      throw new MemoryStoreError('IO_ERROR', `Unable to read memory JSONL: ${messageOf(error)}.`);
    }

    const notes: MemoryNote[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        notes.push(validateNote(JSON.parse(line)));
      } catch (error) {
        const detail = error instanceof MemoryStoreError ? error.message : messageOf(error);
        throw new MemoryStoreError('CORRUPT_JSONL', `Corrupt memory JSONL at line ${index + 1}: ${detail}.`);
      }
    }
    return notes;
  }
}

function validateNote(value: unknown): MemoryNote {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new MemoryStoreError('INVALID_NOTE', 'Memory note id must be a non-empty string.');
  }
  if (typeof value.scope !== 'string' || value.scope.trim().length === 0) {
    throw new MemoryStoreError('INVALID_NOTE', 'Memory note scope must be a non-empty string.');
  }
  if (typeof value.text !== 'string' || value.text.length < 1 || Array.from(value.text).length > MAX_TEXT_LENGTH) {
    throw new MemoryStoreError('INVALID_NOTE', `Memory note text must contain 1 to ${MAX_TEXT_LENGTH} characters.`);
  }
  if (!Array.isArray(value.keywords) || value.keywords.length === 0 || value.keywords.some((keyword) => typeof keyword !== 'string' || keyword.trim().length === 0)) {
    throw new MemoryStoreError('INVALID_NOTE', 'Memory note keywords must be a non-empty list of non-empty strings.');
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw new MemoryStoreError('INVALID_NOTE', 'Memory note createdAt must be a valid timestamp.');
  }

  return {
    id: value.id,
    scope: value.scope,
    text: value.text,
    keywords: [...value.keywords],
    createdAt: value.createdAt
  };
}

function queryToKeywords(query: string | readonly string[]): string[] {
  const rawKeywords = typeof query === 'string' ? query.split(/\s+/) : [...query];
  const keywords = rawKeywords
    .filter((keyword): keyword is string => typeof keyword === 'string')
    .map((keyword) => keyword.trim().toLocaleLowerCase())
    .filter((keyword) => keyword.length > 0);

  if (keywords.length === 0) {
    throw new MemoryStoreError('INVALID_QUERY', 'Memory query must include at least one keyword.');
  }
  return [...new Set(keywords)];
}

function countOverlap(noteKeywords: readonly string[], queryKeywords: readonly string[]): number {
  const normalizedNoteKeywords = new Set(noteKeywords.map((keyword) => keyword.trim().toLocaleLowerCase()));
  return queryKeywords.reduce((count, keyword) => count + Number(normalizedNoteKeywords.has(keyword)), 0);
}

function copyNote(note: MemoryNote): MemoryNote {
  return { ...note, keywords: [...note.keywords] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
