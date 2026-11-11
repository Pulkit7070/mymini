import { config } from '../config.js';
import { buildMemoryContext } from '../memory/retrieval.js';
import { store } from '../memory/store.js';
import type { Source } from '../memory/types.js';
import { SourceRegistry } from '../search/index.js';
import { enrichTurn } from './claims.js';
import { llm, type NMessage } from './provider.js';
import { STATIC_SYSTEM, volatileSystem } from './prompt.js';
import { runTool, TOOL_DEFS, type ToolEvent } from './tools.js';

export type AgentEvent =
  | { type: 'memory'; refs: { text: string; label: string }[]; recalled: { ts: string; user: string; summary?: string; reason: string }[]; claims: number }
  | { type: 'tool'; tool: ToolEvent }
  | { type: 'text'; delta: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'done'; turnId: string; ms: number }
  | { type: 'error'; message: string };

/**
 * Four is enough for search -> open the primary source -> answer, with one
 * round spare. Higher ceilings mostly buy a model the rope to re-check
 * something it already checked, which the user experiences as latency.
 */
const MAX_TOOL_ROUNDS = 4;

const FINAL_ROUND_NOTE =
  '## Answer now\nYou have no tools left for this turn. Answer from what you already gathered. ' +
  'If something is still unchecked, say which part is unconfirmed rather than implying you verified it.';

function dedupeCalls(calls: { id: string; name: string; input: any }[]) {
  const seen = new Set<string>();
  return calls.filter((c) => {
    const key = `${c.name}:${JSON.stringify(c.input ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeCall(name: string, input: any): ToolEvent | null {
  switch (name) {
    // Only the searches are announced up front; the page reads announce
    // themselves from inside the tool, once it knows what it fetched.
    case 'web_search':
      return input?.queries?.length ? { kind: 'search', queries: input.queries } : null;
    case 'recall':
      return { kind: 'recall', query: input?.query ?? [input?.from, input?.to].filter(Boolean).join(' to ') };
    default:
      return null;
  }
}

export async function* chat(opts: {
  message: string;
  sessionId: string;
  now?: number;
}): AsyncGenerator<AgentEvent> {
  const started = Date.now();
  const now = opts.now ?? started;
  const { message, sessionId } = opts;

  // 1. Assemble memory. Local, synchronous, sub-millisecond.
  const mem = buildMemoryContext(message, sessionId, now);
  yield {
    type: 'memory',
    refs: mem.refs.map((r) => ({ text: r.text, label: r.label })),
    recalled: mem.recalled
      .filter((r) => r.reason !== 'recent')
      .map((r) => ({ ts: r.turn.ts, user: r.turn.user.slice(0, 140), summary: r.turn.summary, reason: r.reason })),
    claims: mem.claims.length,
  };

  // 2. The current thread goes in as real dialogue; everything recalled from
  //    other days goes in the system block, labelled with its date. Mixing the
  //    two makes the model treat a six-week-old exchange as the last thing said.
  const history = store.sessionTurns(sessionId).slice(-8);
  const messages: NMessage[] = [];
  for (const t of history) {
    messages.push({ role: 'user', content: t.user });
    messages.push({ role: 'assistant', content: t.assistant });
  }
  messages.push({ role: 'user', content: message });

  const crossSession = { ...mem, recalled: mem.recalled.filter((r) => r.reason !== 'recent') };
  const system = [STATIC_SYSTEM, volatileSystem(crossSession, now)];

  const sources = new SourceRegistry();
  const pending: ToolEvent[] = [];
  const ctx = { sources, onEvent: (e: ToolEvent) => pending.push(e) };

  let answer = '';
  let round = 0;
  /**
   * The round ceiling, which tightens once the claim verifier has reported.
   *
   * verify_claims already fetched the live pages and diffed them, so anything
   * after it is usually the model re-doing settled work — asked politely in the
   * prompt not to, and doing it anyway. One extra round is left for the parts
   * the ledger had nothing stored for ("...or shipped something big since?"),
   * and then it has to answer. Making this structural rather than a request is
   * the difference between a 10-second reply and a 75-second one.
   */
  let budget = MAX_TOOL_ROUNDS;

  try {
    while (round++ < budget) {
      // On the final round the tools are withheld, which forces an answer.
      // Without this a model that keeps calling tools until the budget runs out
      // leaves the user with a blank reply after a minute and a half of work —
      // the worst possible outcome, and one that actually happened.
      const lastRound = round >= budget;
      const stream = llm().stream({
        system: lastRound ? [...system, FINAL_ROUND_NOTE] : system,
        messages,
        tools: lastRound ? undefined : TOOL_DEFS,
        maxTokens: 2048,
        model: config.model,
      });

      // Drive the generator by hand so we can keep its return value, which
      // carries the tool calls alongside the streamed text.
      let result;
      while (true) {
        const step = await stream.next();
        if (step.done) { result = step.value; break; }
        answer += step.value;
        yield { type: 'text', delta: step.value };
      }

      // Models sometimes emit the same call twice in one message. Running it
      // twice doubles the wait for an identical result.
      const calls = dedupeCalls(result.toolCalls);
      messages.push({ role: 'assistant', content: result.text, toolCalls: calls });
      if (!calls.length) break;
      result.toolCalls = calls;

      // Show the trace before the work starts, not after it finishes: a user
      // watching "searching: X, Y, Z" waits very differently from one watching
      // a blank screen.
      for (const call of result.toolCalls) {
        const e = describeCall(call.name, call.input);
        if (e) yield { type: 'tool', tool: e };
      }

      // Tool calls in one assistant message are independent by construction, so
      // run them together. A search and a memory lookup should not queue.
      const results = await Promise.all(
        result.toolCalls.map(async (call) => {
          let out: string;
          try {
            out = await runTool(call.name, call.input, ctx);
          } catch (err) {
            out = `Tool failed: ${(err as Error).message}. Tell the user what you could not check rather than guessing.`;
          }
          return { id: call.id, name: call.name, content: out.slice(0, 60_000) };
        }),
      );

      if (calls.some((c) => c.name === 'verify_claims')) budget = Math.min(budget, round + 2);

      // Page reads and claim matches are only known once the tool has run.
      while (pending.length) {
        const e = pending.shift()!;
        if (e.kind === 'read' || e.kind === 'verify') yield { type: 'tool', tool: e };
      }

      messages.push({ role: 'tool', results });
    }

    // Belt and braces: a turn must never end silently.
    if (!answer.trim()) {
      answer = 'I ran out of room to finish checking that. Ask me again and I will pick up where I left off.';
      yield { type: 'text', delta: answer };
    }

    const cited = sources.cited(answer);
    if (cited.length) yield { type: 'sources', sources: cited };

    // 3. Persist, then enrich in the background. The user already has their
    //    answer; indexing it must not make them wait.
    const turn = store.addTurn({
      sessionId,
      ts: new Date(now).toISOString(),
      user: message,
      assistant: answer,
      sources: cited.length ? cited : sources.all(),
    });
    void enrichTurn(turn);

    yield { type: 'done', turnId: turn.id, ms: Date.now() - started };
  } catch (err) {
    yield { type: 'error', message: (err as Error).message };
  }
}
