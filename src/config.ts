import 'dotenv/config';
import path from 'node:path';

function pick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export type SearchProviderName = 'tavily' | 'brave' | 'exa' | 'serper';

export interface LlmTarget {
  kind: 'anthropic' | 'openai-compatible';
  name: string;
  key: string;
  baseUrl: string;
  /** Defaults chosen per provider: a capable tool-using model and a cheap one. */
  model: string;
  fastModel: string;
}

/**
 * Provider detection. Any OpenAI-compatible endpoint works, which is why a free
 * Groq key is enough to run the whole thing.
 */
function detectLlm(): LlmTarget | undefined {
  const forced = pick('LLM_PROVIDER')?.toLowerCase();

  const candidates: LlmTarget[] = [
    {
      kind: 'anthropic', name: 'anthropic', key: pick('ANTHROPIC_API_KEY') ?? '',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-5-5', fastModel: 'claude-haiku-5-5',
    },
    {
      kind: 'openai-compatible', name: 'groq', key: pick('GROQ_API_KEY') ?? '',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b', fastModel: 'openai/gpt-oss-20b',
    },
    {
      kind: 'openai-compatible', name: 'openai', key: pick('OPENAI_API_KEY') ?? '',
      baseUrl: pick('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      model: 'gpt-4.1', fastModel: 'gpt-4.1-mini',
    },
    {
      kind: 'openai-compatible', name: 'openrouter', key: pick('OPENROUTER_API_KEY') ?? '',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.5', fastModel: 'google/gemini-2.5-flash',
    },
  ];

  const chosen = forced
    ? candidates.find((c) => c.name === forced && c.key)
    : candidates.find((c) => c.key);
  return chosen;
}

const llmTarget = detectLlm();

export const config = {
  port: Number(pick('PORT') ?? 3000),

  llm: llmTarget,
  /** Main conversational model. Latency matters as much as raw capability here. */
  model: pick('MODEL') ?? llmTarget?.model ?? 'claude-sonnet-5-5',
  /** Memory enrichment and the parallel per-claim verifier. Must be cheap and fast. */
  fastModel: pick('FAST_MODEL') ?? llmTarget?.fastModel ?? 'claude-haiku-5-5',

  searchProvider: detectSearch(),
  searchKeys: {
    tavily: pick('TAVILY_API_KEY'),
    brave: pick('BRAVE_API_KEY'),
    exa: pick('EXA_API_KEY'),
    serper: pick('SERPER_API_KEY'),
  },

  /**
   * How much retrieved text is allowed into the model's context.
   *
   * This is a real quality/latency/cost dial, not a safety margin. More page
   * text means better grounding on a pricing table and a slower, pricier turn —
   * and on a free tier with an 8k tokens-per-minute ceiling, a 36k-character
   * dump of four pages simply fails. Free tiers get the tighter budget by
   * default; override either number if your key is not rate limited.
   */
  context: {
    pageChars: Number(pick('MAX_PAGE_CHARS') ?? (isFreeTier(llmTarget) ? 3500 : 8000)),
    searchResults: Number(pick('MAX_SEARCH_RESULTS') ?? (isFreeTier(llmTarget) ? 8 : 12)),
    snippetChars: isFreeTier(llmTarget) ? 260 : 450,
  },

  timezone: pick('TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  dataDir: path.resolve(process.cwd(), pick('DATA_DIR') ?? './data'),

  /** Generic UA. Never send the operator's identity to third-party sites. */
  userAgent: 'RecallAgent/1.0 (+https://github.com/Pulkit7070/recall-agent)',
} as const;

/** Groq's free tier caps tokens per minute hard enough to change the design. */
function isFreeTier(t: LlmTarget | undefined): boolean {
  return t?.name === 'groq';
}

function detectSearch(): SearchProviderName | undefined {
  const forced = pick('SEARCH_PROVIDER')?.toLowerCase() as SearchProviderName | undefined;
  if (forced) return forced;
  if (pick('TAVILY_API_KEY')) return 'tavily';
  if (pick('BRAVE_API_KEY')) return 'brave';
  if (pick('EXA_API_KEY')) return 'exa';
  if (pick('SERPER_API_KEY')) return 'serper';
  return undefined;
}

export function assertConfig(): string[] {
  const problems: string[] = [];
  if (!config.llm) {
    problems.push('No model provider key. Set GROQ_API_KEY (free) or ANTHROPIC_API_KEY in .env — see .env.example.');
  }
  if (!config.searchProvider) {
    problems.push('No web search key. Set TAVILY_API_KEY (free) or BRAVE_API_KEY / EXA_API_KEY / SERPER_API_KEY in .env.');
  } else if (!config.searchKeys[config.searchProvider]) {
    problems.push(`SEARCH_PROVIDER=${config.searchProvider} but its API key is missing.`);
  }
  return problems;
}
