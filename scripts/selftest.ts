/**
 * Checks the deterministic half of the system: date resolution, memory
 * retrieval and HTML extraction. These are the parts where a bug produces a
 * confidently wrong answer rather than a visible error, and they are the parts
 * that can be tested without a network or an API key.
 *
 * Run: npm run selftest
 */

process.env.TIMEZONE = 'UTC';
process.env.DATA_DIR = './data/.selftest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-selftest-'));
process.env.DATA_DIR = tmp;

const { resolveTimeReferences, formatDay, civilOf } = await import('../src/memory/temporal.js');
const { extract } = await import('../src/search/fetch.js');
const { store } = await import('../src/memory/store.js');
const { buildMemoryContext } = await import('../src/memory/retrieval.js');

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`); }
}

function assert(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); }
}

/* ------------------------------- temporal ------------------------------- */

console.log('\ntemporal resolution (anchored to Thursday 12 November 2026, UTC)');

const NOW = Date.parse('2026-11-12T14:00:00Z'); // a Thursday
const label = (text: string) => resolveTimeReferences(text, NOW).map((r) => `${r.text}=${r.label}`);

check('today is Thursday 12 November 2026', formatDay(civilOf(NOW)), 'Thursday 12 November 2026');
check('"on Monday" resolves to the Monday just past', label('on Monday we shortlisted 5 CRM tools'), ['on monday=Monday 9 November 2026']);
check('"yesterday"', label('what did I ask yesterday'), ['yesterday=Wednesday 11 November 2026']);
check('"3 November" without a year', label('what did I ask you on 3 November?'), ['3 november=Tuesday 3 November 2026']);
check('"November 3rd" the other way round', label('November 3rd'), ['november 3rd=Tuesday 3 November 2026']);
check('a date later in the year falls back to last year', label('what about 30 December'), ['30 december=Tuesday 30 December 2025']);

const lastTue = resolveTimeReferences('last Tuesday I asked about Postgres hosting', NOW);
check('"last Tuesday" primary reading', lastTue.map((r) => r.label), ['Tuesday 10 November 2026']);
check('"last Tuesday" keeps the other reading', lastTue[0]?.alternate?.label, 'Tuesday 3 November 2026');

const week = resolveTimeReferences('last week', NOW)[0];
check('"last week" spans Mon-Sun of the previous week', [formatDay(civilOf(week.startMs)), formatDay(civilOf(week.endMs))],
  ['Monday 2 November 2026', 'Sunday 8 November 2026']);

const ago = resolveTimeReferences('three days ago', NOW)[0];
assert('"three days ago" lands on 9 November', formatDay(civilOf(ago.startMs)) === 'Monday 9 November 2026', formatDay(civilOf(ago.startMs)));

// DST: Europe/London leaves BST at 02:00 on 25 October 2026. At 00:30 UTC on
// the 26th it is already the 26th in London, and the 25th was 25 hours long.
// Naive UTC-midnight arithmetic gets both of these wrong.
const { dayWindow } = await import('../src/memory/temporal.js');
const dstNow = Date.parse('2026-10-26T00:30:00Z');
const londonToday = civilOf(dstNow, 'Europe/London');
assert('DST: today in Europe/London is 26 October', formatDay(londonToday) === 'Monday 26 October 2026', formatDay(londonToday));

const londonYesterday = { y: 2026, m: 10, d: 25 };
const w = dayWindow(londonYesterday, 'Europe/London');
assert(
  'DST: 25 October in London is a 25-hour day',
  Math.round((w.endMs - w.startMs + 1) / 3600_000) === 25,
  `${(w.endMs - w.startMs + 1) / 3600_000}h`,
);
assert(
  'DST: that day starts at 23:00 UTC on the 24th',
  new Date(w.startMs).toISOString() === '2026-10-24T23:00:00.000Z',
  new Date(w.startMs).toISOString(),
);

/* ------------------------------- retrieval ------------------------------ */

console.log('\nmemory retrieval');

store.init();
const past = store.addTurn({
  sessionId: 'old-session',
  ts: '2026-11-09T10:00:00Z',
  user: 'We need a CRM for a 20-person sales team. Shortlist 5 options with pricing.',
  assistant: 'HubSpot at $100/seat, Pipedrive at $49/seat...',
  sources: [{ n: 1, url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive pricing' }],
  summary: 'Shortlisted 5 CRMs with pricing for a 20-person sales team.',
  entities: ['HubSpot', 'Pipedrive'],
  enriched: true,
});
store.addClaim({
  turnId: past.id, sessionId: 'old-session', ts: past.ts,
  subject: 'Pipedrive Professional', attribute: 'price per seat per month', value: '$49',
  sourceUrl: 'https://www.pipedrive.com/en/pricing',
});
store.addTurn({
  sessionId: 'old-session-2', ts: '2026-11-10T15:00:00Z',
  user: 'Where should I host a small Postgres database?',
  assistant: 'Neon at $19/month on the Launch plan, Supabase Pro at $25/month.',
  sources: [{ n: 1, url: 'https://neon.com/pricing', title: 'Neon pricing' }],
  summary: 'Recommended Neon for small Postgres hosting.', entities: ['Neon', 'Postgres'], enriched: true,
});

const ctx = buildMemoryContext('On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?', 'new-session', NOW);
assert('date reference resolved', ctx.refs.some((r) => r.label === 'Monday 9 November 2026'));
assert('the Monday exchange is recalled by date', ctx.recalled.some((r) => r.turn.id === past.id && r.reason === 'time-match'));
assert('its recorded claims come with it', ctx.claims.some((c) => c.subject === 'Pipedrive Professional'));
assert('"since" window detected', ctx.sinceMs != null);

// The three question shapes the agent has to get right.
const { detectSinceAnchor } = await import('../src/memory/temporal.js');
assert('"has any of them changed pricing since?" asks for a re-check', detectSinceAnchor('Has any of them changed pricing or shipped something big since?'));
assert('"is your answer still correct today?" asks for a re-check', detectSinceAnchor('What did I ask you on 3 November? Is your answer still correct today?'));
assert('"has any pricing changed since then?" asks for a re-check', detectSinceAnchor('Has any pricing changed since then?'));
assert('a plain question does not', !detectSinceAnchor('What is the capital of France?'));
assert('"since 2019" is not a re-check', !detectSinceAnchor('How has Rust adoption grown since 2019 in embedded work?'));

const ctx2 = buildMemoryContext('what did you say about postgres hosting?', 'new-session', NOW);
assert('keyword recall finds an exchange with no date mentioned', ctx2.recalled.some((r) => r.turn.summary?.includes('Postgres')));

const ctx3 = buildMemoryContext('explain how TCP congestion control works', 'new-session', NOW);
assert('an unrelated question recalls nothing', ctx3.recalled.filter((r) => r.reason !== 'recent').length === 0);

// Regression: an "I have no record of that" turn quotes the user's own words
// back, so on their next attempt it matches every keyword they used — and it
// once out-ranked the grounded answer it was shadowing, making the agent read
// its own shrug and shrug again.
const { searchMemory } = await import('../src/memory/retrieval.js');
store.addTurn({
  sessionId: 'dead-end', ts: '2026-11-11T20:00:00Z',
  user: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
  assistant: 'I have no record of a prior discussion on Postgres hosting. Could you remind me which providers?',
  sources: [], summary: 'User asked about Postgres hosting pricing; assistant had no record.', enriched: true,
});
const q = 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';
const ranked = searchMemory({ query: q });
assert(
  'the grounded Postgres answer outranks the agent\'s own dead end',
  ranked[0]?.summary?.includes('Recommended Neon') === true,
  ranked.map((t) => t.summary).join(' || '),
);
assert(
  'the dead end is excluded from keyword recall entirely',
  !ranked.some((t) => t.sessionId === 'dead-end'),
  ranked.map((t) => t.sessionId).join(', '),
);
assert(
  'but it is still findable by date, because it did happen',
  searchMemory({ fromMs: Date.parse('2026-11-11T00:00:00Z'), toMs: Date.parse('2026-11-11T23:59:59Z') })
    .some((t) => t.sessionId === 'dead-end'),
);

/* -------------------------------- claims -------------------------------- */

console.log('\nclaim identity');

const { claimKey } = await import('../src/agent/claims.js');
const same = (a: string, b: string) => claimKey('Neon Launch plan', a) === claimKey('Neon Launch plan', b);

// The extractor rewords the same fact every time it is restated. Keyed on raw
// text these become rival rows, and the agent ends up holding two baselines
// for one fact.
assert('"price per month" == "monthly price"', same('price per month', 'monthly price'));
assert('"typical monthly cost" == "price per month"', same('typical monthly cost', 'price per month'));
assert('"new price per month" == "price per month"', same('new price per month', 'price per month'));
assert('a different fact stays different', !same('price per month', 'included compute credit'));
assert('per-seat is not per-org', !same('price per seat per month', 'price per month'));
assert(
  'different subjects never collide',
  claimKey('Neon Launch plan', 'price per month') !== claimKey('Supabase Pro plan', 'price per month'),
);

/* ------------------------------ extraction ------------------------------ */

console.log('\nhtml extraction');

const html = `<html><head><title>Pricing — Example</title></head>
<body><nav>Home Docs Login</nav><script>var x = "Free forever";</script>
<table><tr><td>Pro</td><td>$25 per user / month</td></tr><tr><td>Business</td><td>$79 per user / month</td></tr></table>
<footer>&copy; 2026 Example Inc</footer></body></html>`;
const page = extract(html);
check('title', page.title, 'Pricing — Example');
assert('nav and footer dropped', !/Login|Example Inc/.test(page.text), page.text);
assert('script contents dropped', !page.text.includes('Free forever'), page.text);
assert('table rows stay on separate lines', /Pro \| \$25 per user \/ month/.test(page.text) && /Business \| \$79/.test(page.text), JSON.stringify(page.text));

/* -------------------------------- result -------------------------------- */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
