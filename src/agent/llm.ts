import { llm, type ToolDef } from './provider.js';

/**
 * Structured output via a single forced tool call. More reliable than asking
 * for JSON in prose, and the schema doubles as the documentation for what we
 * want. Works identically on both adapters.
 */
export async function extractJson<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  name: string;
  description?: string;
  model?: string;
  maxTokens?: number;
}): Promise<T | null> {
  const tool: ToolDef = {
    name: opts.name,
    description: opts.description ?? 'Return the structured result.',
    parameters: opts.schema,
  };
  return llm().json<T>({
    system: opts.system,
    user: opts.user,
    tool,
    model: opts.model,
    maxTokens: opts.maxTokens,
  });
}

/** Bounded-concurrency map. Keeps fan-out fast without hammering providers. */
export async function pMap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
