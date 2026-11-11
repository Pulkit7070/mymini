import { config, type SearchProviderName } from '../config.js';

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string;
  /** Some providers return extracted page text; free content beats a second fetch. */
  content?: string;
}

export type Freshness = 'day' | 'week' | 'month' | 'year' | 'any';

export interface SearchOpts {
  limit: number;
  freshness: Freshness;
  /**
   * Ask the provider for the page text it already has.
   *
   * Half of the pricing pages worth checking cannot be fetched directly: they
   * are client-rendered (HubSpot returns an empty shell) or they refuse
   * non-browser clients outright (Pipedrive answers 403). Search providers
   * crawl them anyway, so their cached text is the difference between a real
   * verdict and an "unverifiable". Costs more per call, so it is opt-in and
   * only the claim verifier asks for it.
   */
  rawContent?: boolean;
}

export interface SearchProvider {
  name: SearchProviderName;
  search(query: string, opts: SearchOpts): Promise<SearchHit[]>;
}

const TIMEOUT_MS = 12_000;

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

async function get(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

const tavily: SearchProvider = {
  name: 'tavily',
  async search(query, { limit, freshness, rawContent }) {
    const days = { day: 1, week: 7, month: 31, year: 365, any: undefined }[freshness];
    const json = await post('https://api.tavily.com/search', {
      query,
      max_results: limit,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: rawContent ?? false,
      ...(days ? { days, topic: 'news' } : {}),
    }, { authorization: `Bearer ${config.searchKeys.tavily}` });
    return (json.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title,
      snippet: (r.content ?? '').slice(0, 600),
      publishedAt: r.published_date,
      content: typeof r.raw_content === 'string' ? r.raw_content.slice(0, 4000) : undefined,
    }));
  },
};

const brave: SearchProvider = {
  name: 'brave',
  async search(query, { limit, freshness }) {
    const f = { day: 'pd', week: 'pw', month: 'pm', year: 'py', any: '' }[freshness];
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    if (f) url.searchParams.set('freshness', f);
    const json = await get(url.toString(), {
      accept: 'application/json',
      'x-subscription-token': config.searchKeys.brave ?? '',
    });
    return (json.web?.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title,
      snippet: stripTags(r.description ?? ''),
      publishedAt: r.page_age ?? r.age,
    }));
  },
};

const exa: SearchProvider = {
  name: 'exa',
  async search(query, { limit, freshness }) {
    const days = { day: 1, week: 7, month: 31, year: 365, any: undefined }[freshness];
    const json = await post('https://api.exa.ai/search', {
      query,
      numResults: limit,
      type: 'auto',
      contents: { text: { maxCharacters: 2000 } },
      ...(days ? { startPublishedDate: new Date(Date.now() - days * 864e5).toISOString() } : {}),
    }, { 'x-api-key': config.searchKeys.exa ?? '' });
    return (json.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: (r.text ?? '').slice(0, 600),
      publishedAt: r.publishedDate,
      content: r.text?.slice(0, 4000),
    }));
  },
};

const serper: SearchProvider = {
  name: 'serper',
  async search(query, { limit, freshness }) {
    const tbs = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y', any: '' }[freshness];
    const json = await post('https://google.serper.dev/search', {
      q: query, num: limit, ...(tbs ? { tbs } : {}),
    }, { 'x-api-key': config.searchKeys.serper ?? '' });
    return (json.organic ?? []).map((r: any) => ({
      url: r.link,
      title: r.title,
      snippet: r.snippet ?? '',
      publishedAt: r.date,
    }));
  },
};

const REGISTRY: Record<SearchProviderName, SearchProvider> = { tavily, brave, exa, serper };

export function activeProvider(): SearchProvider {
  const name = config.searchProvider;
  if (!name) throw new Error('No search provider configured. Set TAVILY_API_KEY (or BRAVE/EXA/SERPER) in .env.');
  return REGISTRY[name];
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
