import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertConfig, config } from './config.js';
import { store } from './memory/store.js';
import { chat } from './agent/agent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

store.init();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return sendFile(res, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    return sendFile(res, path.join(publicDir, 'app.js'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/style.css') {
    return sendFile(res, path.join(publicDir, 'style.css'), 'text/css; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    return json(res, 200, {
      problems: assertConfig(),
      provider: config.searchProvider ?? null,
      model: config.model,
      timezone: config.timezone,
      today: new Date().toISOString(),
      stats: store.stats(),
      sessions: store.sessions().slice(0, 20),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { error: 'id required' });
    return json(res, 200, { turns: store.sessionTurns(id) });
  }

  if (req.method === 'GET' && url.pathname === '/api/claims') {
    return json(res, 200, { claims: store.allClaims().slice(0, 200) });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const problems = assertConfig();
    if (problems.length) return json(res, 500, { error: problems.join(' ') });

    let body: { message?: string; sessionId?: string };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const message = (body.message ?? '').trim();
    if (!message) return json(res, 400, { error: 'message required' });
    const sessionId = body.sessionId || randomUUID();

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: session\ndata: ${JSON.stringify({ sessionId })}\n\n`);

    try {
      for await (const ev of chat({ message, sessionId })) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`);
    }
    return res.end();
  }

  json(res, 404, { error: 'not found' });
});

server.listen(config.port, () => {
  const problems = assertConfig();
  console.log(`\n  Recall agent -> http://localhost:${config.port}\n`);
  console.log(`  model     ${config.llm?.name ?? 'NOT CONFIGURED'} / ${config.model}  (fast: ${config.fastModel})`);
  console.log(`  search    ${config.searchProvider ?? 'NOT CONFIGURED'}`);
  console.log(`  timezone  ${config.timezone}`);
  console.log(`  memory    ${store.stats().turns} turns, ${store.stats().claims} claims  (${store.stats().file})`);
  if (problems.length) {
    console.log('\n  Missing configuration:');
    for (const p of problems) console.log(`   - ${p}`);
  }
  console.log('');
});

function sendFile(res: http.ServerResponse, file: string, type: string) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  });
}

function json(res: http.ServerResponse, code: number, data: unknown) {
  const payload = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
