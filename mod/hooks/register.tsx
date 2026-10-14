import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code';

import type { Probe, Usage, View } from '../types';

/**
 * aimux inside Claude Code: every subscription's 5-hour and weekly usage in a band
 * above the prompt, a warning before the one this session runs on is spent, and —
 * once it is — `/exit` in the prompt, so one Enter moves the conversation to the
 * freest one. `/aimux` prints the whole table with reset times.
 *
 * This session's own windows arrive with every response (`session.measure`). The
 * other subscriptions are asked of aimux (`aimux status --json`), at the start and
 * after a turn once the figures are five minutes old — an idle session asks nothing,
 * and aimux's on-disk cache lets every open session share one probe.
 *
 * Moving is aimux's job, after claude exits: it carries the conversation over when it
 * finds the hit in the transcript. The mod only tells it the person already agreed —
 * by running the `/exit` it offered — so aimux does not ask a second time.
 *
 * With `continuation.auto_at` set (`AIMUX_AUTO_AT`), nobody is asked: once a window
 * reaches that percentage and another subscription is below it on every window, the
 * mod runs `/exit` itself as soon as the turn ends — never mid-turn, and not while a
 * background agent is still running — and aimux resumes the session there.
 *
 * A band of its own rather than `$.ui.status`: the engine draws that line as one of
 * its pinned warnings, yellow with a ⚠, which reads as something being wrong.
 *
 * Inert in a session aimux did not launch: nothing names the profile or aimux.
 */

const REFRESH_MS = 5 * 60_000;
/** Where the warning comes, and where a window counts as spent after a refused turn. */
const WARN_AT = 90;
const SPENT_AT = 95;
/** Where the band paints a window red and says when it resets. */
const NEAR = 80;
const WINDOW_NAME: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' };

const pct = (p: number | null) => (p === null ? '–' : String(p));
const windowName = (w: SessionRateLimit) => WINDOW_NAME[w.kind] ?? w.kind;

/** A window's reset as epoch milliseconds, from the ISO time the engine reports. */
const parseTime = (iso: string | undefined) => (iso ? Date.parse(iso) : undefined);

/** The band's colors for a window's use, as `aimux status` paints them. */
const levelColor = (p: number) => (p >= NEAR ? 'red' : p >= 60 ? 'yellow' : 'green');

/**
 * The freest other claude subscription: its tightest window lowest, and lower than
 * this one's (`own`) — moving is only worth it to somewhere with more room left.
 */
function freest(others: Record<string, Probe>, current: string, own: number): [string, Usage] | undefined {
  let best: [string, Usage, number] | undefined;

  for (const [name, probe] of Object.entries(others)) {
    if (name === current || probe.cli !== 'claude' || !probe.status) continue;

    const windows = [probe.status.fiveHourPct, probe.status.weeklyPct].filter((p): p is number => p !== null);
    if (windows.length === 0) continue;

    const tightest = Math.max(...windows);
    if (tightest < Math.min(own, 100) && (!best || tightest < best[2])) best = [name, probe.status, tightest];
  }

  return best && [best[0], best[1]];
}

/** Where a session moving on its own may go: the freest subscription whose every window
 *  is below `limit` — anywhere fuller would only move it again after one turn. */
function freestBelow(others: Record<string, Probe>, current: string, limit: number): [string, Usage] | undefined {
  const below = Object.fromEntries(Object.entries(others).filter(([, probe]) => {
    const windows = [probe.status?.fiveHourPct, probe.status?.weeklyPct].filter((p): p is number => typeof p === 'number');
    return windows.length > 0 && Math.max(...windows) < limit;
  }));
  return freest(below, current, 100);
}

/** ` (resets in 2h 10m)`, or nothing when the reset time is unknown or past. Counted
 *  from `now` rather than printed as a clock time: the mod's sandbox has no time zone. */
export function resetsIn(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= now) return '';

  const minutes = Math.ceil((resetsAt - now) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const text = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

  return ` (resets in ${text})`;
}

/** One subscription: its windows, each named as claude's own status line names them;
 *  one it does not have (codex's 5-hour one) is left out. */
export type Cell = { name: string; isExpired: boolean; windows: { label: string; pct: number; resetsAt?: number }[] };

/**
 * The session's own subscription first, wherever it sits in the profile list, then
 * the rest. Its own login is never in doubt: the session running is proof enough, and
 * an older reading that said otherwise predates it.
 */
export function cells(view: View): Cell[] {
  const cell = (name: string, usage: Usage | null | undefined, isExpired: boolean): Cell => ({
    name,
    isExpired,
    windows: [
      ...(usage?.fiveHourPct != null ? [{ label: '5h', pct: usage.fiveHourPct, resetsAt: usage.fiveHourResetsAt }] : []),
      ...(usage?.weeklyPct != null ? [{ label: '7d', pct: usage.weeklyPct, resetsAt: usage.weeklyResetsAt }] : []),
    ],
  });

  const rest = Object.entries(view.others)
    .filter(([name]) => name !== view.current)
    .map(([name, probe]) => cell(name, probe.status, probe.error === 'auth'));

  return [cell(view.current, view.live ?? view.others[view.current]?.status, false), ...rest];
}

/** What `/aimux` prints: every subscription on its own line, each window with its reset. */
export function table(view: View): string {
  const all = cells(view);
  const width = Math.max(...all.map((c) => c.name.length));

  const lines = all.map((c, i) => {
    const name = `${i === 0 ? '▸' : ' '} ${c.name.padEnd(width)}`;
    if (c.isExpired) return `${name}  login expired — run: aimux run ${c.name}`;
    if (c.windows.length === 0) return `${name}  no figures right now`;

    const windows = c.windows.map((w) => `${w.label} ${w.pct}%${resetsIn(w.resetsAt, view.now)}`).join(' · ');
    return `${name}  ${windows}${i === 0 ? '  ← this session' : ''}`;
  });

  return ['How much of each subscription is used', ...lines].join('\n');
}

export function warning(current: string, window: SessionRateLimit, others: Record<string, Probe>, own: number, now: number): string {
  const head = `${current} has used ${Math.round(window.percentUsed)}% of its ${windowName(window)} window${resetsIn(parseTime(window.resetsAt), now)}.`;
  if (Object.keys(others).length === 0) return `${head} aimux could not read the other subscriptions.`;

  const next = freest(others, current, own);
  if (!next) return `${head} No other claude subscription has more room right now.`;

  const [name, usage] = next;
  return `${head} Freest now: ${name} (5h ${pct(usage.fiveHourPct)}%, 7d ${pct(usage.weeklyPct)}%). `
    + 'When this one runs out, aimux will offer to move this conversation there.';
}

// What the band draws: host state, so a write redraws it.
const view = atom({ plugin: 'aimux', key: 'view' } as const, null);

// The session's own figures. Module state: a hot reload starts it over, which only
// means one more probe.
// ponytail: an `aimux split` of N panes starts N sessions at once, each probing every
// subscription before the shared reading exists — N×M one-token requests, once. A lock
// around the probe would make it one round; not worth it yet.
let current: string | undefined;
let aimux: string[] | undefined;
let handoff: string | undefined;
let others: Record<string, Probe> = {};
let live: Usage | undefined;
let fetchedAt: number | undefined;
let reading: Promise<boolean> | undefined;
let offered: string | undefined;
const warned = new Set<string>();
/** `continuation.auto_at`, when set: the percentage at which the session moves on its own. */
let autoAt: number | undefined;
/** Where the session moves once the turn under way ends. */
let pendingMove: string | undefined;
/** Set once the mod has written the handoff and asked for `/exit`. */
let moving: string | undefined;

async function snapshot($: EngineInterface): Promise<View | undefined> {
  return current ? { current, others, live: live ?? null, now: await $.clock.now() } : undefined;
}

async function show($: EngineInterface) {
  const next = await snapshot($);
  if (next) await update($, view, () => next);
}

/** One question to aimux; whether it answered. */
async function readOthers($: EngineInterface, command: string[]): Promise<boolean> {
  try {
    const { exitCode, stdout } = await $.process.run(command, { timeoutMs: 60_000 });
    if (exitCode !== 0) return false;

    others = JSON.parse(stdout).profiles;
    return true;
  } catch {
    // aimux unreachable this time: keep the figures we have
    return false;
  } finally {
    // A failed attempt waits its turn too: this runs after every response, and a
    // broken aimux must not be started again each time.
    fetchedAt = await $.clock.now();
  }
}

/**
 * Ask aimux for every subscription's figures, no older than `maxAgeSeconds`; whether
 * it answered. One question at a time: a second caller waits for the one under way.
 */
function fetchOthers($: EngineInterface, maxAgeSeconds: number): Promise<boolean> {
  if (!aimux) return Promise.resolve(false);

  reading ??= readOthers($, [...aimux, 'status', '--json', '--max-age', String(maxAgeSeconds)])
    .finally(() => { reading = undefined; });

  return reading;
}

async function refresh($: EngineInterface) {
  const now = await $.clock.now();
  if (fetchedAt !== undefined && now - fetchedAt < REFRESH_MS) return;

  await fetchOthers($, 240);
  await show($);
}

/** `/aimux`: the whole table, read fresh — or saying so when it could not be. */
async function report($: EngineInterface): Promise<string> {
  // A background reading under way may be an older one than asked for here: let it
  // land, then ask again.
  await reading;
  const isFresh = await fetchOthers($, 30);
  await show($);

  const now = await snapshot($);
  if (!now) return 'aimux did not start this session, so it has nothing to show here.';

  return isFresh ? table(now) : `${table(now)}\n(aimux could not be reached just now — these are the last figures it gave)`;
}

/** The window is spent: name where to go, and put `/exit` where one Enter runs it. */
async function offerMove($: EngineInterface, window: SessionRateLimit, now: number) {
  if (!current) return;

  const head = `${current} is out of its ${windowName(window)} window${resetsIn(parseTime(window.resetsAt), now)}.`;
  const next = freest(others, current, 100);
  if (!next) {
    $.ui.toast(`${head} No other claude subscription has room right now.`, { timeoutMs: 30_000 });
    return;
  }

  const [name, usage] = next;
  offered = name;

  if (autoAt !== undefined) {
    pendingMove = name;
    $.ui.toast(`${head} Moving this conversation to ${name} (5h ${pct(usage.fiveHourPct)}%, 7d ${pct(usage.weeklyPct)}%).`, { timeoutMs: 30_000 });
    // The refused turn has already ended: nothing to wait for.
    $.clock.after(0, () => void moveNow($));
    return;
  }

  // Never over a draft: the person's own words stay, and they type /exit themselves.
  const box = await $.prompt.read();
  const filled = box.text.trim() === '' && (await $.prompt.fill({ text: '/exit' })).isFilled;
  const how = filled ? 'Press Enter' : 'Run /exit';

  $.ui.toast(
    `${head} ${how} to carry this conversation over to ${name} (5h ${pct(usage.fiveHourPct)}%, 7d ${pct(usage.weeklyPct)}%).`,
    { timeoutMs: 30_000 },
  );
}

/**
 * A spent window, by whichever sign came first — its use reaching 100%, or a turn the
 * API refused over the limit. One offer per window, and not before aimux has answered
 * once: the offer is about where to go next.
 */
async function spent($: EngineInterface, window: SessionRateLimit, now: number) {
  const key = `${window.kind}:${window.resetsAt ?? ''}:out`;
  if (fetchedAt === undefined || warned.has(key)) return;

  warned.add(key);
  await offerMove($, window, now);
}

/** A turn the API refused over a rate limit: spent, if a window is in fact nearly full. */
async function refusedOverLimit($: EngineInterface) {
  const { rateLimits } = await $.session.usage();
  const tightest = rateLimits
    .filter((w) => w.kind in WINDOW_NAME)
    .sort((a, b) => b.percentUsed - a.percentUsed)[0];

  // A refusal with room left in every window is the API being busy, not a spent
  // subscription: nothing to move for.
  if (tightest && tightest.percentUsed >= SPENT_AT) await spent($, tightest, await $.clock.now());
}

/** The person ran /exit after the offer: tell aimux, so it moves without asking again. */
async function agreeToMove($: EngineInterface) {
  // The mod's own /exit: the handoff it wrote already says where, and that it was automatic.
  if (moving) return;
  if (offered && handoff) await $.fs.write(handoff, offered);
}

/**
 * A window crossed `auto_at`: plan the move for when the turn ends, saying so once per
 * window — or, with nowhere below the line to go, saying that instead and staying.
 */
async function planAutoMove($: EngineInterface, window: SessionRateLimit, now: number) {
  if (!current || autoAt === undefined || moving || fetchedAt === undefined) return;

  const key = `${window.kind}:${window.resetsAt ?? ''}:auto`;
  const head = `${current} has used ${Math.round(window.percentUsed)}% of its ${windowName(window)} window${resetsIn(parseTime(window.resetsAt), now)}.`;
  const next = freestBelow(others, current, autoAt);
  if (!next) {
    pendingMove = undefined;
    if (!warned.has(key)) {
      warned.add(key);
      $.ui.toast(`${head} No other claude subscription is below ${autoAt}%, so this one carries on.`, { timeoutMs: 15_000 });
    }
    return;
  }

  const [name, usage] = next;
  if (pendingMove !== name) {
    $.ui.toast(
      `${head} Moving this conversation to ${name} (5h ${pct(usage.fiveHourPct)}%, 7d ${pct(usage.weeklyPct)}%) once this turn ends.`,
      { timeoutMs: 15_000 },
    );
  }
  pendingMove = name;
}

/**
 * The turn is over and a move is due: tell aimux where, then run `/exit`. Not while a
 * background agent runs — exiting would kill it — so it waits for a later turn's end.
 */
async function moveNow($: EngineInterface) {
  if (!pendingMove || moving || !handoff) return;

  const running = (await $.agent.list()).filter((a) => a.status === 'running' || a.status === 'pending');
  if (running.length > 0) {
    const key = `agents:${pendingMove}`;
    if (!warned.has(key)) {
      warned.add(key);
      $.ui.toast(`Waiting for ${running.length} background agent${running.length > 1 ? 's' : ''} to finish before moving to ${pendingMove}.`, { timeoutMs: 15_000 });
    }
    return;
  }

  moving = pendingMove;
  await $.fs.write(handoff, JSON.stringify({ profile: moving, auto: true }));
  try {
    await $.command.run({ command: 'exit' });
  } catch {
    // The engine would not run it from here: fall back to one Enter.
    const box = await $.prompt.read();
    const filled = box.text.trim() === '' && (await $.prompt.fill({ text: '/exit' })).isFilled;
    $.ui.toast(`${filled ? 'Press Enter' : 'Run /exit'} to move this conversation to ${moving}.`, { timeoutMs: 30_000 });
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    current = await $.env.get('AIMUX_RUN_PROFILE');
    const self = await $.env.get('AIMUX_SELF');
    aimux = current && self ? JSON.parse(self) : undefined;
    handoff = await $.env.get('AIMUX_HANDOFF');
    const at = Number(await $.env.get('AIMUX_AUTO_AT'));
    autoAt = Number.isFinite(at) && at >= 1 && at <= 100 ? at : undefined;

    if (aimux) {
      await $.command.register({ name: 'aimux', description: 'How much of every subscription is used, and when each resets' });

      // On a timer, not awaited: the first prompt must not wait on a network probe.
      $.clock.after(0, () => void refresh($));
    }

    return next(e);
  });

  on('session.measure', async ($, e, next) => {
    if (!current) return next(e);

    const now = await $.clock.now();
    const five = e.rateLimits.find((w) => w.kind === 'five_hour');
    const week = e.rateLimits.find((w) => w.kind === 'seven_day');
    if (five || week) {
      live = {
        fiveHourPct: five ? Math.round(five.percentUsed) : null,
        weeklyPct: week ? Math.round(week.percentUsed) : null,
        fiveHourResetsAt: parseTime(five?.resetsAt),
        weeklyResetsAt: parseTime(week?.resetsAt),
      };
    }

    const own = Math.max(...[five, week].map((w) => w?.percentUsed ?? 0));
    // Every window back under the line (a reset, or a move that already happened): no
    // move is due, and crossing it again announces itself again.
    if (autoAt !== undefined && (five || week) && own < autoAt) {
      pendingMove = undefined;
      for (const w of [five, week]) if (w) warned.delete(`${w.kind}:${w.resetsAt ?? ''}:auto`);
    }
    for (const window of [five, week]) {
      if (!window) continue;

      // One notice per window and stage: a new reset time is a new window, and one
      // that eased back under the line may warn again.
      const at = `${window.kind}:${window.resetsAt ?? ''}`;
      if (autoAt !== undefined && window.percentUsed >= autoAt) {
        await planAutoMove($, window, now);
        continue;
      }
      if (window.percentUsed < WARN_AT) {
        warned.delete(`${at}:near`);
        warned.delete(`${at}:out`);
        continue;
      }

      if (window.percentUsed >= 100) {
        await spent($, window, now);
        continue;
      }

      // Not before aimux has answered once: the notice names where to go next.
      if (fetchedAt === undefined || warned.has(`${at}:near`)) continue;

      warned.add(`${at}:near`);
      $.ui.toast(warning(current, window, others, own, now), { timeoutMs: 15_000 });
    }

    await show($);
    $.clock.after(0, () => void refresh($));
    return next(e);
  });

  // The end of the main conversation's turn: the one safe moment to move.
  on('turn.complete', async ($, e, next) => {
    if (current && e.agentId === undefined && pendingMove) $.clock.after(0, () => void moveNow($));
    return next(e);
  });

  on('classic.StopFailure', async ($, e, next) => {
    if (current && e.error === 'rate_limit') await refusedOverLimit($);
    return next(e);
  });

  on('command.run', { command: 'exit' }, async ($, e, next) => {
    await agreeToMove($);
    return next(e);
  });

  on('command.run', { command: 'aimux' }, async ($) => ({ text: await report($) }));

  // `aimux  ▸ dt (this session) 5h:27% 7d:43%  │  main 5h:13% 7d:12% · cx 7d:36%`
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const drawn = await read($, view);
    if (drawn === null || e.props.hasSurvey) return next(e);

    const { Box, Text } = $.ui.resolve(e);
    const [own, ...rest] = cells(drawn);
    if (!own) return next(e);

    const usage = (cell: Cell) => {
      if (cell.isExpired) return [<Text color="yellow">login expired</Text>];
      if (cell.windows.length === 0) return [<Text dimColor>–</Text>];

      // A window close to its limit also says when it frees up.
      return cell.windows.flatMap((w, i) => [
        <Text dimColor>{`${i > 0 ? ' ' : ''}${w.label}:`}</Text>,
        <Text color={levelColor(w.pct)}>{`${w.pct}%`}</Text>,
        <Text dimColor>{w.pct >= NEAR ? resetsIn(w.resetsAt, drawn.now) : ''}</Text>,
      ]);
    };

    // One Text of colored spans, not a row of boxes: a row squeezes each box on a
    // narrow terminal and wraps them one by one; a single text wraps as a line does.
    return (
      <Box>
        <Text>
          <Text dimColor>aimux  </Text>
          <Text bold>{`▸ ${own.name} `}</Text>
          <Text dimColor>(this session) </Text>
          {usage(own)}
          {rest.length > 0 ? <Text dimColor>{'  │  '}</Text> : null}
          {rest.flatMap((cell, i) => [
            <Text dimColor>{`${i > 0 ? ' · ' : ''}`}</Text>,
            <Text>{`${cell.name} `}</Text>,
            ...usage(cell),
          ])}
        </Text>
      </Box>
    );
  });
};
