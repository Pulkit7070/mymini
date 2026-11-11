import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { Claim, StoreEvent, Turn } from './types.js';

/**
 * Append-only JSONL event log, replayed into memory on boot.
 *
 * Why not SQLite: a single user's chat history is thousands of rows at most,
 * so the whole corpus fits in memory and every query is a linear scan over a
 * few hundred objects — microseconds. An append-only log also means a crash
 * mid-write can never corrupt earlier turns, and the file is greppable by a
 * human, which matters a lot when you are debugging what the agent "remembers".
 * The moment this is multi-user, this becomes Postgres and the retrieval code
 * above it does not change, because it only talks to the interface below.
 */
class MemoryStore {
  private turns = new Map<string, Turn>();
  private claims = new Map<string, Claim>();
  private file: string;
  private ready = false;

  constructor() {
    this.file = path.join(config.dataDir, 'memory.jsonl');
  }

  init(): void {
    if (this.ready) return;
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line) as StoreEvent);
        } catch {
          // A truncated final line after a hard kill is expected; skip it.
        }
      }
    }
    this.ready = true;
  }

  private apply(e: StoreEvent): void {
    switch (e.op) {
      case 'turn':
        this.turns.set(e.turn.id, e.turn);
        break;
      case 'patch': {
        const t = this.turns.get(e.id);
        if (t) this.turns.set(e.id, { ...t, ...e.fields });
        break;
      }
      case 'claim':
        this.claims.set(e.claim.id, e.claim);
        break;
      case 'claim-patch': {
        const c = this.claims.get(e.id);
        if (c) this.claims.set(e.id, { ...c, ...e.fields });
        break;
      }
    }
  }

  private write(e: StoreEvent): void {
    this.apply(e);
    fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
  }

  addTurn(t: Omit<Turn, 'id'> & { id?: string }): Turn {
    const turn: Turn = { ...t, id: t.id ?? randomUUID() };
    this.write({ op: 'turn', turn });
    return turn;
  }

  patchTurn(id: string, fields: Partial<Turn>): void {
    this.write({ op: 'patch', id, fields });
  }

  addClaim(c: Omit<Claim, 'id'> & { id?: string }): Claim {
    const claim: Claim = { ...c, id: c.id ?? randomUUID() };
    this.write({ op: 'claim', claim });
    return claim;
  }

  patchClaim(id: string, fields: Partial<Claim>): void {
    this.write({ op: 'claim-patch', id, fields });
  }

  allTurns(): Turn[] {
    return [...this.turns.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  getTurn(id: string): Turn | undefined {
    return this.turns.get(id);
  }

  sessionTurns(sessionId: string): Turn[] {
    return this.allTurns().filter((t) => t.sessionId === sessionId);
  }

  turnsBetween(startMs: number, endMs: number): Turn[] {
    return this.allTurns().filter((t) => {
      const ms = Date.parse(t.ts);
      return ms >= startMs && ms <= endMs;
    });
  }

  allClaims(): Claim[] {
    return [...this.claims.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  }

  claimsForTurns(turnIds: string[]): Claim[] {
    const set = new Set(turnIds);
    return this.allClaims().filter((c) => set.has(c.turnId));
  }

  getClaim(id: string): Claim | undefined {
    return this.claims.get(id);
  }

  sessions(): { id: string; title: string; startedAt: string; lastAt: string; turns: number }[] {
    const bySession = new Map<string, Turn[]>();
    for (const t of this.allTurns()) {
      const arr = bySession.get(t.sessionId) ?? [];
      arr.push(t);
      bySession.set(t.sessionId, arr);
    }
    return [...bySession.entries()]
      .map(([id, ts]) => ({
        id,
        title: ts[0].summary ?? ts[0].user.slice(0, 60),
        startedAt: ts[0].ts,
        lastAt: ts[ts.length - 1].ts,
        turns: ts.length,
      }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  stats() {
    return { turns: this.turns.size, claims: this.claims.size, file: this.file };
  }
}

export const store = new MemoryStore();
