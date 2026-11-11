import { store } from './store.js';
import { civilOf, detectSinceAnchor, formatDay, resolveTimeReferences, type ResolvedRef } from './temporal.js';
import type { Claim, Turn } from './types.js';

export interface RecalledTurn {
  turn: Turn;
  /** Why this turn was pulled in — shown in the UI so the mechanism is visible. */
  reason: 'recent' | 'time-match' | 'keyword' | 'entity';
  score: number;
}

export interface MemoryContext {
  refs: ResolvedRef[];
  recalled: RecalledTurn[];
  claims: Claim[];
  /** Open-ended "since then" window, if the message implies one. */
  sinceMs?: number;
  sinceLabel?: string;
}

const STOP = new Set(
  ('a an the and or but if then than that this these those is are was were be been being of to in on at for with ' +
   'from by as it its i you we they he she my your our me us do does did have has had what which who whom when ' +
   'where why how any some all can could would should will shall may might must about into over again still ' +
   'anything something please tell me ask asked say said').split(/\s+/),
);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * BM25 over turns. Tiny corpus, so an exact scan beats any index, and lexical
 * matching beats embeddings here: users refer back with the *same* proper nouns
 * they used before ("the CRM tools", "Postgres hosting"), which is precisely the
 * case where term matching is strong and semantic drift is a liability.
 */
function bm25(query: string, turns: Turn[]): Map<string, number> {
  const q = tokens(query);
  const docs = turns.map((t) => tokens(`${t.user} ${t.summary ?? ''} ${(t.entities ?? []).join(' ')} ${t.assistant.slice(0, 1200)}`));
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const term of new Set(d)) df.set(term, (df.get(term) ?? 0) + 1);

  const k1 = 1.5, b = 0.75;
  const scores = new Map<string, number>();
  docs.forEach((doc, i) => {
    let s = 0;
    for (const term of new Set(q)) {
      const f = doc.filter((x) => x === term).length;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgLen)));
    }
    if (s > 0 && substantive(turns[i])) scores.set(turns[i].id, s * groundedness(turns[i]));
  });
  return scores;
}

/**
 * Whether a turn is worth finding by keyword at all.
 *
 * Found the hard way. The agent once answered "I have no record of a prior
 * discussion on Postgres hosting", and that turn was stored like any other.
 * When the user asked again, the stored turn contained their question verbatim,
 * so it scored higher on every term than the real sourced answer from two days
 * earlier — and the agent read its own shrug and shrugged again. No amount of
 * down-weighting fixes that, because an exact echo of the query will always win
 * on term overlap.
 *
 * So the rule is categorical: lexical recall searches for *information*, and a
 * turn that established none is not information. It stays in the log and is
 * still reachable by date ("what did I ask you on 3 November?"), because as an
 * event it did happen. It just stops competing as an answer.
 */
function substantive(t: Turn): boolean {
  if (t.sources.length > 0) return true;
  if (store.claimsForTurns([t.id]).length > 0) return true;
  return t.assistant.length >= 300;
}

/** Among substantive turns, prefer the ones that established more. */
function groundedness(t: Turn): number {
  let w = 1;
  if (store.claimsForTurns([t.id]).length > 0) w += 0.5;
  if (t.sources.length > 0) w += 0.3;
  return w;
}

export function buildMemoryContext(
  message: string,
  sessionId: string,
  now = Date.now(),
): MemoryContext {
  const all = store.allTurns();
  const refs = resolveTimeReferences(message, now);
  const picked = new Map<string, RecalledTurn>();

  const add = (turn: Turn, reason: RecalledTurn['reason'], score: number) => {
    const prev = picked.get(turn.id);
    if (!prev || prev.score < score) picked.set(turn.id, { turn, reason, score });
  };

  // 1. The current conversation, always, in full. Nothing is more relevant than
  //    what we were just talking about.
  const current = store.sessionTurns(sessionId).slice(-8);
  for (const t of current) add(t, 'recent', 1000);

  // 2. Anything inside an explicitly named time window, plus the ambiguous
  //    alternate reading when English left one open.
  for (const ref of refs) {
    for (const t of store.turnsBetween(ref.startMs, ref.endMs)) add(t, 'time-match', 900);
    if (ref.alternate) {
      for (const t of store.turnsBetween(ref.alternate.startMs, ref.alternate.endMs)) add(t, 'time-match', 880);
    }
  }

  // 3. Lexical recall across every past conversation.
  const outside = all.filter((t) => !picked.has(t.id));
  const scores = bm25(message, outside);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [id, s] of ranked) {
    const t = store.getTurn(id);
    if (t && s > 0.9) add(t, 'keyword', s);
  }

  // 4. "Since then" with no explicit date: anchor on the most recent prior
  //    conversation that was not this one.
  let sinceMs: number | undefined;
  let sinceLabel: string | undefined;
  if (detectSinceAnchor(message)) {
    const anchors = refs.map((r) => r.startMs);
    if (anchors.length) {
      sinceMs = Math.min(...anchors);
      sinceLabel = refs.find((r) => r.startMs === sinceMs)?.label;
    } else {
      const prior = all.filter((t) => t.sessionId !== sessionId).at(-1) ?? all.at(-2);
      if (prior) {
        sinceMs = Date.parse(prior.ts);
        sinceLabel = formatDay(civilOf(sinceMs));
        add(prior, 'time-match', 870);
      }
    }
  }

  const recalled = [...picked.values()].sort((a, b) => a.turn.ts.localeCompare(b.turn.ts));

  // Claims attached to whatever we recalled, plus any claim whose subject is
  // named in the message outright ("has HubSpot changed?").
  const byTurn = store.claimsForTurns(recalled.map((r) => r.turn.id));
  const named = store.allClaims().filter((c) =>
    message.toLowerCase().includes(c.subject.toLowerCase().split(' ')[0].toLowerCase()) &&
    c.subject.split(' ')[0].length > 3,
  );
  const claims = dedupe([...byTurn, ...named]).slice(0, 40);

  return { refs, recalled, claims, sinceMs, sinceLabel };
}

function dedupe(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  return claims.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Free-text + time-filtered recall, exposed to the model as the `recall` tool. */
export function searchMemory(opts: {
  query?: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}): Turn[] {
  let pool = store.allTurns();
  if (opts.fromMs != null) pool = pool.filter((t) => Date.parse(t.ts) >= opts.fromMs!);
  if (opts.toMs != null) pool = pool.filter((t) => Date.parse(t.ts) <= opts.toMs!);
  if (!opts.query) return pool.slice(-(opts.limit ?? 10));
  const scores = bm25(opts.query, pool);
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.limit ?? 8)
    .map(([id]) => store.getTurn(id)!)
    .filter(Boolean);
}
