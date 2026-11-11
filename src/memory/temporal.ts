import { config } from '../config.js';

/**
 * Deterministic resolution of the time words people actually use in chat.
 *
 * Models are unreliable at date arithmetic and have no idea what day it is, so
 * we never ask them to work out that "last Tuesday" was the 10th. We resolve it
 * here against a real clock and a real timezone, then hand the model the
 * absolute answer. Everything below is pure functions over a `now` you pass in,
 * which is also why it is testable without mocking the system clock.
 */

export interface ResolvedRef {
  /** The phrase as the user typed it. */
  text: string;
  /** Inclusive start of the window, epoch ms. */
  startMs: number;
  /** Inclusive end of the window, epoch ms. */
  endMs: number;
  /** Human label for the prompt, e.g. "Monday 9 November 2026". */
  label: string;
  /**
   * English is ambiguous: on a Thursday, "last Tuesday" means either two days
   * ago or nine. When that happens we carry the other reading instead of
   * silently picking one, retrieve from both windows, and let the answer say so.
   */
  alternate?: { startMs: number; endMs: number; label: string };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

interface Civil { y: number; m: number; d: number }

function offsetMs(instant: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - instant;
}

/** Civil (wall-clock) date in the configured timezone for an instant. */
export function civilOf(instant: number, tz = config.timezone): Civil {
  const o = offsetMs(instant, tz);
  const d = new Date(instant + o);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** Epoch ms of local midnight starting the given civil date. Handles DST. */
export function startOfDay(c: Civil, tz = config.timezone): number {
  const guess = Date.UTC(c.y, c.m - 1, c.d, 0, 0, 0);
  let ms = guess - offsetMs(guess, tz);
  ms = guess - offsetMs(ms, tz); // second pass settles DST boundaries
  return ms;
}

export function dayWindow(c: Civil, tz = config.timezone): { startMs: number; endMs: number } {
  const startMs = startOfDay(c, tz);
  const next = startOfDay(addDays(c, 1), tz);
  return { startMs, endMs: next - 1 };
}

export function addDays(c: Civil, n: number): Civil {
  const d = new Date(Date.UTC(c.y, c.m - 1, c.d));
  d.setUTCDate(d.getUTCDate() + n);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function weekdayOf(c: Civil): number {
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}

export function formatDay(c: Civil): string {
  const wd = WEEKDAYS[weekdayOf(c)];
  const mon = MONTHS[c.m - 1];
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  return `${cap(wd)} ${c.d} ${cap(mon)} ${c.y}`;
}

export function todayLabel(now = Date.now()): string {
  return formatDay(civilOf(now));
}

/** Most recent past occurrence of `weekday` strictly before today, or today if it matches and `includeToday`. */
function lastWeekday(today: Civil, weekday: number, includeToday: boolean): Civil {
  let delta = (weekdayOf(today) - weekday + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return addDays(today, -delta);
}

const ORDINAL = /(\d{1,2})(?:st|nd|rd|th)?/;

export function resolveTimeReferences(text: string, now = Date.now()): ResolvedRef[] {
  const today = civilOf(now);
  const out: ResolvedRef[] = [];
  const lower = text.toLowerCase();
  const seen = new Set<string>();

  const push = (text: string, c: Civil, alt?: Civil) => {
    const key = `${text}:${c.y}-${c.m}-${c.d}`;
    if (seen.has(key)) return;
    seen.add(key);
    const w = dayWindow(c);
    const ref: ResolvedRef = { text, startMs: w.startMs, endMs: w.endMs, label: formatDay(c) };
    if (alt) {
      const aw = dayWindow(alt);
      ref.alternate = { startMs: aw.startMs, endMs: aw.endMs, label: formatDay(alt) };
    }
    out.push(ref);
  };

  const pushRange = (text: string, from: Civil, to: Civil, label: string) => {
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ text, startMs: dayWindow(from).startMs, endMs: dayWindow(to).endMs, label });
  };

  if (/\b(today|this morning|this afternoon|earlier today|tonight)\b/.test(lower)) push('today', today);
  if (/\byesterday\b/.test(lower)) push('yesterday', addDays(today, -1));
  if (/\b(day before yesterday)\b/.test(lower)) push('the day before yesterday', addDays(today, -2));

  // "on monday", "last tuesday", "this friday", bare "wednesday"
  for (const m of lower.matchAll(
    /\b(?:(on|last|past|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g,
  )) {
    const qualifier = m[1];
    const wd = WEEKDAYS.indexOf(m[2]);
    const primary = lastWeekday(today, wd, qualifier === 'this');
    // "last X" may mean the X of the previous calendar week; keep both readings.
    const alt = qualifier === 'last' ? addDays(primary, -7) : undefined;
    push(m[0].trim(), primary, alt);
  }

  // "3 november", "3rd nov 2025"
  for (const m of lower.matchAll(
    new RegExp(`\\b${ORDINAL.source}\\s+(${MONTHS.map((x) => `${x}|${x.slice(0, 3)}`).join('|')})\\.?(?:\\s+(\\d{4}))?\\b`, 'g'),
  )) {
    const day = +m[1];
    const mon = MONTHS.findIndex((x) => x.startsWith(m[2].slice(0, 3)));
    const year = m[3] ? +m[3] : inferYear(today, mon + 1, day);
    push(m[0].trim(), { y: year, m: mon + 1, d: day });
  }

  // "november 3", "nov 3rd, 2025"
  for (const m of lower.matchAll(
    new RegExp(`\\b(${MONTHS.map((x) => `${x}|${x.slice(0, 3)}`).join('|')})\\.?\\s+${ORDINAL.source}(?:,?\\s+(\\d{4}))?\\b`, 'g'),
  )) {
    const mon = MONTHS.findIndex((x) => x.startsWith(m[1].slice(0, 3)));
    const day = +m[2];
    const year = m[3] ? +m[3] : inferYear(today, mon + 1, day);
    push(m[0].trim(), { y: year, m: mon + 1, d: day });
  }

  // "3 days ago", "two weeks ago"
  for (const m of lower.matchAll(/\b(\d+|a|an|two|three|four|five|six|seven)\s+(day|week|month)s?\s+ago\b/g)) {
    const n = wordToNumber(m[1]);
    const unit = m[2];
    const days = unit === 'day' ? n : unit === 'week' ? n * 7 : n * 30;
    const from = addDays(today, -days - (unit === 'day' ? 0 : 3));
    const to = addDays(today, -days + (unit === 'day' ? 0 : 3));
    pushRange(m[0].trim(), from, to, `around ${formatDay(addDays(today, -days))}`);
  }

  if (/\blast week\b/.test(lower)) {
    const mondayThisWeek = addDays(today, -((weekdayOf(today) + 6) % 7));
    pushRange('last week', addDays(mondayThisWeek, -7), addDays(mondayThisWeek, -1),
      `the week of ${formatDay(addDays(mondayThisWeek, -7))}`);
  }
  if (/\bthis week\b/.test(lower)) {
    const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
    pushRange('this week', monday, today, `this week (from ${formatDay(monday)})`);
  }
  if (/\blast month\b/.test(lower)) {
    const first = { y: today.m === 1 ? today.y - 1 : today.y, m: today.m === 1 ? 12 : today.m - 1, d: 1 };
    const last = addDays({ y: today.y, m: today.m, d: 1 }, -1);
    pushRange('last month', first, last, `${MONTHS[first.m - 1]} ${first.y}`);
  }
  if (/\b(the other day|a few days ago|other day)\b/.test(lower)) {
    pushRange('the other day', addDays(today, -6), addDays(today, -2), 'the last few days');
  }

  return out;
}

/** Bare "3 November" means the most recent past 3 November, not a future one. */
function inferYear(today: Civil, month: number, day: number): number {
  const thisYear = today.y;
  const candidate = startOfDay({ y: thisYear, m: month, d: day });
  const todayMs = startOfDay(today);
  return candidate <= todayMs + 86_400_000 ? thisYear : thisYear - 1;
}

function wordToNumber(w: string): number {
  const map: Record<string, number> = { a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  return map[w] ?? (Number(w) || 1);
}

/**
 * "since then", "since we last spoke" — a window with an open end. The anchor is
 * the oldest explicit reference in the same message, falling back to the end of
 * the previous conversation.
 */
export function detectSinceAnchor(text: string): boolean {
  return (
    // "since then", "since we spoke", or a trailing bare "since?"
    /\bsince\s*(then|that|we\b|our\b|last\b|[?.!]|$)/i.test(text) ||
    // "has any of them changed", "did anything ship", "have prices moved"
    /\b(has|have|had|did|is|are)\b[^.?!]{0,60}\b(chang(ed|e)|updat(ed|e)|mov(ed|e)|shipp?ed|launch(ed)?|rais(ed)?|increas(ed)?|drop(ped)?|released?)\b/i.test(text) ||
    /\b(still)\s+(correct|true|accurate|right|valid|up.to.date|current|the case|hold(s)?)\b/i.test(text) ||
    /\bany\s+(updates?|changes?|news|movement)\b/i.test(text) ||
    /\bwhat'?s\s+(new|changed|different)\b/i.test(text) ||
    /\bout of date\b/i.test(text)
  );
}
