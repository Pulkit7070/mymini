import { config } from '../config.js';
import { store } from '../memory/store.js';
import type { Claim, Source, Turn, VerificationResult } from '../memory/types.js';
import { multiSearch } from '../search/index.js';
import { fetchPage } from '../search/fetch.js';
import { extractJson, pMap } from './llm.js';

/* -------------------------------------------------------------------------- */
/* Enrichment: runs after the answer has been streamed, off the critical path.  */
/* -------------------------------------------------------------------------- */

const ENRICH_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One sentence, under 20 words, describing what the user asked and what they got. Written so it is useful months later.',
    },
    entities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Proper nouns central to the exchange: products, companies, technologies. Max 10.',
    },
    claims: {
      type: 'array',
      description:
        'Statements in the ANSWER that are true today but could stop being true: prices, plan names and limits, version numbers, release dates, availability, rankings, headcounts. Skip anything timeless (definitions, explanations, code, opinions). Empty array is a perfectly good answer.',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'What the fact is about, specific enough to search for later, e.g. "HubSpot Sales Hub Professional".' },
          attribute: { type: 'string', description: 'Which property, e.g. "price per seat per month".' },
          value: { type: 'string', description: 'Exactly as stated in the answer, e.g. "$100".' },
          citation: { type: 'integer', description: 'The [n] citation number in the answer that supports this. Omit if uncited.' },
        },
        required: ['subject', 'attribute', 'value'],
      },
    },
  },
  required: ['summary', 'entities', 'claims'],
} as const;

interface Enrichment {
  summary: string;
  entities: string[];
  claims: { subject: string; attribute: string; value: string; citation?: number }[];
}

/**
 * The claim ledger is the whole point of the design. Without it, "has anything
 * changed since Monday?" makes the agent re-read its own prose and guess what it
 * had asserted. With it, there is a row saying "HubSpot Professional, price per
 * seat per month, $100, from this URL, on this date" — so the follow-up becomes
 * a diff against a known baseline instead of a fresh, unanchored search.
 */
export async function enrichTurn(turn: Turn): Promise<void> {
  try {
    const sourceList = turn.sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join('\n') || '(no sources)';
    const data = await extractJson<Enrichment>({
      name: 'record_memory',
      schema: ENRICH_SCHEMA as unknown as Record<string, unknown>,
      system:
        'You index a chat assistant\'s memory. You are given one exchange and the sources its answer cited. ' +
        'Extract a durable summary, the entities involved, and any time-sensitive factual claims the ANSWER made. ' +
        'Only record a claim if the answer actually stated it, and only if it cites a source. ' +
        'Never invent values. Never record the absence of something as a claim: "no record found", ' +
        '"could not confirm", "nothing announced" and "I do not know" are not facts to re-check later. ' +
        'A claim is a concrete value you could look up again on a page: a price, a limit, a version, a date.',
      // Enough room that the JSON cannot be cut off mid-object: a truncated
      // tool call is rejected outright and the whole turn goes unindexed.
      maxTokens: 3000,
      user: `USER ASKED:\n${turn.user}\n\nASSISTANT ANSWERED:\n${turn.assistant.slice(0, 4000)}\n\nSOURCES:\n${sourceList}`,
    });
    if (!data) return;

    store.patchTurn(turn.id, {
      summary: data.summary,
      entities: (data.entities ?? []).slice(0, 10),
      enriched: true,
    });

    for (const c of data.claims ?? []) {
      const src: Source | undefined = turn.sources.find((s) => s.n === c.citation);

      // The ledger exists to be re-checked later, so a row that cannot be
      // re-checked does not belong in it. Without this the extractor cheerfully
      // files things like "conversation from 3 November / record of /
      // I have no record of any conversation with you" — the absence of a fact,
      // stored as a fact, which the verifier would then go and search the web
      // for. A claim with no source was never grounded to begin with.
      if (!src?.url) continue;
      if (c.value.length > 120) continue;

      // One row per fact. Restating a fact updates the row the user was
      // originally told, rather than filing a rival copy of it; the JSONL log
      // still holds every revision, so nothing is lost.
      const key = claimKey(c.subject, c.attribute);
      const existing = store.allClaims().find((e) => claimKey(e.subject, e.attribute) === key);
      if (existing) {
        store.patchClaim(existing.id, {
          value: c.value,
          ts: turn.ts,
          turnId: turn.id,
          sourceUrl: src.url,
          sourceTitle: src.title,
        });
        continue;
      }

      store.addClaim({
        turnId: turn.id,
        sessionId: turn.sessionId,
        ts: turn.ts,
        subject: c.subject,
        attribute: c.attribute,
        value: c.value,
        sourceUrl: src?.url,
        sourceTitle: src?.title,
      });
    }
  } catch (err) {
    // Enrichment is best-effort: a failure must never cost the user their turn.
    console.error('[enrich] failed:', (err as Error).message);
  }
}

/* -------------------------------------------------------------------------- */
/* Verification: the re-check path.                                            */
/* -------------------------------------------------------------------------- */

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['unchanged', 'changed', 'unverifiable'],
      description:
        'unchanged = the evidence states the same value. changed = the evidence states a different value. ' +
        'unverifiable = the evidence does not cover this fact at all. Guessing is worse than unverifiable.',
    },
    current_value: { type: 'string', description: 'The value the evidence states now. Omit if unverifiable.' },
    evidence_url: { type: 'string', description: 'Which of the supplied URLs supports your verdict.' },
    note: { type: 'string', description: 'At most one short sentence, only if something non-obvious changed (plan renamed, feature moved tier).' },
  },
  required: ['status'],
} as const;

/**
 * Checks claims in parallel with a cheap model. Each claim is an independent
 * question, so this is embarrassingly parallel: ten claims cost roughly what one
 * costs in wall-clock. The big model never sees the raw pages, only the verdicts,
 * which keeps the conversational turn fast and its context clean.
 */
export async function verifyClaims(claims: Claim[]): Promise<VerificationResult[]> {
  return pMap(dedupeClaims(claims).slice(0, 10), 5, async (claim) => {
    try {
      return await verifyOne(claim);
    } catch (err) {
      return markResult(claim, { status: 'unverifiable', note: (err as Error).message });
    }
  });
}

/**
 * Two passes, and the expensive one usually does not run.
 *
 * The claim already records where it came from, and that URL is almost always
 * the vendor's own pricing page — the best evidence there is. So the first pass
 * is a single fetch of that page. Only when it does not settle the question
 * (the page is gone, client-rendered, bot-blocked, or the plan has been renamed
 * out from under the claim) do we pay for the second pass: a search that asks
 * the provider for its crawled copy of the page, which reaches sites a plain
 * fetch cannot. Doing both for every claim measured three times slower for one
 * extra confirmation in five.
 */
async function verifyOne(claim: Claim): Promise<VerificationResult> {
  let primaryText = '';

  if (claim.sourceUrl) {
    const page = await fetchPage(claim.sourceUrl);
    if (page.ok && page.text.length >= 400) {
      primaryText = `SOURCE: ${page.url}\n${page.text}`;
      const verdict = await judge(claim, primaryText);
      if (verdict && verdict.status !== 'unverifiable') {
        return markResult(claim, {
          status: verdict.status,
          currentValue: verdict.current_value,
          evidenceUrl: verdict.evidence_url ?? page.url,
          note: verdict.note,
        });
      }
    }
  }

  const query = `${claim.subject} ${claim.attribute}`.replace(/\s+/g, ' ').trim();
  const { hits } = await multiSearch([query], { perQuery: 4, rawContent: true });
  if (!hits.length) {
    return markResult(claim, { status: 'unverifiable', note: 'Could not reach any source.' });
  }

  const searched = hits
    .slice(0, 4)
    .map((h) => {
      const text = h.content?.trim() || h.snippet;
      return `SOURCE: ${h.url}${h.publishedAt ? ` (${h.publishedAt})` : ''}\n${text.slice(0, 3000)}`;
    })
    .join('\n\n');

  // Keep the primary page in play. It was inconclusive on its own, but it is
  // still the authoritative source, and together with a crawled copy it often
  // resolves what neither settled alone.
  const verdict = await judge(claim, primaryText ? `${primaryText}\n\n---\n\n${searched}` : searched);
  if (!verdict) return markResult(claim, { status: 'unverifiable', note: 'Checker returned nothing.' });

  return markResult(claim, {
    status: verdict.status,
    currentValue: verdict.current_value,
    evidenceUrl: verdict.evidence_url ?? hits[0]?.url,
    note: verdict.note,
  });
}

interface Verdict {
  status: 'unchanged' | 'changed' | 'unverifiable';
  current_value?: string;
  evidence_url?: string;
  note?: string;
}

function judge(claim: Claim, evidence: string): Promise<Verdict | null> {
  return extractJson<Verdict>({
    name: 'verdict',
    schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
    model: config.fastModel,
    maxTokens: 500,
    system:
      'You check whether one previously recorded fact still holds. Compare the recorded value against the ' +
      'evidence only. If the evidence does not clearly state this exact fact, answer unverifiable. ' +
      'Do not use prior knowledge. Today is ' + new Date().toISOString().slice(0, 10) + '.\n\n' +
      // Without this, every SaaS pricing page reads as a price rise: they show
      // the annual-billing number large and the monthly one next to it, so a
      // recorded $99 sitting beside a $109 looks like a change when both are
      // current and the plan simply has two billing terms.
      'Pricing pages usually show two numbers for the same plan: billed monthly and billed annually. ' +
      'If the recorded value still appears as either of them, the fact is unchanged — say which billing ' +
      'term it corresponds to in the note, and mention the other number there too. Only answer "changed" ' +
      'when the recorded value appears nowhere on the page for that plan. Check you are reading the same ' +
      'plan tier the claim names, not a neighbouring one.',
    user:
      `RECORDED ON ${claim.ts.slice(0, 10)}:\n` +
      `subject: ${claim.subject}\nattribute: ${claim.attribute}\nvalue: ${claim.value}\n\n` +
      `EVIDENCE FETCHED TODAY:\n${evidence.slice(0, 12000)}`,
  });
}

/**
 * The same fact gets recorded more than once across conversations — the user
 * asks about Neon in March and again in July. Re-checking each copy is the same
 * network round trip repeated, so collapse to the most recent statement of each
 * fact; that is also the baseline the user actually remembers being told.
 */
function dedupeClaims(claims: Claim[]): Claim[] {
  const newest = new Map<string, Claim>();
  for (const c of claims) {
    const key = claimKey(c.subject, c.attribute);
    const prev = newest.get(key);
    if (!prev || prev.ts < c.ts) newest.set(key, c);
  }
  return [...newest.values()];
}

const ATTR_NOISE = new Set(['per', 'the', 'a', 'an', 'of', 'in', 'for', 'is', 'at', 'current', 'new', 'approximate', 'typical', 'listed']);

/** Words the extractor swaps freely for one another when restating a fact. */
const ATTR_SYNONYM: Record<string, string> = {
  cost: 'price', pricing: 'price', fee: 'price', charge: 'price', rate: 'price',
  monthly: 'month', yearly: 'year', annual: 'year', annually: 'year',
  seat: 'seat', user: 'seat', member: 'seat',
};

/**
 * Identity of a fact, independent of how the sentence that carried it was
 * phrased.
 *
 * The extractor is a language model, so the same fact comes back worded
 * differently every time it is restated: "price per month" on Monday,
 * "monthly price" after a re-check. Keyed on the raw attribute, those are two
 * rows, and the agent then holds two baselines for one fact — it told the user
 * $19 and separately recorded $15, and the next "has it changed?" can diff
 * against whichever it happens to retrieve. So attributes are reduced to a
 * sorted bag of crudely stemmed content words before comparison.
 */
export function claimKey(subject: string, attribute: string): string {
  const norm = attribute
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => ATTR_SYNONYM[w] ?? w.replace(/s$/, ''))
    .map((w) => ATTR_SYNONYM[w] ?? w)
    .filter((w) => w.length > 1 && !ATTR_NOISE.has(w))
    .sort()
    .join(' ');
  return `${subject.toLowerCase().trim()}|${norm}`;
}

function markResult(claim: Claim, r: Omit<VerificationResult, 'claim'>): VerificationResult {
  store.patchClaim(claim.id, {
    lastCheckedAt: new Date().toISOString(),
    lastCheckResult: r.status,
    ...(r.status === 'changed' && r.currentValue ? { value: r.currentValue } : {}),
  });
  return { claim, ...r };
}
