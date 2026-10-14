import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';
import {
  fetchRateLimits, fmtPct, formatResetAt, limitsSnapshot, pickFreestProfile, rateLimitProfiles,
  type RateLimitProbe, type RateLimitStatus,
} from './limits.js';
import { findTranscript, sessionQuotaHit, sessionTouchedSince, type QuotaHit } from './sessionMarkers.js';

export interface ContinuationPlan {
  sessionId: string;
  hit: QuotaHit;
  /** The freest other claude subscription, or null when none has room. */
  next: { profile: string; status: RateLimitStatus } | null;
  /** Set when the session moves before its window is spent (`continuation.auto_at`):
   *  how much of that window it had used, in percent. */
  early?: number;
}

/**
 * After an interactive claude session exits: did it stop because its subscription ran
 * out, and if so, where can it carry on?
 *
 * The transcript is shared, so the same session resumes under any profile — only the
 * login changes. Detection is local (Claude Code records the exhausted window in the
 * transcript), so an ordinary exit costs no network; only a real hit probes the other
 * profiles to rank them.
 */
export async function planContinuation(
  config: AimuxConfig,
  profileName: string,
  /** The session this launch ended on, when aimux knows it (followed from claude's own
   *  record of the process, or named in the args); otherwise the one this profile wrote
   *  to since `since`. */
  session: { id?: string; since: number },
  probe: (profile: ProfileConfig, profilePath: string) => Promise<RateLimitProbe> = fetchRateLimits,
  now: number = Date.now(),
  /** `autoAt`: the mod ended the session on its own as a window crossed this percentage
   *  (`continuation.auto_at`), so a session with no spent window may still move. */
  options: { autoAt?: number } = {},
): Promise<ContinuationPlan | null> {
  const profile = getProfile(config, profileName);
  if ((profile.cli ?? 'claude') !== 'claude') return null;

  const sessionId = session.id ?? sessionTouchedSince(config, expandHome(profile.path), session.since);
  const transcript = sessionId ? findTranscript(config, sessionId) : null;
  const recorded = transcript ? sessionQuotaHit(transcript) : null;
  // A hit left by an earlier run (the session was continued here after it and nobody
  // has replied since), or one whose window reset while the session sat idle: this
  // subscription did not run out, or has room again.
  const hit = recorded
    && !(recorded.at !== undefined && recorded.at < session.since)
    && !(recorded.resetsAt !== undefined && recorded.resetsAt <= now)
    ? recorded
    : null;
  if (!sessionId) return null;
  if (!hit) return options.autoAt === undefined ? null : planEarly(config, profileName, sessionId, options.autoAt, probe, now);

  const others = rateLimitProfiles(config.profiles)
    .filter((name) => name !== profileName && (config.profiles[name].cli ?? 'claude') === 'claude');
  const probes = new Map(await Promise.all(others.map(async (name) => {
    const p = config.profiles[name];
    return [name, await probe(p, expandHome(p.path))] as const;
  })));

  const freest = pickFreestProfile(probes);
  const status = freest ? probes.get(freest)?.status : null;

  return { sessionId, hit, next: freest && status ? { profile: freest, status } : null };
}

/**
 * Moving before the window is spent: read every subscription fresh — which also
 * refreshes the reading every open session shares, so a mod that just ended this one
 * on an older figure sees the new one — and move only if this subscription is still at
 * `autoAt` or past it, and only to one whose every window is below it. Anywhere fuller
 * would end its session the same way after one turn.
 */
async function planEarly(
  config: AimuxConfig,
  profileName: string,
  sessionId: string,
  autoAt: number,
  probe: (profile: ProfileConfig, profilePath: string) => Promise<RateLimitProbe>,
  now: number,
): Promise<ContinuationPlan | null> {
  const { profiles } = await limitsSnapshot(config, 0, now, probe);

  const own = profiles[profileName]?.status;
  const windows = [
    { rateLimitType: 'five_hour', pct: own?.fiveHourPct, resetsAt: own?.fiveHourResetsAt },
    { rateLimitType: 'seven_day', pct: own?.weeklyPct, resetsAt: own?.weeklyResetsAt },
  ].filter((w): w is { rateLimitType: string; pct: number; resetsAt: number | undefined } => typeof w.pct === 'number');
  const tightest = windows.sort((a, b) => b.pct - a.pct)[0];
  // Eased back under the line (a window reset since), or no figures: stay.
  if (!tightest || tightest.pct < autoAt) return null;

  const below = new Map(Object.entries(profiles)
    .filter(([name, p]) => name !== profileName && p.cli === 'claude' && p.status
      && Math.max(p.status.fiveHourPct ?? 0, p.status.weeklyPct ?? 0) < autoAt));
  const freest = pickFreestProfile(below);
  const status = freest ? below.get(freest)?.status : null;

  return {
    sessionId,
    hit: { rateLimitType: tightest.rateLimitType, resetsAt: tightest.resetsAt },
    next: freest && status ? { profile: freest, status } : null,
    early: tightest.pct,
  };
}

// The flags that choose which session claude opens. A continuation replaces them with
// its own `--resume <id>`; everything else the user passed comes along.
const SELECTOR_WITH_VALUE = new Set(['--session-id']);
const SELECTOR_OPTIONAL_VALUE = new Set(['--resume', '-r', '--from-pr', '--teleport']);
const SELECTOR_BARE = new Set(['--continue', '-c', '--fork-session']);
const SELECTOR_INLINE = /^--(resume|session-id|from-pr|teleport)=/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const takesValue = (args: string[], i: number) => args[i + 1] !== undefined && !args[i + 1].startsWith('-');

/**
 * The session id the args name (`--resume <id>`, `--session-id <id>`), if they name one.
 * Only a real session id counts — `--resume auth-bug` is a picker search — and none with
 * `--fork-session`, which moves the conversation to a new id.
 */
export function sessionIdFromArgs(args: string[]): string | undefined {
  if (args.includes('--fork-session')) return undefined;

  for (let i = 0; i < args.length; i++) {
    const inline = args[i].match(/^--(?:resume|session-id)=(.+)$/)?.[1];
    const next = (args[i] === '--resume' || args[i] === '-r' || args[i] === '--session-id') && takesValue(args, i)
      ? args[i + 1]
      : undefined;
    const id = inline ?? next;
    if (id && UUID.test(id)) return id;
  }
  return undefined;
}

/**
 * The args to carry a session over to another subscription: the user's own flags
 * (permissions, extra dirs, MCP config, …) plus `--resume <id>`. Whatever picked the old
 * session is dropped, and so is a leading prompt, which would otherwise be sent again.
 */
export function continuationArgs(original: string[], sessionId: string): string[] {
  // ponytail: a prompt placed after other flags looks like a flag's value and is kept;
  // telling them apart needs claude's own flag table.
  const kept: string[] = [];
  for (let i = 0; i < original.length; i++) {
    const arg = original[i];
    if (i === 0 && !arg.startsWith('-')) continue;
    if (SELECTOR_BARE.has(arg) || SELECTOR_INLINE.test(arg)) continue;
    if (SELECTOR_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (SELECTOR_OPTIONAL_VALUE.has(arg)) {
      if (takesValue(original, i)) i++;
      continue;
    }
    kept.push(arg);
  }
  return [...kept, '--resume', sessionId];
}

/** One launch of the CLI: how it exited and which session it ended on. */
export interface LaunchResult {
  code: number;
  /** When the launch began, for telling this run's hit from an earlier one's. */
  since: number;
  sessionId?: string;
  /** The subscription the person already agreed to move to, inside claude (the mod's
   *  `/exit`); absent when they did not. */
  moveAgreed?: string;
  /** The mod ended the session on its own (`continuation.auto_at`): nobody is there to
   *  ask, and the session must carry on somewhere — here, if nowhere has more room. */
  autoMoved?: boolean;
}

/** What the loop needs from the outside world — the CLI wires the real ones. */
export interface RunDeps {
  /** Everything a profile needs right before the CLI starts under it. */
  prepare(profile: string): void;
  /** `holdAuto`: this launch resumes a session the mod just tried to move and could not —
   *  the mod must not try again in it, or a figure the two read differently would end the
   *  session after every turn. */
  launch(profile: string, args: string[], opts?: { holdAuto?: boolean }): Promise<LaunchResult>;
  plan(profile: string, session: { id?: string; since: number; autoMoved?: boolean }): Promise<ContinuationPlan | null>;
  ask(question: string): boolean;
  say(line: string): void;
}

/** Claude's window names, in the words its own status line uses. */
function describeWindow(rateLimitType: string | undefined): string {
  if (rateLimitType === 'five_hour') return '5-hour';
  if (rateLimitType?.startsWith('seven_day')) return 'weekly';
  return 'usage';
}

/**
 * Run the CLI under a profile and, each time its session stops on a spent window,
 * carry that same session over to the subscription with the most room — asking first,
 * unless the person already agreed inside claude. Returns the last launch's exit code.
 *
 * `continuable`: an interactive claude session. A subcommand or `-p` run has no
 * conversation to carry on, and without a terminal there is nobody to ask.
 */
export async function runWithContinuation(
  profile: string,
  cliArgs: string[],
  continuable: boolean,
  deps: RunDeps,
): Promise<number> {
  let current = profile;
  deps.prepare(current);
  let run = await deps.launch(current, cliArgs);

  while (continuable) {
    const plan = await deps.plan(current, { id: run.sessionId, since: run.since, autoMoved: run.autoMoved });

    // The mod ended the session to move it, and there is nowhere better to go: the
    // session carries on where it was rather than leave the person at a shell.
    if (run.autoMoved && (!plan || !plan.next)) {
      const sessionId = plan?.sessionId ?? run.sessionId;
      const why = plan
        ? `no other claude subscription has more room, so it stays on ${current}`
        : `${current} has room again, so it stays there`;
      if (!sessionId) {
        deps.say(`\naimux ended this session to move it, but ${why} — and could not tell which session it was.`
          + ` To carry it on: aimux run ${current} --continue`);
        break;
      }
      deps.say(`\naimux ended this session to move it, but ${why}. Resuming it.`);
      deps.prepare(current);
      run = await deps.launch(current, continuationArgs(cliArgs, sessionId), { holdAuto: true });
      continue;
    }

    if (!plan) {
      // They pressed Enter on an offer to move, but the transcript records no spent
      // window (a busy API, or a window that reset meanwhile): aimux moves nothing on
      // its own account — and says how to, rather than exit without a word.
      if (run.moveAgreed) {
        const resume = run.sessionId ? `--resume ${run.sessionId}` : '--continue';
        deps.say(`\naimux found no spent limit recorded for this session, so it stays on ${current}.`
          + ` To carry it on elsewhere: aimux run ${run.moveAgreed} ${resume}`);
      }
      break;
    }

    const resets = plan.hit.resetsAt ? ` (resets ${formatResetAt(plan.hit.resetsAt)})` : '';
    const window = describeWindow(plan.hit.rateLimitType);
    const hitLine = plan.early === undefined
      ? `\n⚠ ${current} hit its ${window} limit${resets}`
      : `\n⚠ ${current} has used ${Math.round(plan.early)}% of its ${window} window${resets}`;
    if (!plan.next) {
      deps.say(`${hitLine}, and no other claude subscription has room right now.`);
      break;
    }

    const { fiveHourPct, weeklyPct } = plan.next.status;
    const where = `${plan.next.profile} (5h ${fmtPct(fiveHourPct)}, 7d ${fmtPct(weeklyPct)})`;
    if (run.moveAgreed || run.autoMoved) {
      deps.say(`${hitLine}. Continuing this session on ${where}.`);
    } else if (!deps.ask(`${hitLine}.\nContinue this session on ${where}? [Y/n] `)) {
      break;
    }

    current = plan.next.profile;
    deps.prepare(current);
    run = await deps.launch(current, continuationArgs(cliArgs, plan.sessionId));
  }

  return run.code;
}
