import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import type { RateLimitProbe } from './limits.js';
import { continuationArgs, planContinuation, runWithContinuation, sessionIdFromArgs, type ContinuationPlan, type RunDeps } from './continuation.js';
import { resetAimuxDir, setAimuxDir } from './paths.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aimux-continue-'));
  // The early path refreshes the shared limits reading: keep it out of the real ~/.aimux.
  setAimuxDir(join(root, 'aimux'));
  mkdirSync(join(root, 'aimux'), { recursive: true });
});
afterEach(() => { resetAimuxDir(); rmSync(root, { recursive: true, force: true }); });

const source = () => join(root, 'claude');
const profileDir = (name: string) => join(root, 'profiles', name);

function config(): AimuxConfig {
  const profiles: AimuxConfig['profiles'] = { main: { cli: 'claude', path: source(), is_source: true } };
  for (const name of ['work', 'spare', 'busy']) {
    mkdirSync(profileDir(name), { recursive: true });
    writeFileSync(join(profileDir(name), '.credentials.json'), '{}');
    profiles[name] = { cli: 'claude', path: profileDir(name) };
  }
  mkdirSync(profileDir('cx'), { recursive: true });
  writeFileSync(join(profileDir('cx'), 'auth.json'), '{}');
  profiles.cx = { cli: 'codex', path: profileDir('cx') };
  return { version: 1, shared_source: source(), private: [], profiles };
}

/** A session `work` ran, whose transcript ends on the given record. */
function sessionEndingWith(record: unknown) {
  mkdirSync(join(profileDir('work'), 'session-env', 'sess-1'), { recursive: true });
  mkdirSync(join(source(), 'projects', '-home-me-app'), { recursive: true });
  writeFileSync(join(source(), 'projects', '-home-me-app', 'sess-1.jsonl'), JSON.stringify(record) + '\n');
}

const FAR_FUTURE = 4102444800; // 2100-01-01, epoch seconds
const quotaHit = {
  type: 'assistant',
  error: 'rate_limit',
  quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: FAR_FUTURE },
  message: { model: '<synthetic>', role: 'assistant', content: [] },
};

const status = (five: number, week: number): RateLimitProbe => ({ status: { fiveHourPct: five, weeklyPct: week } });

describe('planContinuation', () => {
  it('offers the freest other claude subscription for a session that hit its limit', async () => {
    sessionEndingWith(quotaHit);
    const probed: string[] = [];
    const probe = async (_p: unknown, path: string) => {
      probed.push(path);
      return path.endsWith('spare') ? status(10, 20) : status(95, 40);
    };

    const plan = await planContinuation(config(), 'work', { since: 0 }, probe);

    expect(plan?.sessionId).toBe('sess-1');
    expect(plan?.hit.rateLimitType).toBe('five_hour');
    expect(plan?.next?.profile).toBe('spare');
    // Never the profile that just ran out, and never a different CLI.
    expect(probed.some((p) => p.endsWith('work') || p.endsWith('cx'))).toBe(false);
  });

  it('says so when no other subscription has room', async () => {
    sessionEndingWith(quotaHit);
    const plan = await planContinuation(config(), 'work', { since: 0 }, async () => status(100, 50));
    expect(plan?.sessionId).toBe('sess-1');
    expect(plan?.next).toBeNull();
  });

  it('offers nothing when the window already reset while the session sat idle', async () => {
    // The same subscription has room again — there is nothing to move.
    sessionEndingWith({ ...quotaHit, quotaLimits: { ...quotaHit.quotaLimits, resetsAt: 1_000_000 } });
    let calls = 0;
    const plan = await planContinuation(config(), 'work', { since: 0 }, async () => { calls++; return status(0, 0); });
    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });

  it('ignores a hit an earlier run left in the transcript', async () => {
    // A session continued elsewhere still ends on the old hit until someone replies in it:
    // opening it and quitting at once must not be read as the new profile running out.
    sessionEndingWith({ ...quotaHit, timestamp: new Date(1_000_000).toISOString() });
    const plan = await planContinuation(config(), 'work', { since: 2_000_000 }, async () => status(0, 0));
    expect(plan).toBeNull();
  });

  it('offers nothing — and probes nothing — for a session that did not hit a limit', async () => {
    sessionEndingWith({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [] } });
    let calls = 0;
    const plan = await planContinuation(config(), 'work', { since: 0 }, async () => { calls++; return status(0, 0); });
    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('planContinuation — moving early (continuation.auto_at)', () => {
  const ordinaryEnd = { type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [] } };
  const byProfile = (figures: Record<string, RateLimitProbe>) =>
    async (_p: unknown, path: string) => figures[path.split('/').at(-1) ?? ''] ?? status(0, 0);

  it('moves a session with no spent window once the mod ended it at the line', async () => {
    sessionEndingWith(ordinaryEnd);
    const probe = byProfile({ work: status(96, 40), spare: status(10, 20), busy: status(50, 97), claude: status(60, 60) });

    const plan = await planContinuation(config(), 'work', { since: 0 }, probe, Date.now(), { autoAt: 95 });

    expect(plan?.sessionId).toBe('sess-1');
    expect(plan?.early).toBe(96);
    expect(plan?.hit.rateLimitType).toBe('five_hour');
    // busy has the emptiest 5-hour window but sits past the line on its week.
    expect(plan?.next?.profile).toBe('spare');
  });

  it('offers nowhere that is itself at the line', async () => {
    sessionEndingWith(ordinaryEnd);
    const probe = byProfile({ work: status(96, 40), spare: status(95, 1), busy: status(1, 99), claude: status(100, 0) });
    const plan = await planContinuation(config(), 'work', { since: 0 }, probe, Date.now(), { autoAt: 95 });
    expect(plan?.next).toBeNull();
  });

  it('stays when a fresh reading has this subscription back under the line', async () => {
    sessionEndingWith(ordinaryEnd);
    const probe = byProfile({ work: status(4, 40), spare: status(10, 20) });
    expect(await planContinuation(config(), 'work', { since: 0 }, probe, Date.now(), { autoAt: 95 })).toBeNull();
  });

  it('still moves nothing early unless the mod asked for it', async () => {
    sessionEndingWith(ordinaryEnd);
    let calls = 0;
    const plan = await planContinuation(config(), 'work', { since: 0 }, async () => { calls++; return status(99, 99); });
    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });

  it('leaves the reading every session shares fresh', async () => {
    sessionEndingWith(ordinaryEnd);
    const now = Date.now();
    await planContinuation(config(), 'work', { since: 0 }, byProfile({ work: status(96, 1) }), now, { autoAt: 95 });
    const cached = JSON.parse(readFileSync(join(root, 'aimux', 'limits-cache.json'), 'utf-8'));
    expect(cached.fetchedAt).toBe(now);
    expect(cached.profiles.work.status.fiveHourPct).toBe(96);
  });
});

describe('planContinuation — which session', () => {
  const writeSession = (id: string, record: unknown) => {
    mkdirSync(join(profileDir('work'), 'session-env', id), { recursive: true });
    mkdirSync(join(source(), 'projects', '-home-me-app'), { recursive: true });
    writeFileSync(join(source(), 'projects', '-home-me-app', `${id}.jsonl`), JSON.stringify(record) + '\n');
  };
  const normal = { type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [] } };
  const pause = () => new Promise((r) => setTimeout(r, 30));

  it('checks the session it launched, not a newer one another terminal started under the same profile', async () => {
    writeSession('mine', quotaHit);
    await pause();
    writeSession('theirs', normal); // newer marker, newer transcript — but not ours
    const plan = await planContinuation(config(), 'work', { id: 'mine', since: 0 }, async () => status(10, 10));
    expect(plan?.sessionId).toBe('mine');
  });

  it('finds a resumed older session by its transcript being written since launch', async () => {
    // `aimux run work --continue`: the marker predates the launch, the transcript does not.
    writeSession('older', normal);
    await pause();
    const since = Date.now();
    await pause();
    writeSession('older', quotaHit);
    const plan = await planContinuation(config(), 'work', { since }, async () => status(10, 10));
    expect(plan?.sessionId).toBe('older');
  });
});

describe('continuationArgs', () => {
  it('keeps the flags the session was started with', () => {
    expect(continuationArgs(['--dangerously-skip-permissions', '--add-dir', '../lib', '--permission-mode', 'plan'], 's1'))
      .toEqual(['--dangerously-skip-permissions', '--add-dir', '../lib', '--permission-mode', 'plan', '--resume', 's1']);
  });

  it('drops whatever picked the old session, so only the new --resume decides', () => {
    expect(continuationArgs(['--resume', 'old', '--verbose'], 's1')).toEqual(['--verbose', '--resume', 's1']);
    expect(continuationArgs(['--resume=old'], 's1')).toEqual(['--resume', 's1']);
    expect(continuationArgs(['-r', 'old'], 's1')).toEqual(['--resume', 's1']);
    expect(continuationArgs(['--resume', '--verbose'], 's1')).toEqual(['--verbose', '--resume', 's1']);
    expect(continuationArgs(['--continue', '--fork-session'], 's1')).toEqual(['--resume', 's1']);
    expect(continuationArgs(['-c'], 's1')).toEqual(['--resume', 's1']);
    expect(continuationArgs(['--session-id', 'abc', '--verbose'], 's1')).toEqual(['--verbose', '--resume', 's1']);
    expect(continuationArgs(['--from-pr', '123', '--verbose'], 's1')).toEqual(['--verbose', '--resume', 's1']);
    expect(continuationArgs(['--teleport'], 's1')).toEqual(['--resume', 's1']);
  });

  it('does not send the opening prompt a second time', () => {
    expect(continuationArgs(['fix the login bug', '--add-dir', 'x'], 's1')).toEqual(['--add-dir', 'x', '--resume', 's1']);
  });
});

describe('sessionIdFromArgs', () => {
  const ID = '0f2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b';

  it('reads the session a launch names', () => {
    expect(sessionIdFromArgs(['--resume', ID])).toBe(ID);
    expect(sessionIdFromArgs(['-r', ID, '--verbose'])).toBe(ID);
    expect(sessionIdFromArgs([`--resume=${ID}`])).toBe(ID);
    expect(sessionIdFromArgs(['--session-id', ID])).toBe(ID);
  });

  it('does not take a picker search term for a session id', () => {
    // `claude --resume auth-bug` opens the picker filtered by "auth-bug".
    expect(sessionIdFromArgs(['--resume', 'auth-bug'])).toBeUndefined();
  });

  it('knows no id when --fork-session moves the conversation to a new one', () => {
    expect(sessionIdFromArgs(['--resume', ID, '--fork-session'])).toBeUndefined();
  });

  it('knows no id when the launch leaves the choice to claude', () => {
    expect(sessionIdFromArgs(['--continue'])).toBeUndefined();
    expect(sessionIdFromArgs(['--resume'])).toBeUndefined();
    expect(sessionIdFromArgs([])).toBeUndefined();
  });
});

describe('runWithContinuation', () => {
  const HIT: ContinuationPlan['hit'] = { rateLimitType: 'five_hour', resetsAt: FAR_FUTURE * 1000 };
  const room = (profile: string) => ({ profile, status: { fiveHourPct: 10, weeklyPct: 20 } });

  /** A run whose launches exit with `codes` in turn, and whose sessions hit a limit per `plans`. */
  function scripted(
    plans: Array<ContinuationPlan | null>,
    opts: { answer?: boolean; agreed?: string[]; codes?: number[]; auto?: boolean[] } = {},
  ) {
    const seen = {
      launches: [] as Array<[string, string[]]>, held: [] as boolean[], prepared: [] as string[], asked: [] as string[], said: [] as string[],
    };
    const deps: RunDeps = {
      prepare: (profile) => { seen.prepared.push(profile); },
      launch: async (profile, args, launchOpts) => {
        const n = seen.launches.push([profile, args]) - 1;
        seen.held.push(launchOpts?.holdAuto === true);
        return { code: opts.codes?.[n] ?? 0, since: n, sessionId: `s${n}`, moveAgreed: opts.agreed?.[n], autoMoved: opts.auto?.[n] };
      },
      plan: async () => plans.shift() ?? null,
      ask: (question) => { seen.asked.push(question); return opts.answer ?? true; },
      say: (line) => { seen.said.push(line); },
    };
    return { seen, deps };
  }

  it('runs once and hands back the exit code when no limit was hit', async () => {
    const { seen, deps } = scripted([null], { codes: [3] });
    expect(await runWithContinuation('work', ['--verbose'], true, deps)).toBe(3);
    expect(seen.launches).toEqual([['work', ['--verbose']]]);
    expect(seen.asked).toEqual([]);
  });

  it('asks, then resumes the same session on the freest subscription with the user\'s flags', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare') }, null], { codes: [0, 7] });

    expect(await runWithContinuation('work', ['--add-dir', 'x'], true, deps)).toBe(7);
    expect(seen.asked).toHaveLength(1);
    expect(seen.asked[0]).toContain('work hit its 5-hour limit');
    expect(seen.asked[0]).toContain('Continue this session on spare (5h 10%, 7d 20%)? [Y/n]');
    expect(seen.launches).toEqual([['work', ['--add-dir', 'x']], ['spare', ['--add-dir', 'x', '--resume', 'abc']]]);
    expect(seen.prepared).toEqual(['work', 'spare']);
  });

  it('stops when the user says no', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare') }], { answer: false, codes: [5] });
    expect(await runWithContinuation('work', [], true, deps)).toBe(5);
    expect(seen.launches).toHaveLength(1);
  });

  it('moves without asking when the person already agreed inside claude', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare') }, null], { agreed: ['spare'] });
    await runWithContinuation('work', [], true, deps);

    expect(seen.asked).toEqual([]);
    expect(seen.said.join('\n')).toContain('Continuing this session on spare (5h 10%, 7d 20%).');
    expect(seen.launches.map(([profile]) => profile)).toEqual(['work', 'spare']);
  });

  it('says how to carry on when the person agreed to move but no spent limit was recorded', async () => {
    // The mod offered the move after a refused turn; the transcript shows no spent window,
    // so aimux does not move on its own — but it must not just exit without a word.
    const { seen, deps } = scripted([null], { agreed: ['spare'], codes: [4] });

    expect(await runWithContinuation('work', [], true, deps)).toBe(4);
    expect(seen.launches).toHaveLength(1);
    expect(seen.said.join('\n')).toContain('aimux run spare --resume s0');
  });

  it('says so and stops when no other subscription has room', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: null }]);
    await runWithContinuation('work', [], true, deps);

    expect(seen.said.join('\n')).toContain('no other claude subscription has room right now');
    expect(seen.launches).toHaveLength(1);
    expect(seen.asked).toEqual([]);
  });

  it('keeps moving when the next subscription runs out too', async () => {
    const { seen, deps } = scripted([
      { sessionId: 'abc', hit: HIT, next: room('spare') },
      { sessionId: 'abc', hit: HIT, next: room('third') },
      null,
    ]);
    await runWithContinuation('work', ['-c'], true, deps);

    // Whatever picked the old session is dropped each time; only the new --resume decides.
    expect(seen.launches).toEqual([['work', ['-c']], ['spare', ['--resume', 'abc']], ['third', ['--resume', 'abc']]]);
  });

  it('never looks for a limit when the launch has no conversation to carry on', async () => {
    let planned = 0;
    const { seen, deps } = scripted([]);
    deps.plan = async () => { planned++; return null; };

    expect(await runWithContinuation('work', ['-p', 'hi'], false, deps)).toBe(0);
    expect(planned).toBe(0);
    expect(seen.launches).toHaveLength(1);
  });
});

describe('runWithContinuation — moving on its own', () => {
  const room = (profile: string) => ({ profile, status: { fiveHourPct: 10, weeklyPct: 20 } });

  function scripted(plans: Array<ContinuationPlan | null>, auto: boolean[]) {
    const seen = { launches: [] as Array<[string, string[]]>, held: [] as boolean[], asked: [] as string[], said: [] as string[] };
    const deps: RunDeps = {
      prepare: () => {},
      launch: async (profile, args, launchOpts) => {
        const n = seen.launches.push([profile, args]) - 1;
        seen.held.push(launchOpts?.holdAuto === true);
        return { code: 0, since: n, sessionId: `s${n}`, autoMoved: auto[n] };
      },
      plan: async () => plans.shift() ?? null,
      ask: (question) => { seen.asked.push(question); return true; },
      say: (line) => { seen.said.push(line); },
    };
    return { seen, deps };
  }

  it('moves without asking, saying how full the old window was', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: { rateLimitType: 'seven_day' }, next: room('spare'), early: 95.6 }, null], [true]);
    await runWithContinuation('work', ['--add-dir', 'x'], true, deps);

    expect(seen.asked).toEqual([]);
    expect(seen.said.join('\n')).toContain('work has used 96% of its weekly window. Continuing this session on spare (5h 10%, 7d 20%).');
    expect(seen.launches).toEqual([['work', ['--add-dir', 'x']], ['spare', ['--add-dir', 'x', '--resume', 'abc']]]);
    expect(seen.held).toEqual([false, false]);
  });

  it('resumes where it was, with auto held, when nowhere has more room', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: { rateLimitType: 'five_hour' }, next: null, early: 96 }, null], [true, false]);
    await runWithContinuation('work', [], true, deps);

    expect(seen.said.join('\n')).toContain('no other claude subscription has more room, so it stays on work. Resuming it.');
    expect(seen.launches).toEqual([['work', []], ['work', ['--resume', 'abc']]]);
    expect(seen.held).toEqual([false, true]);
  });

  it('resumes where it was when a fresh reading has room again', async () => {
    const { seen, deps } = scripted([null, null], [true, false]);
    await runWithContinuation('work', [], true, deps);

    expect(seen.said.join('\n')).toContain('work has room again, so it stays there. Resuming it.');
    expect(seen.launches).toEqual([['work', []], ['work', ['--resume', 's0']]]);
    expect(seen.held).toEqual([false, true]);
  });
});

describe('runWithContinuation — picking the work up again', () => {
  const room = (profile: string) => ({ profile, status: { fiveHourPct: 10, weeklyPct: 20 } });
  const HIT: ContinuationPlan['hit'] = { rateLimitType: 'five_hour' };

  function scripted(plans: Array<ContinuationPlan | null>, run: { agreed?: string; auto?: boolean } = {}) {
    const launches: Array<[string, string[]]> = [];
    const deps: RunDeps = {
      prepare: () => {},
      launch: async (profile, args) => {
        const n = launches.push([profile, args]) - 1;
        return { code: 0, since: n, sessionId: `s${n}`, moveAgreed: n === 0 ? run.agreed : undefined, autoMoved: n === 0 && run.auto };
      },
      plan: async () => plans.shift() ?? null,
      ask: () => true,
      say: () => {},
      resumePrompt: 'Continue where you left off.',
    };
    return { launches, deps };
  }

  it('tells a session whose turn the spent window cut short to carry on, however the move was agreed', async () => {
    for (const run of [{}, { agreed: 'spare' }, { auto: true }]) {
      const { launches, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare') }, null], run);
      await runWithContinuation('work', ['--add-dir', 'x'], true, deps);
      expect(launches[1]).toEqual(['spare', ['--add-dir', 'x', '--resume', 'abc', 'Continue where you left off.']]);
    }
  });

  it('sends nothing after an early move: that one happened between turns', async () => {
    const { launches, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare'), early: 96 }, null], { auto: true });
    await runWithContinuation('work', [], true, deps);
    expect(launches[1]).toEqual(['spare', ['--resume', 'abc']]);
  });

  it('sends nothing when the session resumes where it was', async () => {
    const { launches, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: null, early: 96 }, null], { auto: true });
    await runWithContinuation('work', [], true, deps);
    expect(launches[1]).toEqual(['work', ['--resume', 'abc']]);
  });

  it('sends nothing when no prompt is configured', async () => {
    const { launches, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare') }, null]);
    deps.resumePrompt = undefined;
    await runWithContinuation('work', [], true, deps);
    expect(launches[1]).toEqual(['spare', ['--resume', 'abc']]);
  });
});
