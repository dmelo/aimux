import { describe, expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On, SessionRateLimit } from 'claude-code';
import { cells, table } from './register';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const LIMITS = {
  fetchedAt: 0,
  profiles: {
    dt: { cli: 'claude', status: { fiveHourPct: 48, weeklyPct: 12 } },
    main: { cli: 'claude', status: { fiveHourPct: 13, weeklyPct: 17 } },
    busy: { cli: 'claude', status: { fiveHourPct: 5, weeklyPct: 100, weeklyResetsAt: 2 * DAY + 3 * HOUR } },
    cx: { cli: 'codex', status: { fiveHourPct: null, weeklyPct: 25 } },
    old: { cli: 'claude', status: null, error: 'auth' },
  },
};

const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false });

/** The engine's own answers beneath the plugins, for the events a test raises. */
function engineBeneath(on: On, commands: string[] = [], opts: { refuseExit?: boolean } = {}) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.measure', (_$, e) => ({ changed: e.changed }));
  on('classic.Stop', () => ({}));
  on('turn.complete', (_$, e) => ({ text: e.answer }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('command.run', (_$, e) => {
    if (opts.refuseExit && e.command === 'exit') throw new Error('not from here');
    commands.push(e.command);
    return { text: '' };
  });
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('classic.StopFailure', () => ({}));
}

/**
 * A session aimux launched as `dt`, with aimux answering `status --json` (or failing)
 * and the prompt box holding `draft`.
 */
function launchedByAimux(
  on: On,
  answer = ran(JSON.stringify(LIMITS)),
  draft = '',
  windows: SessionRateLimit[] = [],
  env: Record<string, string> = {},
  agents: { status: string }[] = [],
  opts: { refuseExit?: boolean } = {},
) {
  const seen = {
    toasts: [] as string[],
    runs: [] as (readonly string[])[],
    filled: [] as string[],
    written: [] as [string, string][],
    commands: [] as string[],
    submitted: [] as string[],
    agents,
    draft,
  };
  engineBeneath(on, seen.commands, opts);
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text);
    return { text: e.text } as never;
  });

  mock.env(on, { AIMUX_RUN_PROFILE: 'dt', AIMUX_SELF: '["node","/aimux/dist/cli.js"]', AIMUX_HANDOFF: '/aimux/handoff/1', ...env });
  on('agent.list', () => ({ value: seen.agents.map((a, i) => ({ id: `a${i}`, description: 'x', type: 'general-purpose', ...a })) as never }));
  on('process.run', (_$, e) => {
    seen.runs.push(e.argv);
    return { value: answer };
  });
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on('prompt.read', () => ({ value: { text: seen.draft, cursor: seen.draft.length } }));
  on('prompt.fill', (_$, e) => {
    seen.filled.push(e.text);
    return { isFilled: true, text: e.text, cursor: e.text.length };
  });
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: windows } }));
  on('fs.write', (_$, e) => {
    seen.written.push([e.path, e.text]);
    return { value: undefined };
  });

  return seen;
}

/** The band above the prompt as the terminal draws it, and its text read straight through. */
async function band($: Engine) {
  const props = { hasSurvey: false, isWorking: false } as never;
  const ui = await $.ui.mount({ plugin: 'aimux', surface: 'terminal', component: 'AbovePrompt', props });
  const textOf = (node: unknown): string => {
    if (typeof node === 'string') return node;
    const children = (node as { children?: unknown[] } | null)?.children ?? [];
    return children.map(textOf).join('');
  };

  return { ui, text: textOf(await ui.drawn()) };
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const;
const EXIT = { command: 'exit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const;
/** The conversation's turn ended with an answer, leaving `tasks` background tasks and `crons` wakeups. */
const stop = (tasks = 0, crons = 0) => ({
  stop_hook_active: false,
  background_tasks: Array.from({ length: tasks }, (_, i) => ({ id: `t${i}`, type: 'shell', status: 'running', description: 'dev server' })),
  session_crons: Array.from({ length: crons }, (_, i) => ({ id: `c${i}` })),
}) as never;
const measure = (rateLimits: SessionRateLimit[]) => ({ context: { window: 1_000_000 }, rateLimits, changed: ['rateLimits' as const] });

describe('aimux mod', () => {
  test('shows every subscription, this one marked, without holding up the first prompt', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);

    await $.session.start(START);
    expect(seen.runs).toEqual([]);

    await clock.settle();
    expect(seen.runs).toEqual([['node', '/aimux/dist/cli.js', 'status', '--json', '--max-age', '240']]);
    const { ui, text } = await band($);
    expect(text).toBe(
      'aimux  ▸ dt (this session) 5h:48% 7d:12%  │  main 5h:13% 7d:17% · busy 5h:5% 7d:100% (resets in 2d 3h) · cx 7d:25% · old login expired',
    );

    // Its own colors, not a warning's: a spent window red, a roomy one green.
    expect((await ui.find({ type: 'Text', text: /^100%$/ }))?.props).toMatchObject({ color: 'red' });
    expect((await ui.find({ type: 'Text', text: /^48%$/ }))?.props).toMatchObject({ color: 'green' });
  });

  test('takes this session\'s own figures from its responses', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 61.4 }, { kind: 'seven_day', percentUsed: 14 }]));
    expect((await band($)).text).toContain('▸ dt (this session) 5h:61% 7d:14%  │  main 5h:13% 7d:17%');
  });

  test('asks aimux again only once the figures are five minutes old', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([]));
    await clock.settle();
    expect(seen.runs).toHaveLength(1);

    await clock.advance(5 * 60_000);
    await $.session.measure(measure([]));
    await clock.settle();
    expect(seen.runs).toHaveLength(2);
  });

  test('warns once per window before it runs out, with its reset and the freest other subscription', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-04T15:50:00Z') });
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    const nearlySpent = { kind: 'five_hour', percentUsed: 92, resetsAt: '2026-10-04T18:00:00Z' };
    await $.session.measure(measure([nearlySpent]));
    await $.session.measure(measure([{ ...nearlySpent, percentUsed: 95 }]));

    // `busy` has the emptiest 5-hour window but a spent week; codex cannot take a claude session.
    expect(seen.toasts).toEqual([
      'dt has used 92% of its 5-hour window (resets in 2h 10m). Freest now: main (5h 13%, 7d 17%). '
        + 'When this one runs out, aimux will offer to move this conversation there.',
    ]);
  });

  test('names no subscription that has less room than this one', async ($, on) => {
    // main's 5-hour window is empty but its week is nearly gone: dt would outlast it.
    const clock = mock.clock(on);
    const tight = { fetchedAt: 0, profiles: { main: { cli: 'claude', status: { fiveHourPct: 5, weeklyPct: 99 } } } };
    const seen = launchedByAimux(on, ran(JSON.stringify(tight)));
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 91, resetsAt: 'r1' }, { kind: 'seven_day', percentUsed: 10 }]));
    expect(seen.toasts).toEqual(['dt has used 91% of its 5-hour window. No other claude subscription has more room right now.']);
  });

  test('waits for aimux before warning, and says so when aimux could not answer', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on, ran('', 1));
    await $.session.start(START);

    // The first reply can land before the first reading: no notice yet, none lost.
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 92, resetsAt: 'r1' }]));
    expect(seen.toasts).toEqual([]);

    await clock.settle();
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 93, resetsAt: 'r1' }]));
    expect(seen.toasts).toEqual(['dt has used 93% of its 5-hour window. aimux could not read the other subscriptions.']);
  });

  test('does not start a failing aimux after every response', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on, ran('', 1));
    await $.session.start(START);
    await clock.settle();

    for (let i = 0; i < 3; i++) {
      await $.session.measure(measure([]));
      await clock.settle();
    }
    expect(seen.runs).toHaveLength(1);
  });

  test('warns again about a window with no reset time once it eased back', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    for (const percentUsed of [92, 80, 93]) await $.session.measure(measure([{ kind: 'seven_day', percentUsed }]));
    expect(seen.toasts).toHaveLength(2);
  });

  test('once spent, puts /exit in the prompt, and running it tells aimux to move without asking', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 92, resetsAt: 'r1' }]));
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: 'r1' }]));
    expect(seen.filled).toEqual(['/exit']);
    expect(seen.toasts.at(-1)).toBe('dt is out of its 5-hour window. Press Enter to carry this conversation over to main (5h 13%, 7d 17%).');
    expect(seen.written).toEqual([]);

    await $.command.run(EXIT);
    expect(seen.written).toEqual([['/aimux/handoff/1', 'main']]);
  });

  test('leaves a draft alone when the window runs out', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on, undefined, 'half-written thought');
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: 'r1' }]));
    expect(seen.filled).toEqual([]);
    expect(seen.toasts.at(-1)).toContain('Run /exit to carry this conversation over to main');
  });

  test('an ordinary /exit moves nothing', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    await $.command.run(EXIT);
    expect(seen.written).toEqual([]);
  });

  test('never says the session it runs in needs a login', () => {
    // `old` read as expired before this session logged in; the session is the proof.
    const others = LIMITS.profiles;
    expect(cells({ current: 'old', others, live: null, now: 0 })[0]).toEqual({ name: 'old', isExpired: false, windows: [] });
    expect(cells({ current: 'old', others, live: { fiveHourPct: 3, weeklyPct: 1 }, now: 0 })[0]?.windows).toMatchObject([
      { label: '5h', pct: 3 },
      { label: '7d', pct: 1 },
    ]);
    expect(cells({ current: 'dt', others, live: null, now: 0 }).find((c) => c.name === 'old')?.isExpired).toBe(true);
  });

  test('says when a window near its limit resets, this session\'s included', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-04T15:50:00Z') });
    launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 84, resetsAt: '2026-10-04T16:30:00Z' }, { kind: 'seven_day', percentUsed: 14 }]));
    expect((await band($)).text).toContain('▸ dt (this session) 5h:84% (resets in 40m) 7d:14%  │');
  });

  test('a turn refused over the limit offers the move too, without waiting for 100%', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on, undefined, '', [{ kind: 'five_hour', percentUsed: 97, resetsAt: 'r1' }, { kind: 'seven_day', percentUsed: 30 }]);
    await $.session.start(START);
    await clock.settle();

    await $.classic.StopFailure({ error: 'rate_limit' });
    expect(seen.filled).toEqual(['/exit']);
    expect(seen.toasts.at(-1)).toContain('dt is out of its 5-hour window. Press Enter to carry this conversation over to main');

    await $.command.run(EXIT);
    expect(seen.written).toEqual([['/aimux/handoff/1', 'main']]);
  });

  test('a busy API is not a spent subscription', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on, undefined, '', [{ kind: 'five_hour', percentUsed: 40 }]);
    await $.session.start(START);
    await clock.settle();

    await $.classic.StopFailure({ error: 'rate_limit' });
    await $.classic.StopFailure({ error: 'overloaded' });
    expect(seen.filled).toEqual([]);
    expect(seen.toasts).toEqual([]);
  });

  test('/aimux prints every subscription with its reset times, read fresh', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    const answer = await $.command.run({ ...EXIT, command: 'aimux' });
    expect(seen.runs.at(-1)).toEqual(['node', '/aimux/dist/cli.js', 'status', '--json', '--max-age', '30']);
    expect(answer.text).toBe([
      'How much of each subscription is used',
      '▸ dt    5h 48% · 7d 12%  ← this session',
      '  main  5h 13% · 7d 17%',
      '  busy  5h 5% · 7d 100% (resets in 2d 3h)',
      '  cx    7d 25%',
      '  old   login expired — run: aimux run old',
    ].join('\n'));
  });

  test('/aimux says so when it could not read fresh figures', async ($, on) => {
    const clock = mock.clock(on);
    launchedByAimux(on, ran('', 1));
    await $.session.start(START);
    await clock.settle();

    const answer = await $.command.run({ ...EXIT, command: 'aimux' });
    expect(answer.text).toContain('▸ dt');
    expect(answer.text).toContain('aimux could not be reached just now');
  });

  test('the table is the same whoever reads it', () => {
    const view = { current: 'main', others: { main: LIMITS.profiles.main, down: { cli: 'claude', status: null } }, live: null, now: 0 };
    expect(table(view)).toBe([
      'How much of each subscription is used',
      '▸ main  5h 13% · 7d 17%  ← this session',
      '  down  no figures right now',
    ].join('\n'));
  });

  test('stays silent in a session aimux did not launch', async ($, on) => {
    const clock = mock.clock(on);
    engineBeneath(on);
    mock.env(on, {});
    let runs = 0;
    on('process.run', () => {
      runs++;
      return { value: ran('{}') };
    });

    await $.session.start(START);
    await clock.settle();
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 99 }]));

    expect(runs).toBe(0);

    // The mod passes the band on, and in a test nothing beneath it draws one.
    let drew = true;
    try {
      await band($);
    } catch {
      drew = false;
    }
    expect(drew).toBe(false);
  });
});

describe('aimux mod — moving on its own (continuation.auto_at)', () => {
  const AUTO = { AIMUX_AUTO_AT: '95' };
  const handoffFor = (profile: string, window: object) => JSON.stringify({ profile, auto: true, window });

  type Setup = {
    answer?: ReturnType<typeof ran>; draft?: string; windows?: SessionRateLimit[]; env?: Record<string, string>;
    agents?: { status: string }[]; refuseExit?: boolean;
  };

  /** A session aimux launched with auto_at 95, past its first reading of the others,
   *  with a turn under way. */
  async function started($: Engine, on: On, args: Setup = {}) {
    const clock = mock.clock(on, { now: Date.parse('2026-10-04T15:50:00Z') });
    const seen = launchedByAimux(on, args.answer, args.draft, args.windows, { ...AUTO, ...args.env }, args.agents, { refuseExit: args.refuseExit });
    await $.session.start(START);
    await clock.settle();
    await $.turn.start({ text: 'go on', turnId: 't1' });
    return { clock, seen };
  }

  test('at the line, says where it will go, and moves when the turn ends — never mid-turn', async ($, on) => {
    const { clock, seen } = await started($, on);
    const window = { kind: 'five_hour', percentUsed: 95.4, resetsAt: '2026-10-04T18:00:00Z' } as const;

    await $.session.measure(measure([window]));
    await clock.settle();
    expect(seen.toasts).toEqual([
      'dt has used 95% of its 5-hour window (resets in 2h 10m). Moving this conversation to main (5h 13%, 7d 17%) once this turn ends.',
    ]);
    expect(seen.written).toEqual([]);
    expect(seen.commands).toEqual([]);

    await $.classic.Stop(stop());
    await clock.settle();
    // Where, and the window as the session read it: aimux trusts that figure.
    expect(seen.written).toEqual([['/aimux/handoff/1', handoffFor('main', window)]]);
    expect(seen.commands).toEqual(['exit']);
    expect(seen.filled).toEqual([]);
  });

  test('below the line, it only warns — saying it will move rather than offer', async ($, on) => {
    const { clock, seen } = await started($, on);

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 92, resetsAt: 'r1' }]));
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.toasts).toEqual([
      'dt has used 92% of its 5-hour window. Freest now: main (5h 13%, 7d 17%). At 95%, aimux will move this conversation to whichever has the most room.',
    ]);
    expect(seen.commands).toEqual([]);
  });

  test('goes nowhere that is itself at the line, and says so once for both windows', async ($, on) => {
    // main is fine on 5h but at 96% of its week: it would move again after one turn.
    const tight = { fetchedAt: 0, profiles: { main: { cli: 'claude', status: { fiveHourPct: 5, weeklyPct: 96 } } } };
    const { clock, seen } = await started($, on, { answer: ran(JSON.stringify(tight)) });

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 95, resetsAt: 'r1' }, { kind: 'seven_day', percentUsed: 97, resetsAt: 'r2' }]));
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: 'r1' }, { kind: 'seven_day', percentUsed: 97, resetsAt: 'r2' }]));
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.toasts).toEqual(['dt has used 95% of its 5-hour window. No other claude subscription is below 95%, so this one carries on.']);
    expect(seen.commands).toEqual([]);
    expect(seen.written).toEqual([]);
  });

  test('says so honestly when aimux could not read the others', async ($, on) => {
    const { clock, seen } = await started($, on, { answer: ran('', 1) });

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: 'r1' }]));
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.toasts).toEqual(['dt has used 96% of its 5-hour window. aimux could not read the other subscriptions, so this one carries on.']);
    expect(seen.commands).toEqual([]);
  });

  for (const [what, args, stopped, toast] of [
    ['a background task', {}, stop(1), 'Not moving to main while 1 background task would stop with this session; trying again when a turn ends.'],
    ['a scheduled wakeup', {}, stop(0, 2), 'Not moving to main while 2 scheduled wakeups would stop with this session; trying again when a turn ends.'],
    ['a subagent waiting on its own work', { agents: [{ status: 'waiting' }] }, stop(), 'Not moving to main while 1 agent would stop with this session; trying again when a turn ends.'],
    ['a draft in the prompt', { draft: 'and then' }, stop(), 'Not moving to main over what you are typing; trying again when the next turn ends.'],
  ] as const) {
    test(`waits while ${what} would be lost, then moves at a later turn end`, async ($, on) => {
      const { clock, seen } = await started($, on, args as Setup);

      await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: 'r1' }]));
      await $.classic.Stop(stopped);
      await clock.settle();
      expect(seen.commands).toEqual([]);
      expect(seen.written).toEqual([]);
      expect(seen.toasts.at(-1)).toBe(toast);

      // Nothing in the way any more.
      seen.agents.length = 0;
      seen.draft = '';
      await $.classic.Stop(stop());
      await clock.settle();
      expect(seen.commands).toEqual(['exit']);
    });
  }

  test('a window that eased back under the line cancels the move', async ($, on) => {
    const { clock, seen } = await started($, on);

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: 'r1' }]));
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 3, resetsAt: 'r2' }]));
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.commands).toEqual([]);
  });

  test('an interrupted turn is not the moment: the person is there, about to type', async ($, on) => {
    const { clock, seen } = await started($, on);
    const turn = { answer: '', durationMs: 1, turnId: 't1' };

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: 'r1' }]));
    await $.turn.complete({ ...turn, isAborted: true, reason: 'aborted' });
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.commands).toEqual([]);

    await $.turn.complete({ ...turn, isAborted: false, reason: 'answer' });
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.commands).toEqual(['exit']);
  });

  test('a turn\'s last figures arriving after its Stop move it at once, not a turn later', async ($, on) => {
    const { clock, seen } = await started($, on);

    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.commands).toEqual([]);

    await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 96, resetsAt: 'w1' }]));
    await clock.settle();
    expect(seen.commands).toEqual(['exit']);
    expect(seen.toasts).toEqual(['dt has used 96% of its weekly window. Moving this conversation to main (5h 13%, 7d 17%).']);
  });

  test('two turn ends in a row make one move', async ($, on) => {
    const { clock, seen } = await started($, on);

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: 'r1' }]));
    await $.classic.Stop(stop());
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.written).toHaveLength(1);
    expect(seen.commands).toEqual(['exit']);
  });

  test('an exit the engine will not run empties the handoff and offers the move instead', async ($, on) => {
    const { clock, seen } = await started($, on, { refuseExit: true });

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: 'r1' }]));
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.written.map(([, text]) => text).at(-1)).toBe('');
    expect(seen.filled).toEqual(['/exit']);
    expect(seen.toasts.at(-1)).toBe('Press Enter to move this conversation to main.');
  });

  test('never moves again on a window aimux already found nowhere to move it on', async ($, on) => {
    const { clock, seen } = await started($, on, { env: { AIMUX_AUTO_HOLD: 'five_hour:r1' } });

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 97, resetsAt: 'r1' }]));
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.commands).toEqual([]);

    // The weekly window crossing the line is a new window: that one moves.
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 97, resetsAt: 'r1' }, { kind: 'seven_day', percentUsed: 95, resetsAt: 'w1' }]));
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.commands).toEqual(['exit']);
  });

  test('a window spent on a response moves anywhere with room, at the turn end', async ($, on) => {
    // main is past the line on its week, but has room: a spent window takes it.
    const tight = { fetchedAt: 0, profiles: { main: { cli: 'claude', status: { fiveHourPct: 5, weeklyPct: 97 } } } };
    const { clock, seen } = await started($, on, { answer: ran(JSON.stringify(tight)) });

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: 'r1' }]));
    await clock.settle();
    expect(seen.commands).toEqual([]);
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.commands).toEqual(['exit']);
  });

  test('a turn refused over the limit moves straight away', async ($, on) => {
    const { clock, seen } = await started($, on, { windows: [{ kind: 'five_hour', percentUsed: 99, resetsAt: 'r1' }] });

    await $.classic.StopFailure({ error: 'rate_limit' });
    await clock.settle();
    expect(seen.written).toEqual([['/aimux/handoff/1', handoffFor('main', { kind: 'five_hour', percentUsed: 99, resetsAt: 'r1' })]]);
    expect(seen.commands).toEqual(['exit']);
  });

  test('a refused turn with background work left running offers the move instead', async ($, on) => {
    const { clock, seen } = await started($, on, { windows: [{ kind: 'five_hour', percentUsed: 99, resetsAt: 'r1' }] });
    await $.classic.Stop(stop(1));

    await $.classic.StopFailure({ error: 'rate_limit' });
    await clock.settle();
    expect(seen.commands).toEqual([]);
    expect(seen.filled).toEqual(['/exit']);
  });

  test('sends the resume prompt aimux set, once, as the person', async ($, on) => {
    const { clock, seen } = await started($, on, { env: { AIMUX_RESUME_PROMPT: 'Continue where you left off.' } });
    await $.session.start(START);
    await clock.settle();
    expect(seen.submitted).toEqual(['Continue where you left off.']);
  });

  test('without auto_at nothing moves on its own, and nothing is sent', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on, undefined, '', [], { AIMUX_AUTO_AT: '', AIMUX_RESUME_PROMPT: '' });
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 97, resetsAt: 'r1' }]));
    await $.classic.Stop(stop());
    await clock.settle();
    expect(seen.commands).toEqual([]);
    expect(seen.written).toEqual([]);
    expect(seen.submitted).toEqual([]);
  });
});
