import { config } from '../config.js';

/**
 * A neutral chat/tool interface with two adapters behind it.
 *
 * The agent loop is the interesting part of this codebase and it should not be
 * written in any vendor's message dialect. Everything above this file speaks
 * the types below; the adapters translate. That is what lets the same agent run
 * on Claude, on a free Groq key, or on anything else OpenAI-compatible without
 * touching the orchestration, the memory layer or the tools.
 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export type NMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: { id: string; name: string; content: string }[] };

export interface StreamRequest {
  /** Block 0 is the stable, cacheable half of the prompt. */
  system: string[];
  messages: NMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  model?: string;
}

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface LLM {
  readonly name: string;
  readonly model: string;
  /** Yields text deltas; returns the full turn including any tool calls. */
  stream(req: StreamRequest): AsyncGenerator<string, TurnResult>;
  /** One forced tool call, used for structured extraction. */
  json<T>(opts: { system: string; user: string; tool: ToolDef; maxTokens?: number; model?: string }): Promise<T | null>;
}

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                   */
/* -------------------------------------------------------------------------- */

class AnthropicLLM implements LLM {
  readonly name = 'anthropic';
  constructor(readonly model: string, private key: string) {}

  private body(req: StreamRequest, stream: boolean) {
    return {
      model: req.model ?? this.model,
      max_tokens: req.maxTokens ?? 2048,
      stream,
      system: req.system.map((text, i) => ({
        type: 'text',
        text,
        ...(i === 0 ? { cache_control: { type: 'ephemeral' } } : {}),
      })),
      messages: req.messages.map(toAnthropic),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t, i) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
              ...(i === req.tools!.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
            })),
          }
        : {}),
    };
  }

  private headers() {
    return {
      'content-type': 'application/json',
      'x-api-key': this.key,
      'anthropic-version': '2023-06-01',
    };
  }

  async *stream(req: StreamRequest): AsyncGenerator<string, TurnResult> {
    const res = await httpRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(req, true)),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);

    let text = '';
    const blocks = new Map<number, { type: string; name?: string; id?: string; json: string }>();

    for await (const evt of sseJson(res)) {
      switch (evt.type) {
        case 'content_block_start':
          blocks.set(evt.index, {
            type: evt.content_block.type,
            name: evt.content_block.name,
            id: evt.content_block.id,
            json: '',
          });
          break;
        case 'content_block_delta': {
          const b = blocks.get(evt.index);
          if (evt.delta.type === 'text_delta') {
            text += evt.delta.text;
            yield evt.delta.text;
          } else if (evt.delta.type === 'input_json_delta' && b) {
            b.json += evt.delta.partial_json;
          }
          break;
        }
        case 'error':
          throw new Error(`Anthropic stream error: ${JSON.stringify(evt.error).slice(0, 300)}`);
      }
    }

    const toolCalls: ToolCall[] = [...blocks.values()]
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id!, name: b.name!, input: safeParse(b.json) }));

    return { text, toolCalls };
  }

  async json<T>(opts: { system: string; user: string; tool: ToolDef; maxTokens?: number; model?: string }): Promise<T | null> {
    const res = await httpRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.model ?? config.fastModel,
        max_tokens: opts.maxTokens ?? 1500,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
        tools: [{ name: opts.tool.name, description: opts.tool.description, input_schema: opts.tool.parameters }],
        tool_choice: { type: 'tool', name: opts.tool.name },
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const block = (data.content ?? []).find((c: any) => c.type === 'tool_use');
    return block ? (block.input as T) : null;
  }
}

function toAnthropic(m: NMessage): any {
  if (m.role === 'user') return { role: 'user', content: m.content };
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
    };
  }
  const content: any[] = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
  return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '...' }] };
}

/* -------------------------------------------------------------------------- */
/* OpenAI-compatible: OpenAI, Groq, OpenRouter, Together, local servers         */
/* -------------------------------------------------------------------------- */

class OpenAICompatLLM implements LLM {
  constructor(readonly name: string, readonly model: string, private key: string, private baseUrl: string) {}

  private headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.key}` };
  }

  async *stream(req: StreamRequest): AsyncGenerator<string, TurnResult> {
    const res = await httpRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model ?? this.model,
        max_tokens: req.maxTokens ?? 2048,
        stream: true,
        // Reasoning models bill their private thinking against the same output
        // budget, so a long deliberation can consume the whole allowance and
        // return an empty message. Observed with gpt-oss on Groq: ninety
        // seconds of tool calls followed by a blank reply. This agent does its
        // thinking by fetching evidence, not by ruminating, so keep it brief.
        ...(/gpt-oss|qwen3|reasoning/i.test(req.model ?? this.model) ? { reasoning_effort: 'low' } : {}),
        messages: [{ role: 'system', content: req.system.join('\n\n') }, ...req.messages.flatMap(toOpenAI)],
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: 'auto',
            }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 400)}`);

    let text = '';
    // Tool calls arrive as deltas addressed by index, with the name on the
    // first fragment and the arguments dribbled in as string pieces.
    const acc = new Map<number, { id: string; name: string; args: string }>();

    for await (const evt of sseJson(res)) {
      const delta = evt.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        yield delta.content;
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = acc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        acc.set(tc.index, slot);
      }
    }

    const toolCalls: ToolCall[] = [...acc.values()]
      .filter((t) => t.name)
      .map((t, i) => ({ id: t.id || `call_${i}`, name: t.name, input: safeParse(t.args) }));

    return { text, toolCalls };
  }

  async json<T>(opts: { system: string; user: string; tool: ToolDef; maxTokens?: number; model?: string }): Promise<T | null> {
    const res = await httpRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.model ?? config.fastModel,
        max_tokens: opts.maxTokens ?? 1500,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        tools: [{ type: 'function', function: { name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.parameters } }],
        tool_choice: { type: 'function', function: { name: opts.tool.name } },
      }),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    return call ? (safeParse(call.function.arguments) as T) : null;
  }
}

function toOpenAI(m: NMessage): any[] {
  if (m.role === 'user') return [{ role: 'user', content: m.content }];
  if (m.role === 'tool') {
    return m.results.map((r) => ({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.content }));
  }
  return [
    {
      role: 'assistant',
      content: m.content || null,
      ...(m.toolCalls?.length
        ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
            })),
          }
        : {}),
    },
  ];
}

/* -------------------------------------------------------------------------- */

/**
 * Retries on rate limits and transient server errors. Free tiers are generous
 * about volume and strict about bursts, and this agent bursts by design: the
 * claim verifier fires ten checks at once. Providers tell you exactly how long
 * to wait, so honour that rather than guessing.
 */
async function httpRetry(url: string, init: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(url, init);
  if (res.ok || attempt >= 3) return res;
  if (res.status !== 429 && res.status < 500) return res;

  const body = await res.clone().text();
  const retryAfter = Number(res.headers.get('retry-after'));
  const hinted = /try again in ([\d.]+)s/i.exec(body);
  const waitMs = retryAfter
    ? retryAfter * 1000
    : hinted
      ? Math.ceil(parseFloat(hinted[1]) * 1000) + 500
      : 1000 * 2 ** attempt;

  await new Promise((r) => setTimeout(r, Math.min(waitMs, 30_000)));
  return httpRetry(url, init, attempt + 1);
}

/** Parses `data:` lines off an SSE response. Both APIs stream this way. */
async function* sseJson(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          /* keepalive or partial frame */
        }
      }
    }
  }
}

function safeParse(s: string): any {
  if (!s || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

let cached: LLM | null = null;

export function llm(): LLM {
  if (cached) return cached;
  const p = config.llm;
  if (!p) throw new Error('No model provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY (or OPENAI_API_KEY / OPENROUTER_API_KEY) in .env.');
  cached = p.kind === 'anthropic'
    ? new AnthropicLLM(config.model, p.key)
    : new OpenAICompatLLM(p.name, config.model, p.key, p.baseUrl);
  return cached;
}
