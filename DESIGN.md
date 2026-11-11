# Design

## The observation

Every example question in the brief is the same question wearing different clothes:

> "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"
> "What did I ask you on 3 November? Is your answer still correct today?"

None is a search query. Each asks the agent to **remember what it said, work out when, and check whether it is still true.** Chat-plus-search cannot answer them: by the time the follow-up arrives, the previous answer is prose with no structure left to diff against.

So the design question is not *how do I call a search API well.* It is **what must the agent write down today so tomorrow's question is answerable.** Two things:

1. **A claim ledger.** Every statement that can expire — price, limit, version, release date — is extracted into a row: subject, attribute, value, source URL, date said. Prose is lossy; rows are not.
2. **A deterministic clock.** "Last Tuesday" is resolved against a real calendar in the user's timezone before the model sees the message.

"Has anything changed since Monday?" then becomes a **parallel diff against a known baseline**, reported per item: changed (old → new), confirmed unchanged today, or couldn't confirm. It never says "nothing changed" unless it checked.

## A turn

```
message
  ├─ 1. resolve time words ──── "last Tuesday" → Tue 10 Nov 2026     (pure functions, ~0ms)
  ├─ 2. assemble memory ─────── this thread · turns in that date window ·
  │                             BM25 hits across all history · their claim rows
  ├─ 3. model loop (streaming, ≤4 rounds)
  ├─ 4. stream answer with [n] citations
  └─ 5. after the user has their answer: one cheap call writes the
        summary, entities and new claim rows back into memory
```

Steps 1–2 are local and synchronous. Step 5 is deliberately *after* the response: indexing must never be something the user waits for.

**One tool reaches the outside world: `web_search`** (searching and opening pages are two halves of one act — a result you cannot open is a rumour). `recall` and `verify_claims` touch only the agent's own memory; `verify_claims` re-checks ledger rows **in parallel with a small cheap model**, so ten facts cost about what one costs in wall-clock, and the main model sees verdicts, never raw HTML.

## Decisions

**Turns, not messages, as the unit of memory** — "what did I ask on 3 November" is a question about an exchange, and a claim belongs to an answer.

**Append-only JSONL, replayed into RAM** — one user's history is thousands of rows, so every query is a scan of a few hundred objects. A crash mid-write cannot corrupt earlier turns, and the file is greppable, which matters when debugging what the agent "remembers". Becomes Postgres when multi-user; nothing above `store.ts` changes.

**BM25, not embeddings** — users refer back with the *same proper nouns* ("the CRM tools", "Postgres hosting"), exactly where term matching is strong and semantic drift is a liability. Honest limit: it misses "that database thing you mentioned".

**Dates in code, not the model** — models are bad at date arithmetic and don't know the day. Where English is ambiguous ("last Tuesday" on a Thursday) it carries **both** readings and says so rather than silently picking one.

**No SDK** — two adapters behind one neutral interface, so the same agent runs on Claude, a free Groq key, or any OpenAI-compatible endpoint. Runtime dependencies: `dotenv`.

## Four bugs that moved the architecture

**It read its own shrug and shrugged again.** It answered "I have no record of that"; stored, that turn quoted the user's question verbatim, so next time it out-scored the real sourced answer on every term. No weighting fixes an exact echo. Lexical recall now excludes turns that established nothing — still reachable by date, since as an event it happened.

**Ninety seconds of tool calls, then a blank reply.** The round budget ran out mid-loop. The final round now runs with tools withheld, forcing an answer. Separately the ceiling *tightens once `verify_claims` reports*: asking the model in the prompt not to redo settled work didn't work; making it structural took the same question from 76s to 20s.

**Truncation is not neutral.** Pricing pages put numbers two thirds down, so `slice(0, limit)` keeps the marketing and drops the price — an "unverifiable" on a page that states the answer. Extraction now spends its budget on lines carrying numbers.

**Every pricing page looked like a price rise**, because SaaS shows monthly and annual side by side.

## Rejected

Letting the model save memories (models under-save, and nothing gets written the day it matters) · summarising old conversations into a profile (compression destroys the specific number, URL and date this needs) · a vector DB (a dependency and an index, to beat BM25 on a corpus that fits in RAM) · verifying inside the main context (doubles follow-up latency, fills the window with HTML) · an agent framework (this is one loop and three tools).

## Limits, and the next week

Some pricing pages can't be read: HubSpot serves a client-rendered shell, Pipedrive 403s non-browsers. It falls back to the provider's crawled copy, then says "unconfirmed" rather than guessing — **a headless browser is the biggest single accuracy win available.** Verdict quality tracks the checker model; on a free tier the small one is inconsistent run to run. Latency is dominated by that free tier's token-per-minute cap (measured: 1.3s no search, 4–9s for a three-fact re-check, ~20s for a five-tool comparison). Single user, no auth. Enrichment is best-effort.

Then: **proactive re-checking** — the ledger already holds every fact and its source, so a nightly job could open the next conversation with "two things you were told last week have changed." Plus hybrid retrieval, Postgres, and an eval set over the example questions against a frozen memory fixture, scoring each claim's verdict. The deterministic half has 31 checks (`npm run selftest`); the model-dependent half has none.
