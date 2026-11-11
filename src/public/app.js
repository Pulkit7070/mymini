const $ = (sel) => document.querySelector(sel);
const thread = $('#thread');
const input = $('#input');
const sendBtn = $('#send');
const panel = $('#memory-panel');

let sessionId = localStorage.getItem('sessionId') || null;
let busy = false;

/* --------------------------------- boot --------------------------------- */

const boot = await fetch('/api/bootstrap').then((r) => r.json());
renderStatus(boot);
if (sessionId) await restoreSession(sessionId);

function renderStatus(b) {
  const chips = [];
  chips.push(`<span class="chip">${b.model}</span>`);
  chips.push(`<span class="chip">search: ${b.provider ?? 'none'}</span>`);
  chips.push(`<span class="chip">${b.stats.turns} turns · ${b.stats.claims} facts tracked</span>`);
  if (b.problems.length) {
    chips.push(`<span class="chip alert">${b.problems.length} config issue${b.problems.length > 1 ? 's' : ''}</span>`);
    document.querySelector('.dot').classList.add('bad');
    console.warn('Configuration problems:', b.problems);
  }
  $('#status').innerHTML = chips.join('');
}

async function restoreSession(id) {
  const { turns } = await fetch(`/api/session?id=${encodeURIComponent(id)}`).then((r) => r.json());
  if (!turns?.length) return;
  $('#empty')?.remove();
  for (const t of turns) {
    addUser(t.user);
    const el = addAgent();
    el.querySelector('.body').innerHTML = md(t.assistant);
    if (t.sources?.length) el.querySelector('.body').insertAdjacentHTML('afterend', sourcesHtml(t.sources));
    el.querySelector('.trace')?.remove();
  }
  scroll();
}

/* ------------------------------- composer ------------------------------- */

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send(input.value);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
});

$('#suggestions')?.addEventListener('click', (e) => {
  const q = e.target.closest('button')?.dataset.q;
  if (q) send(q);
});

$('#new-chat').addEventListener('click', () => {
  sessionId = null;
  localStorage.removeItem('sessionId');
  location.reload();
});

$('#memory-toggle').addEventListener('click', () => {
  panel.setAttribute('aria-hidden', panel.getAttribute('aria-hidden') === 'false' ? 'true' : 'false');
});
$('#memory-close').addEventListener('click', () => panel.setAttribute('aria-hidden', 'true'));

/* --------------------------------- send --------------------------------- */

async function send(text) {
  const message = text.trim();
  if (!message || busy) return;
  busy = true;
  sendBtn.disabled = true;
  input.value = '';
  input.style.height = 'auto';
  $('#empty')?.remove();

  addUser(message);
  const el = addAgent();
  const traceEl = el.querySelector('.trace');
  const bodyEl = el.querySelector('.body');
  bodyEl.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';

  let answer = '';
  let started = performance.now();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);

    for await (const ev of sse(res)) {
      if (ev.sessionId) {
        sessionId = ev.sessionId;
        localStorage.setItem('sessionId', sessionId);
        continue;
      }
      switch (ev.type) {
        case 'memory':
          renderMemory(ev);
          if (ev.recalled.length || ev.refs.length) {
            traceEl.insertAdjacentHTML('beforeend', step('remembered', memorySummary(ev)));
          }
          break;
        case 'tool':
          traceEl.insertAdjacentHTML('beforeend', toolStep(ev.tool));
          scroll();
          break;
        case 'text':
          if (!answer) bodyEl.innerHTML = '';
          answer += ev.delta;
          bodyEl.innerHTML = md(answer);
          scroll();
          break;
        case 'sources':
          bodyEl.insertAdjacentHTML('afterend', sourcesHtml(ev.sources));
          break;
        case 'done':
          el.insertAdjacentHTML('beforeend', `<div class="meta"><span>${(ev.ms / 1000).toFixed(1)}s</span></div>`);
          refreshStats();
          break;
        case 'error':
          bodyEl.innerHTML = `<p style="color:var(--warn)">${escapeHtml(ev.message)}</p>`;
          break;
      }
    }
  } catch (err) {
    bodyEl.innerHTML = `<p style="color:var(--warn)">${escapeHtml(err.message)}</p>`;
  } finally {
    busy = false;
    sendBtn.disabled = false;
    input.focus();
    scroll();
  }
}

async function* sse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try { yield JSON.parse(line.slice(6)); } catch {}
    }
  }
}

/* ------------------------------- rendering ------------------------------ */

function addUser(text) {
  thread.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="bubble">${escapeHtml(text)}</div></div>`);
  scroll();
}

function addAgent() {
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = '<div class="trace"></div><div class="body"></div>';
  thread.appendChild(div);
  scroll();
  return div;
}

function step(label, detail) {
  return `<div class="step"><b>${label}</b><span class="q">${escapeHtml(detail)}</span></div>`;
}

function toolStep(t) {
  if (t.kind === 'search') return step('searched', t.queries.join('  ·  '));
  if (t.kind === 'read') return step('read', t.urls.map(hostOf).join('  ·  '));
  if (t.kind === 'recall') return step('recalled', t.query);
  if (t.kind === 'verify') return step('re-checking', t.subjects.join('  ·  '));
  return '';
}

function memorySummary(ev) {
  const bits = [];
  if (ev.refs.length) bits.push(ev.refs.map((r) => `${r.text} → ${r.label}`).join('; '));
  if (ev.recalled.length) bits.push(`${ev.recalled.length} past exchange${ev.recalled.length > 1 ? 's' : ''}`);
  if (ev.claims) bits.push(`${ev.claims} recorded fact${ev.claims > 1 ? 's' : ''}`);
  return bits.join('  ·  ');
}

function sourcesHtml(sources) {
  const items = sources
    .map((s) => `<li><a href="${escapeAttr(s.url)}" target="_blank" rel="noreferrer noopener" id="src-${s.n}">[${s.n}] ${escapeHtml(s.title)}</a> <span>${hostOf(s.url)}</span></li>`)
    .join('');
  return `<div class="sources"><ol>${items}</ol></div>`;
}

async function renderMemory(ev) {
  const body = $('#memory-body');
  const parts = [];

  if (ev.refs.length) {
    parts.push('<h4>Dates resolved</h4>');
    parts.push(ev.refs.map((r) => `<div class="mem-item"><b>“${escapeHtml(r.text)}”</b><div class="what">${escapeHtml(r.label)}</div></div>`).join(''));
  }

  parts.push('<h4>Recalled for this question</h4>');
  parts.push(
    ev.recalled.length
      ? ev.recalled
          .map((r) => `<div class="mem-item"><span class="why">${r.reason}</span><div class="when">${new Date(r.ts).toLocaleString()}</div><div class="what">${escapeHtml(r.summary ?? r.user)}</div></div>`)
          .join('')
      : '<p class="empty-note">Nothing from earlier conversations matched.</p>',
  );

  const { claims } = await fetch('/api/claims').then((r) => r.json());
  parts.push('<h4>Facts on record</h4>');
  parts.push(
    claims.length
      ? claims
          .slice(0, 40)
          .map((c) => {
            const checked = c.lastCheckedAt ? ` · ${c.lastCheckResult} ${c.lastCheckedAt.slice(0, 10)}` : '';
            return `<div class="claim-row"><b>${escapeHtml(c.subject)}</b> — ${escapeHtml(c.attribute)}<br><span class="val">${escapeHtml(c.value)}</span><span class="when"> · told ${c.ts.slice(0, 10)}${checked}</span></div>`;
          })
          .join('')
      : '<p class="empty-note">No time-sensitive facts recorded yet. Ask about prices or versions.</p>',
  );

  body.innerHTML = parts.join('');
}

async function refreshStats() {
  const b = await fetch('/api/bootstrap').then((r) => r.json());
  renderStatus(b);
}

function scroll() {
  thread.scrollTop = thread.scrollHeight;
}

function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; }
}

const escapeHtml = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escapeAttr = escapeHtml;

/**
 * Small markdown renderer. A dependency would mean a build step or a CDN
 * script; the answer surface here is headings, lists, tables, code, links and
 * citations, which is a couple of dozen lines. Everything is escaped first, so
 * nothing the model or the web returns can inject markup.
 */
function md(src) {
  // Some models emit their own private citation markers (【4†L1-L8】) regardless
  // of the format they were asked for. They mean nothing to the reader and
  // there is no source behind them, so they are dropped rather than rendered.
  const lines = escapeHtml(src.replace(/【[^】]*】/g, '')).split('\n');
  const out = [];
  let i = 0;

  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
      .replace(/\[(\d+)\]/g, '<a class="cite" href="#src-$1">$1</a>');

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${Math.min(3, h[1].length)}>${inline(h[2])}</h${Math.min(3, h[1].length)}>`); i++; continue; }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*[-*]\s+/, '')));
      out.push(`<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*\d+\.\s+/, '')));
      out.push(`<ol>${items.map((t) => `<li>${t}</li>`).join('')}</ol>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|```|\s*\|)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('');
}

function cells(row) {
  return row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}
