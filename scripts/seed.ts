import { randomUUID } from 'node:crypto';
import { store } from '../src/memory/store.js';
import { addDays, civilOf, formatDay, startOfDay, weekdayOf } from '../src/memory/temporal.js';

/**
 * Optional demo history, so you can test the memory and re-check paths on a
 * fresh clone without waiting a week.
 *
 * Every row is marked `seeded: true`. The agent is told in its prompt that such
 * rows are demo data, and the recorded values are deliberately a snapshot in
 * time: the point is to watch `verify_claims` go and find out which of them no
 * longer hold.
 */

store.init();

// The log is append-only, so running this twice would leave two copies of every
// claim and make the verifier check each fact twice.
if (store.allTurns().some((t) => t.seeded)) {
  console.log('\nDemo history is already seeded. Clear it with `rm -rf data` first if you want to reseed.\n');
  process.exit(0);
}

const today = civilOf(Date.now());
const at = (daysAgo: number, hour: number) =>
  new Date(startOfDay(addDays(today, -daysAgo)) + hour * 3600_000).toISOString();

/**
 * Most recent past occurrence of a weekday (0=Sun). Must read the weekday off
 * the civil date: calling getUTCDay() on the instant of local midnight returns
 * the previous day's name anywhere east or west of UTC.
 */
function daysSinceWeekday(wd: number): number {
  const delta = (weekdayOf(today) - wd + 7) % 7;
  return delta === 0 ? 7 : delta;
}

const mondayAgo = daysSinceWeekday(1);
const tuesdayAgo = daysSinceWeekday(2);

const rows = [
  {
    daysAgo: mondayAgo,
    hour: 10,
    session: randomUUID(),
    user: 'We need a CRM for a 20-person sales team. Shortlist 5 options with pricing.',
    assistant:
      'Five worth looking at for a 20-seat sales team:\n\n' +
      '| Tool | Plan | Price per seat / month | Why it is on the list |\n' +
      '| --- | --- | --- | --- |\n' +
      '| HubSpot | Sales Hub Professional | $100 [1] | Strongest all-round platform, but the seat price bites at 20 |\n' +
      '| Pipedrive | Professional | $49 [2] | Cheapest credible pipeline tool at this size |\n' +
      '| Salesforce | Sales Cloud Professional | $100 [3] | Only worth it if you already need the ecosystem |\n' +
      '| Zoho CRM | Professional | $23 [4] | By far the cheapest; the UI is the trade-off |\n' +
      '| Close | Professional | $99 [5] | Built for outbound teams that live on the phone |\n\n' +
      'For 20 seats, Pipedrive or Zoho keep you under $1k/month. HubSpot and Salesforce both land near $2k/month before add-ons.',
    sources: [
      { n: 1, url: 'https://www.hubspot.com/pricing/sales', title: 'HubSpot Sales Hub pricing' },
      { n: 2, url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive pricing' },
      { n: 3, url: 'https://www.salesforce.com/sales/pricing/', title: 'Salesforce Sales Cloud pricing' },
      { n: 4, url: 'https://www.zoho.com/crm/zohocrm-pricing.html', title: 'Zoho CRM pricing' },
      { n: 5, url: 'https://close.com/pricing/', title: 'Close pricing' },
    ],
    summary: 'Shortlisted 5 CRMs with per-seat pricing for a 20-person sales team.',
    entities: ['HubSpot', 'Pipedrive', 'Salesforce', 'Zoho CRM', 'Close', 'CRM'],
    claims: [
      { subject: 'HubSpot Sales Hub Professional', attribute: 'price per seat per month', value: '$100', src: 1 },
      { subject: 'Pipedrive Professional', attribute: 'price per seat per month', value: '$49', src: 2 },
      { subject: 'Salesforce Sales Cloud Professional', attribute: 'price per seat per month', value: '$100', src: 3 },
      { subject: 'Zoho CRM Professional', attribute: 'price per seat per month', value: '$23', src: 4 },
      { subject: 'Close Professional', attribute: 'price per seat per month', value: '$99', src: 5 },
    ],
  },
  {
    daysAgo: tuesdayAgo,
    hour: 15,
    session: randomUUID(),
    user: 'Where should I host a small Postgres database? Something cheap that scales.',
    assistant:
      'Neon if you want serverless Postgres with branching; Supabase if you want Postgres plus auth and storage in one box.\n\n' +
      '- **Neon** — free tier, then the Launch plan at $19/month [1]. Scale-to-zero means a hobby database costs almost nothing.\n' +
      '- **Supabase** — free tier, then Pro at $25/month per org [2]. You get auth, realtime and object storage with it.\n' +
      '- **Railway** — usage-based on the Hobby plan at $5/month including credit [3]. Simplest if you are deploying the app there too.\n\n' +
      'For a small database that occasionally sleeps, Neon is the cheapest serious option.',
    sources: [
      { n: 1, url: 'https://neon.com/pricing', title: 'Neon pricing' },
      { n: 2, url: 'https://supabase.com/pricing', title: 'Supabase pricing' },
      { n: 3, url: 'https://railway.com/pricing', title: 'Railway pricing' },
    ],
    summary: 'Recommended Neon, Supabase or Railway for a small Postgres database, with monthly prices.',
    entities: ['Neon', 'Supabase', 'Railway', 'Postgres'],
    claims: [
      { subject: 'Neon Launch plan', attribute: 'price per month', value: '$19', src: 1 },
      { subject: 'Supabase Pro plan', attribute: 'price per month', value: '$25', src: 2 },
      { subject: 'Railway Hobby plan', attribute: 'price per month', value: '$5', src: 3 },
    ],
  },
];

let turns = 0;
let claims = 0;

for (const row of rows) {
  const ts = at(row.daysAgo, row.hour);
  const turn = store.addTurn({
    sessionId: row.session,
    ts,
    user: row.user,
    assistant: row.assistant,
    sources: row.sources,
    summary: row.summary,
    entities: row.entities,
    enriched: true,
    seeded: true,
  });
  turns++;
  for (const c of row.claims) {
    const src = row.sources.find((s) => s.n === c.src);
    store.addClaim({
      turnId: turn.id,
      sessionId: row.session,
      ts,
      subject: c.subject,
      attribute: c.attribute,
      value: c.value,
      sourceUrl: src?.url,
      sourceTitle: src?.title,
    });
    claims++;
  }
  console.log(`  seeded ${formatDay(civilOf(Date.parse(ts)))} — ${row.summary}`);
}

console.log(`\n${turns} turns, ${claims} tracked facts written to ${store.stats().file}`);
console.log('\nTry asking:');
console.log('  "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"');
console.log('  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"');
console.log('\nRemove the demo history at any time with: rm -rf data\n');
