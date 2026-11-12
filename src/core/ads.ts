/**
 * Guessing that a tile is playing an ad.
 *
 * No embed API reports ads (Twitch and YouTube don't, Kick has no API at all), so Regie reads the
 * signals it has: the player says it plays but its clock stops, it pauses or stalls with no user
 * action, or the user presses `A`. The verdict holds until playback is clearly back, or a timeout.
 */

export type AdSignal =
  | { type: 'playing' }
  | { type: 'paused'; byUser: boolean }
  | { type: 'progress'; time: number }
  | { type: 'stall' }
  | { type: 'manual'; on: boolean }
  /** A platform-specific hint (e.g. an undocumented player message). */
  | { type: 'hint'; on: boolean }

export interface AdState {
  inAd: boolean
  since: number
  lastTime?: number
  lastProgressAt: number
  source: 'manual' | 'hint' | 'stall' | null
}

export const AD_TIMEOUT_MS = 120_000
export const STALL_MS = 4_000

export function initialAdState(now: number): AdState {
  return { inAd: false, since: now, lastProgressAt: now, source: null }
}

export function adReducer(state: AdState, signal: AdSignal, now: number): AdState {
  switch (signal.type) {
    case 'manual':
      return { ...state, inAd: signal.on, since: now, source: signal.on ? 'manual' : null, lastProgressAt: now }
    case 'hint':
      if (signal.on === state.inAd) return state
      return { ...state, inAd: signal.on, since: now, source: signal.on ? 'hint' : null }
    case 'stall':
    case 'paused':
      // A pause by the user ends a guessed ad, but not one the player itself reported.
      if (signal.type === 'paused' && signal.byUser) {
        return state.source === 'hint' || state.source === 'manual' ? state : { ...state, inAd: false, source: null }
      }
      if (state.inAd) return state
      return { ...state, inAd: true, since: now, source: 'stall' }
    case 'playing':
      return state.source === 'stall' ? { ...state, inAd: false, source: null, lastProgressAt: now } : state
    case 'progress': {
      const moved = state.lastTime === undefined || Math.abs(signal.time - state.lastTime) > 0.05
      const next = { ...state, lastTime: signal.time, lastProgressAt: moved ? now : state.lastProgressAt }
      if (moved && state.inAd && state.source !== 'manual') return { ...next, inAd: false, source: null }
      return next
    }
  }
}

/** Called on a timer: turns a frozen clock into a stall, and ends ads that last too long. */
export function adTick(state: AdState, now: number, playing: boolean): AdState {
  if (state.inAd && now - state.since > AD_TIMEOUT_MS) return { ...state, inAd: false, source: null }
  if (!state.inAd && playing && state.lastTime !== undefined && now - state.lastProgressAt > STALL_MS) {
    return adReducer(state, { type: 'stall' }, now)
  }
  return state
}

export const BLOCKED_AFTER_MS = 12_000

/**
 * A Twitch player that Regie already asked to play again and that still never started is usually refusing
 * because of the viewer's own ad blocker: Twitch detects blockers and shows an error instead of the
 * stream. The player iframe is cross-origin, so Regie cannot read that error screen — this is a timing
 * heuristic (given its chance, retried, still not played, not offline), not a certainty. `since` is when
 * the player got its chance to start: mounted at a size Twitch accepts, or its turn in the line check.
 * `retried` means a `play()` was already sent to a player that didn't start on its own.
 */
export function adblockSuspect(
  input: { since?: number; played?: boolean; retried?: boolean; offline?: boolean },
  now: number,
): boolean {
  if (input.since === undefined || input.played || !input.retried || input.offline) return false
  return now - input.since > BLOCKED_AFTER_MS
}

/**
 * Reloading a Twitch player in an ad sometimes comes back without it, but it restarts the stream, and a fresh
 * player often opens on a pre-roll instead. So Regie only reloads when it is likely to pay off:
 *
 * - the ad is confirmed: reported for `AD_CONFIRM_MS` (a false signal never reloads a player);
 * - it is a mid-roll: the player had shown the stream for `PREROLL_MS` before (Twitch also runs its
 *   "preparing your stream" pre-roll a few seconds after the start; reloading one only restarts it);
 * - not twice within `RELOAD_GAP_MS`;
 * - the last reload for this stream worked: when the fresh player opened on an ad again, reloading
 *   doesn't skip ads on that stream for now, and Regie lets them play (silent, covered) for `RELOAD_FAILED_MS`.
 */
export const AD_CONFIRM_MS = 4_000
export const PREROLL_MS = 30_000
export const RELOAD_GAP_MS = 5 * 60_000
export const RELOAD_FAILED_MS = 15 * 60_000

export interface ReloadMemory {
  /** Last reload for an ad. */
  at?: number
  /** Last time a reload led straight to another ad. */
  failedAt?: number
}

/** `watchedAt`: when the player first showed the stream itself, since it was mounted. */
export function shouldReload(memory: ReloadMemory, watchedAt: number | undefined, now: number): boolean {
  if (watchedAt === undefined || now - watchedAt < PREROLL_MS + AD_CONFIRM_MS) return false
  if (memory.failedAt !== undefined && now - memory.failedAt < RELOAD_FAILED_MS) return false
  return memory.at === undefined || now - memory.at >= RELOAD_GAP_MS
}

/**
 * An ad just started. If the player was reloaded for an ad and hasn't shown the stream since, the reload
 * didn't skip anything: remember it so the next ads on this stream simply play.
 */
export function noteAd(memory: ReloadMemory, watched: boolean, now: number): ReloadMemory {
  if (memory.at === undefined || watched || now - memory.at > RELOAD_GAP_MS) return memory
  return { ...memory, failedAt: now }
}
