# Design

## The observation this is built on

Every example in the brief is the same question in different clothes:

- "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

None of these is a search query. Each one asks the agent to **remember what it told you, work out when, and go and check whether it is still true.** A chat loop with a search tool bolted on cannot answer them, because by the time the follow-up arrives the previous answer is a paragraph of prose with no structure left in it — the agent would have to re-read its own writing, guess what it had asserted, and search again from scratch.

So the design question is not "how do I call a search API well". It is **what does the agent have to write down today so that tomorrow's question is answerable.**

The answer is two things, and they are the architecture:

1. **A claim ledger.** When the agent states something that can expire — a price, a plan limit, a version, a release date — that statement is extracted into a row: subject, attribute, value, the URL it came from, the date it was said. Prose is lossy; rows are not.
2. **A deterministic clock.** "Last Tuesday" is resolved against a real calendar in the user's timezone before the model sees the message, never by the model itself.

Given those, "has anything changed since Monday?" stops being a vague re-search and becomes **a diff against a known baseline**, reported per item.

## How a turn runs

```
message
  │
  ├─ 1. resolve time words ──────────── "last Tuesday" → Tue 10 Nov 2026   (pure functions, ~0ms)
  │
  ├─ 2. assemble memory ────────────────┬─ this thread, in full
  │                                     ├─ turns inside the resolved date window
  │                                     ├─ BM25 hits across every past conversation
  │                                     └─ the claim rows attached to all of the above
  │
  ├─ 3. model loop (streaming, ≤4 rounds)
  │       tools: web_search · open_page · recall · verify_claims
  │
  ├─ 4. stream the answer, with [n] citations
  │
  └─ 5. after the user has their answer:
          one cheap model call writes the summary, the entities,
          and the new claim rows back into memory
```

Steps 1 and 2 are local and synchronous — no model, no network. Step 5 is deliberately *after* the response: indexing the conversation must never be something the user waits for.

### The four tools

`web_search` takes **an array of queries**, not one. A five-way comparison is five searches that should cost one search's wall-clock.

`open_page` exists because search snippets are the single biggest source of wrong pricing answers — cached, truncated, and often quoting a different plan. The agent is told never to state a number it has not seen on the page.

`recall` searches memory beyond what was preloaded, by keywords or by date range.

`verify_claims` is the one that matters. Given subjects, it pulls the matching rows from the ledger and checks each against the live web **in parallel, with a small cheap model**, returning `unchanged` / `changed (old → new)` / `unverifiable`. Ten facts cost roughly what one costs in wall-clock, and the main model never sees the raw pages — only the verdicts. That keeps the conversational turn fast and its context clean.

## Decisions, and what they cost

**Turns, not messages, as the unit of memory.** "What did I ask on 3 November" is a question about an exchange, and a claim belongs to an answer. Storing messages would mean reassembling pairs at every read.

**An append-only JSONL log, replayed into memory.** One user's history is thousands of rows; the whole corpus fits in RAM and every query is a scan of a few hundred objects. Appending means a crash mid-write cannot corrupt earlier turns, and the file is greppable, which matters enormously when debugging what the agent "remembers". This becomes Postgres the moment it is multi-user, and nothing above `store.ts` changes.

**BM25, not embeddings.** Users refer back with the *same proper nouns* they used before — "the CRM tools", "Postgres hosting". That is exactly where term matching is strong and semantic drift is a liability, and it costs no embedding call, no vector store, no index to keep warm. The honest limit: it will miss "that database thing you mentioned". Hybrid retrieval is the week-two fix.

**Dates resolved in code, not by the model.** Models are bad at date arithmetic and do not know what day it is. `temporal.ts` is pure functions over an injected `now`, which is why its DST edge cases are testable without touching the system clock. Where English is genuinely ambiguous — "last Tuesday" on a Thursday means the 10th or the 3rd — it carries **both** readings, retrieves from both windows, and lets the answer say so, rather than silently picking one.

**No SDK.** Two adapters behind one neutral interface (`provider.ts`): Anthropic, and anything OpenAI-compatible. The agent loop is the interesting part of this codebase and should not be written in a vendor's message dialect. The payoff is real: this runs on a free Groq key, on Claude, on OpenAI, or on a local model, without touching the orchestration, the memory layer or the tools. Runtime dependencies: `dotenv`. That is the whole list.

## Things that went wrong, and what they changed

These are the bugs that moved the architecture, not a changelog.

**The agent read its own shrug and shrugged again.** It answered "I have no record of a prior discussion on Postgres hosting", and that turn was stored like any other. When the user asked again, the stored turn contained their question *verbatim*, so it out-scored the real sourced answer from two days earlier on every term. No amount of down-weighting fixes that — an exact echo of the query always wins on term overlap. The rule is now categorical: lexical recall searches for *information*, and a turn that established none is excluded from it. It stays in the log and is still reachable by date, because as an event it did happen.

**Ninety seconds of work, then a blank reply.** The model kept calling tools until the round budget ran out, and the loop exited with nothing to say. Now the final round is run with the tools withheld, which forces an answer. Separately, the round ceiling *tightens once `verify_claims` has reported* — one round is left for whatever the ledger had nothing stored for, then it must answer. Asking the model nicely in the prompt did not work; making it structural took the same question from 76s to 20s.

**Truncation is not neutral.** Pricing pages open with navigation and a hero and put the numbers two thirds down, so `slice(0, limit)` reliably keeps the marketing and drops the price — which is how a verification comes back "unverifiable" on a page that plainly states the answer. Extraction now spends its budget on the lines that look like they carry numbers.

**Every pricing page looked like a price rise.** SaaS pages show billed-monthly and billed-annually side by side, so a recorded $99 sitting next to $109 reads as a change when both are current. The verifier is now told that a plan has two prices and to name which one it matched.

**The ledger filed "I have no record" as a fact to re-check.** A claim with no source URL cannot be re-verified by construction, so it is no longer stored.

## What I considered and rejected

**Letting the model manage memory with a `save_memory` tool.** Models under-save, and nothing would have been written down the day it mattered. Extraction is automatic and runs on every turn.

**Summarising old conversations into a rolling profile.** Compression destroys exactly what this agent needs: the specific number, the specific URL, the specific date.

**A vector database.** A real dependency and an index to maintain, to beat BM25 on a corpus that fits in memory, for a recall pattern dominated by proper nouns.

**Doing verification inside the main model's context.** It would double the latency of every follow-up and fill the window with raw HTML. Fanning out to a cheap model and returning only verdicts is the whole reason a ten-fact re-check takes seconds.

**An agent framework.** The orchestration here is one loop with four tools. A framework would have added a dependency, a dialect, and a layer to debug through.

## Known limits

- **Some pricing pages cannot be read.** HubSpot returns a client-rendered shell; Pipedrive answers 403 to non-browsers. The agent falls back to the search provider's crawled copy, and when that fails it says "unconfirmed" rather than guessing. A headless browser would close most of this gap.
- **Verdict quality tracks the checker model.** On Groq's free tier the small checker is inconsistent run to run on the same page. The architecture is unchanged on a stronger model; this is a knob, not a redesign.
- **Latency is dominated by the free tier.** Groq's free tier caps tokens per minute hard enough that the agent backs off mid-turn. Measured: 1.3s with no search, 8.4s for a three-fact re-check, ~20s for a five-tool comparison.
- **Single user.** No auth, no per-user partitioning. Memory is one person's.
- **Enrichment is best-effort.** If the background call fails the turn is still stored, just without a summary or claims.

## With another week

1. **A headless browser for the pages that refuse a plain fetch.** This is the biggest single accuracy win available, and I know exactly which pages need it.
2. **Proactive re-checking.** The ledger already has every fact and its source. A nightly job could re-verify anything stale and open the next conversation with "two things you were told last week have changed" — the agent noticing before you ask.
3. **Hybrid retrieval.** Add embeddings alongside BM25 for the "that database thing you mentioned" case, with the lexical score still dominant on proper nouns.
4. **An eval set.** The three example questions plus the failures above, run against a frozen memory fixture, scored on whether each claim got the right verdict. Right now the regression surface is covered by 31 deterministic checks (`npm run selftest`) and manual runs; the model-dependent half is not.
5. **Postgres and real multi-tenancy**, swapping `store.ts` only.
