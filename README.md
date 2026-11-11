# mymini

A chat agent with web search that **remembers what it told you and can go and check whether it is still true.**

```
you    Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?

       dates: last tuesday -> Tuesday 10 November 2026
       recalled 1 past exchange, 3 recorded facts
       re-checking: Neon Launch plan · Supabase Pro plan · Railway Hobby plan

agent  Neon's Launch plan is no longer a flat $19 per month — it's now usage-based
       at $0.106 per CU-hour (typical spend around $15/mo). Supabase's Pro plan
       remains $25 per month. Railway's Hobby plan price of $5 could not be
       confirmed on its site today, so the prior figure is unverified.
                                                                            8.4s
```

It does that because every time it gives you a fact that can expire — a price, a plan limit, a version — it writes that fact down as a row with its source and the date. The follow-up is then a diff against a known baseline, not a fresh guess.

`DESIGN.md` explains the architecture and the bugs that shaped it.

## Running it

```bash
npm install
cp .env.example .env     # add two keys, both have free tiers
npm run dev              # http://localhost:3000
```

You need **one model key** and **one search key**. Both are free and need no card:

| | Get a key | Put it in `.env` as |
|---|---|---|
| Model | [console.groq.com/keys](https://console.groq.com/keys) | `GROQ_API_KEY` |
| Search | [app.tavily.com](https://app.tavily.com) | `TAVILY_API_KEY` |

Anthropic, OpenAI, OpenRouter and any OpenAI-compatible endpoint work too, as do Brave, Exa and Serper for search. Set whichever key you have and it is detected automatically. Full list in `.env.example`.

### Other commands

```bash
npm run seed       # optional: two backdated conversations, so you can test
                   # the memory and re-check paths without waiting a week
npm run cli        # same agent in the terminal
npm run cli -- "your question"   # ask once and exit
npm run selftest   # 31 checks: date resolution, recall, page extraction
npm run typecheck
```

### Try this

Run `npm run seed`, then ask:

- *"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"*
- *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*
- *"What did I ask you on 3 November?"* — there is nothing there, and it will say so rather than inventing one.

The **Memory** button opens a panel showing exactly what the agent resolved, what it recalled and why, and every fact it is currently tracking.

The seeded history is clearly marked as demo data and its prices are a deliberate snapshot — watching the agent discover which of them have since changed is the point.

## Layout

```
src/
  agent/
    agent.ts       the turn loop: memory -> model -> tools -> stream -> index
    provider.ts    one neutral interface, two adapters (Anthropic, OpenAI-compatible)
    tools.ts       web_search (the one outward tool) · recall · verify_claims
    claims.ts      extracting facts from an answer, and re-checking them in parallel
    prompt.ts      the system prompt
  memory/
    store.ts       append-only JSONL event log
    temporal.ts    "last Tuesday" -> a real date, in your timezone, DST included
    retrieval.ts   BM25 + time windows + the claim ledger
  search/
    providers.ts   Tavily · Brave · Exa · Serper
    fetch.ts       page fetch and price-aware text extraction
  public/          the web UI
```

Memory lives in `./data/memory.jsonl`. Delete the folder to start fresh.

Runtime dependencies: `dotenv`. There is no model SDK and no agent framework.
