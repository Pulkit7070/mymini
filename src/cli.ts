import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { assertConfig, config } from './config.js';
import { store } from './memory/store.js';
import { chat } from './agent/agent.js';

/**
 * The same agent, driven from a terminal. It exists to prove the core has no
 * dependency on the web UI: `chat()` is an async generator of events and the
 * transport is whatever you point at it.
 */

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

store.init();

const problems = assertConfig();
if (problems.length) {
  console.error(C.red('Missing configuration:'));
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const sessionId = process.env.SESSION_ID ?? randomUUID();

/** `npm run cli -- "question"` answers once and exits. Handy for scripted checks. */
const oneShot = process.argv.slice(2).join(' ').trim();

console.log(C.bold('\nmymini') + C.dim(` — ${config.llm?.name}/${config.model} · search: ${config.searchProvider} · ${store.stats().turns} turns in memory`));
if (!oneShot) console.log(C.dim('Ctrl+C to exit.\n'));

const rl = oneShot ? null : readline.createInterface({ input: stdin, output: stdout });

while (true) {
  const message = oneShot || (await rl!.question(C.blue('\nyou  '))).trim();
  if (!message) continue;
  if (message === '/exit' || message === '/quit') break;
  if (oneShot) console.log(C.blue('\nyou  ') + message);

  let printedHeader = false;
  for await (const ev of chat({ message, sessionId })) {
    switch (ev.type) {
      case 'memory':
        if (ev.refs.length) console.log(C.dim(`     dates: ${ev.refs.map((r) => `${r.text} -> ${r.label}`).join('; ')}`));
        if (ev.recalled.length) console.log(C.dim(`     recalled ${ev.recalled.length} past exchange(s), ${ev.claims} recorded fact(s)`));
        break;
      case 'tool': {
        const t = ev.tool;
        const line =
          t.kind === 'search' ? `searching: ${t.queries.join(' | ')}`
          : t.kind === 'read' ? `reading: ${t.urls.join(' | ')}`
          : t.kind === 'recall' ? `recalling: ${t.query}`
          : `re-checking: ${t.subjects.join(', ')}`;
        console.log(C.dim(`     ${line}`));
        break;
      }
      case 'text':
        if (!printedHeader) { stdout.write(C.green('\nagent ')); printedHeader = true; }
        stdout.write(ev.delta);
        break;
      case 'sources':
        console.log(C.dim(`\n\n     sources:\n${ev.sources.map((s) => `       [${s.n}] ${s.url}`).join('\n')}`));
        break;
      case 'done':
        console.log(C.dim(`\n     ${(ev.ms / 1000).toFixed(1)}s\n`));
        break;
      case 'error':
        console.log(C.red(`\n     error: ${ev.message}\n`));
        break;
    }
  }

  if (oneShot) break;
}

rl?.close();
// Background memory enrichment is still in flight; give it a moment to land.
if (oneShot) await new Promise((r) => setTimeout(r, 6000));
process.exit(0);
