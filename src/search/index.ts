import type { Source } from '../memory/types.js';
import { activeProvider, type Freshness, type SearchHit } from './providers.js';

/**
 * Every source the model is shown during one turn gets a stable number. The
 * model cites [3]; the UI resolves [3] to a link; the claim extractor resolves
 * [3] to the URL it should re-check later. One registry keeps those three
 * consistent, which is what makes citations survive into memory.
 */
export class SourceRegistry {
  private byUrl = new Map<string, Source>();

  add(hit: { url: string; title: string; publishedAt?: string }): Source {
    const key = normaliseUrl(hit.url);
    const existing = this.byUrl.get(key);
    if (existing) return existing;
    const src: Source = {
      n: this.byUrl.size + 1,
      url: hit.url,
      title: hit.title || hit.url,
      publishedAt: hit.publishedAt,
    };
    this.byUrl.set(key, src);
    return src;
  }

  all(): Source[] {
    return [...this.byUrl.values()].sort((a, b) => a.n - b.n);
  }

  /** Only the sources the answer actually cited, renumbered for display. */
  cited(answer: string): Source[] {
    const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return this.all().filter((s) => used.has(s.n));
  }
}

export function normaliseUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const p of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|fbclid|gclid|mc_)/i.test(p)) url.searchParams.delete(p);
    }
    return `${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`;
  } catch {
    return u;
  }
}

/**
 * Fan out several queries at once. One query answers one question; a comparison
 * ("have any of these five changed?") needs five, and running them serially is
 * the difference between a 3-second answer and a 15-second one.
 */
export async function multiSearch(
  queries: string[],
  opts: { freshness?: Freshness; perQuery?: number; rawContent?: boolean } = {},
): Promise<{ hits: SearchHit[]; errors: string[] }> {
  const provider = activeProvider();
  const freshness = opts.freshness ?? 'any';
  const perQuery = opts.perQuery ?? 5;

  const settled = await Promise.allSettled(
    queries.slice(0, 6).map((q) => provider.search(q, { limit: perQuery, freshness, rawContent: opts.rawContent })),
  );

  const errors: string[] = [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  // Interleave by rank so one broad query cannot crowd out the others.
  const lists = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    errors.push(`"${queries[i]}": ${(s.reason as Error).message}`);
    return [] as SearchHit[];
  });

  for (let rank = 0; rank < perQuery; rank++) {
    for (const list of lists) {
      const hit = list[rank];
      if (!hit) continue;
      const key = normaliseUrl(hit.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }

  return { hits, errors };
}
