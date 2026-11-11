import { config } from '../config.js';

export interface Page {
  url: string;
  title: string;
  text: string;
  ok: boolean;
  error?: string;
}

const MAX_CHARS = config.context.pageChars;

/**
 * Search snippets are the single biggest source of wrong pricing answers: they
 * are cached, truncated, and often quote a plan the user did not ask about. For
 * anything numeric the agent is told to open the page, so this needs to be good
 * enough to survive a real marketing site without pulling in a DOM parser.
 */
export async function fetchPage(url: string): Promise<Page> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': config.userAgent,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'accept-language': 'en',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { url, title: url, text: '', ok: false, error: `HTTP ${res.status}` };

    const type = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    if (type.includes('json')) {
      return { url, title: url, text: raw.slice(0, MAX_CHARS), ok: true };
    }
    if (!type.includes('html') && !type.includes('text')) {
      return { url, title: url, text: '', ok: false, error: `unsupported content-type ${type}` };
    }
    return { url, ...extract(raw), ok: true };
  } catch (err) {
    return { url, title: url, text: '', ok: false, error: (err as Error).message };
  }
}

export function extract(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';

  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|canvas)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ');

  // Pricing lives in tables and cards; keep row/cell boundaries so "$25 / user /
  // month" does not collapse into the next plan's number.
  body = body
    .replace(/<\/(tr|p|div|li|h[1-6]|section|article)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ');

  const lines = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l.length > 0 && arr.indexOf(l) === i);

  return { title: decodeEntities(title), text: budget(lines, MAX_CHARS) };
}

/** Lines that look like they carry the number the agent came for. */
const PRICEY = /([$£€₹]\s?\d|\d+\s*(usd|eur|gbp)\b|\bper\s+(seat|user|month|member)\b|\/\s*(mo|month|user|seat)\b|\bfree\b|\bv?\d+\.\d+(\.\d+)?\b)/i;

/**
 * Truncation is not neutral. Pricing pages open with navigation, a hero and a
 * testimonial, and put the actual numbers two thirds of the way down, so a
 * plain `.slice(0, limit)` reliably keeps the marketing and drops the price —
 * which is exactly how a verification comes back "unverifiable" on a page that
 * plainly states the answer. Observed on neon.com/pricing.
 *
 * So when the text does not fit, keep the opening for context and then spend
 * the remaining budget on the lines that look like they carry numbers, in
 * document order.
 */
function budget(lines: string[], limit: number): string {
  const whole = lines.join('\n');
  if (whole.length <= limit) return whole;

  const head: string[] = [];
  let used = 0;
  let i = 0;
  const headBudget = Math.floor(limit * 0.35);
  for (; i < lines.length && used + lines[i].length + 1 <= headBudget; i++) {
    head.push(lines[i]);
    used += lines[i].length + 1;
  }

  const kept: string[] = [];
  for (let j = i; j < lines.length && used < limit; j++) {
    if (!PRICEY.test(lines[j])) continue;
    if (used + lines[j].length + 1 > limit) break;
    kept.push(lines[j]);
    used += lines[j].length + 1;
  }

  return kept.length ? `${head.join('\n')}\n[…]\n${kept.join('\n')}` : whole.slice(0, limit);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, ' ');
}
