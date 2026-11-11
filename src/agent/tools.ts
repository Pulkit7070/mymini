import type { ToolDef } from './provider.js';
import { config } from '../config.js';
import { store } from '../memory/store.js';
import { searchMemory } from '../memory/retrieval.js';
import { civilOf, formatDay } from '../memory/temporal.js';
import type { Claim } from '../memory/types.js';
import { multiSearch, SourceRegistry } from '../search/index.js';
import { fetchPage } from '../search/fetch.js';
import { verifyClaims } from './claims.js';
import { pMap } from './llm.js';

export type ToolEvent =
  | { kind: 'search'; queries: string[] }
  | { kind: 'read'; urls: string[] }
  | { kind: 'recall'; query: string }
  | { kind: 'verify'; subjects: string[] };

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'web_search',
    description:
      'The live web: search it, and read pages from it. This is your only access to the outside world.\n' +
      '- `queries`: one to six searches. Always batch them — they run in parallel and cost the same wall-clock ' +
      'time as one, so a five-way comparison is one call, not five.\n' +
      '- `open`: URLs to read in full. Search snippets are frequently stale, truncated, or quoting a different ' +
      'plan than the one asked about, so for any price, limit, version or date, open the vendor\'s own page and ' +
      'read the number there before you state it.\n' +
      'You may pass both at once. Everything returned carries an [n] citation number you must reuse in your answer.',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'One to six independent search queries. Keep each one specific and keyword-shaped.',
        },
        open: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute URLs to fetch and read, at most 4. Use on primary sources before quoting a figure.',
        },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year', 'any'],
          description: 'Restrict searches to recently published pages. Use for news and "what changed" questions; use "any" for pricing and docs, which are rarely dated.',
        },
      },
    },
  },
  {
    name: 'recall',
    description:
      'Search your own memory of past conversations with this user, beyond what was already loaded into context. ' +
      'Use it when they refer to something you cannot see, or to widen a date window that came back empty. ' +
      'Dates are YYYY-MM-DD.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to match. Omit to list everything in the date range.' },
        from: { type: 'string', description: 'Start date, YYYY-MM-DD, inclusive.' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD, inclusive.' },
      },
    },
  },
  {
    name: 'verify_claims',
    description:
      'Re-check facts you previously told this user, against the live web, in parallel. This is the right tool for ' +
      '"has anything changed since X?", "is that still correct?", "any updates on those?". Give the subjects you ' +
      'want checked (matched against your claim ledger) or claim ids from the context block. Returns a per-fact ' +
      'verdict: unchanged, changed (with the new value), or unverifiable. Never answer a "has it changed" question ' +
      'from memory alone — the whole point is that memory might be stale.',
    parameters: {
      type: 'object',
      properties: {
        subjects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subjects to re-check, e.g. ["HubSpot", "Pipedrive", "Neon"]. Matched loosely against stored claims.',
        },
        claim_ids: { type: 'array', items: { type: 'string' }, description: 'Exact claim ids from the memory context block.' },
      },
    },
  },
];

export interface ToolContext {
  sources: SourceRegistry;
  onEvent: (e: ToolEvent) => void;
}

export async function runTool(name: string, input: any, ctx: ToolContext): Promise<string> {
  switch (name) {
    case 'web_search':
      return web(input, ctx);
    case 'recall':
      return recall(input, ctx);
    case 'verify_claims':
      return verify(input, ctx);
    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * The agent's single outward-facing tool. Searching and reading are two halves
 * of one act — a search result you cannot open is a rumour — so they are one
 * tool, and the model can do both in a single round when it already knows which
 * page it needs.
 */
async function web(
  input: { queries?: string[]; open?: string[]; freshness?: any },
  ctx: ToolContext,
): Promise<string> {
  const [searched, opened] = await Promise.all([
    input.queries?.length ? runSearch(input, ctx) : Promise.resolve(''),
    input.open?.length ? openPage({ urls: input.open }, ctx) : Promise.resolve(''),
  ]);
  const out = [searched, opened].filter(Boolean).join('\n\n=====\n\n');
  return out || 'Nothing requested: pass `queries`, `open`, or both.';
}

async function runSearch(input: { queries?: string[]; freshness?: any }, ctx: ToolContext): Promise<string> {
  const queries = (input.queries ?? []).filter(Boolean).slice(0, 6);
  if (!queries.length) return '';
  ctx.onEvent({ kind: 'search', queries });

  const { hits, errors } = await multiSearch(queries, { freshness: input.freshness ?? 'any', perQuery: 5 });
  if (!hits.length) {
    return `No results.${errors.length ? ` Provider errors: ${errors.join('; ')}` : ''}`;
  }

  const lines = hits.slice(0, config.context.searchResults).map((h) => {
    const src = ctx.sources.add(h);
    const when = h.publishedAt ? ` (published ${h.publishedAt})` : '';
    const body = (h.content ?? h.snippet ?? '').replace(/\s+/g, ' ').slice(0, config.context.snippetChars);
    return `[${src.n}] ${h.title}${when}\n${h.url}\n${body}`;
  });

  return `Results for ${queries.map((q) => `"${q}"`).join(', ')}:\n\n${lines.join('\n\n')}` +
    (errors.length ? `\n\n(Some queries failed: ${errors.join('; ')})` : '');
}

async function openPage(input: { urls: string[] }, ctx: ToolContext): Promise<string> {
  const urls = (input.urls ?? []).filter(Boolean).slice(0, 4);
  if (!urls.length) return '';
  ctx.onEvent({ kind: 'read', urls });

  const pages = await pMap(urls, 4, (u) => fetchPage(u));
  return pages
    .map((p) => {
      if (!p.ok) return `FAILED ${p.url}: ${p.error}. Do not cite this; say you could not reach it if it matters.`;
      const src = ctx.sources.add({ url: p.url, title: p.title });
      return `[${src.n}] ${p.title}\n${p.url}\n\n${p.text}`;
    })
    .join('\n\n=====\n\n');
}

async function recall(input: { query?: string; from?: string; to?: string }, ctx: ToolContext): Promise<string> {
  ctx.onEvent({ kind: 'recall', query: input.query ?? `${input.from ?? ''}..${input.to ?? ''}` });

  const fromMs = input.from ? Date.parse(`${input.from}T00:00:00`) : undefined;
  const toMs = input.to ? Date.parse(`${input.to}T23:59:59`) : undefined;
  const turns = searchMemory({ query: input.query, fromMs, toMs, limit: 8 });

  if (!turns.length) {
    return 'Nothing in memory matches that. Say so plainly rather than guessing what the user asked.';
  }

  return turns
    .map((t) => {
      const claims = store.claimsForTurns([t.id]);
      const claimText = claims.length
        ? `\n  recorded facts:\n${claims.map((c) => `    - [${c.id.slice(0, 8)}] ${c.subject} / ${c.attribute} = ${c.value}`).join('\n')}`
        : '';
      return `${formatDay(civilOf(Date.parse(t.ts)))} (${t.ts})\n  user: ${t.user.slice(0, 400)}\n  you: ${t.assistant.slice(0, 700)}${claimText}`;
    })
    .join('\n\n');
}

async function verify(input: { subjects?: string[]; claim_ids?: string[] }, ctx: ToolContext): Promise<string> {
  const all = store.allClaims();
  let targets: Claim[] = [];

  if (input.claim_ids?.length) {
    const wanted = new Set(input.claim_ids.map((s) => s.toLowerCase()));
    targets = all.filter((c) => wanted.has(c.id.toLowerCase()) || [...wanted].some((w) => c.id.startsWith(w)));
  }
  if (input.subjects?.length) {
    for (const s of input.subjects) {
      const needle = s.toLowerCase().trim();
      const matches = all.filter(
        (c) => c.subject.toLowerCase().includes(needle) || needle.includes(c.subject.toLowerCase().split(' ')[0]),
      );
      targets.push(...matches);
    }
  }

  const seen = new Set<string>();
  targets = targets.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  if (!targets.length) {
    return 'No stored claims match. Nothing was previously recorded about those subjects, so there is no baseline to ' +
      'diff against: use web_search to find and open the current pages and establish the facts now, and tell the user you had not recorded ' +
      'them before.';
  }

  // The ledger can hold several rows about one subject (a price and a limit,
  // or two phrasings written by different re-checks). The verifier collapses
  // them; the trace should show the user subjects, not rows.
  ctx.onEvent({ kind: 'verify', subjects: [...new Set(targets.map((c) => c.subject))] });
  const results = await verifyClaims(targets);

  return results
    .map((r) => {
      const when = formatDay(civilOf(Date.parse(r.claim.ts)));
      if (r.evidenceUrl) ctx.sources.add({ url: r.evidenceUrl, title: r.evidenceTitle ?? r.claim.subject });
      const cite = r.evidenceUrl ? ` [${ctx.sources.add({ url: r.evidenceUrl, title: r.claim.subject }).n}]` : '';
      switch (r.status) {
        case 'changed':
          return `CHANGED — ${r.claim.subject} / ${r.claim.attribute}: was "${r.claim.value}" (told to user ${when}), now "${r.currentValue}"${cite}.${r.note ? ` ${r.note}` : ''}`;
        case 'unchanged':
          return `UNCHANGED — ${r.claim.subject} / ${r.claim.attribute}: still "${r.claim.value}", confirmed today${cite}.`;
        default:
          return `UNVERIFIABLE — ${r.claim.subject} / ${r.claim.attribute}: was "${r.claim.value}" (${when}); could not confirm today.${r.note ? ` ${r.note}` : ''} Tell the user it is unconfirmed rather than implying it still holds.`;
      }
    })
    .join('\n');
}
