import type { SessionState } from '../domain/session.js';

export interface SessionStore {
  save(session: SessionState): Promise<void>;
}

/** A deterministic store for the loop and its offline tests. */
export class InMemorySessionStore implements SessionStore {
  readonly saved: SessionState[] = [];

  async save(session: SessionState): Promise<void> {
    this.saved.push(structuredClone(session));
  }

  get(id: string): SessionState | undefined {
    const session = [...this.saved].reverse().find((candidate) => candidate.id === id);
    return session === undefined ? undefined : structuredClone(session);
  }
}
