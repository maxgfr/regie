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

export const RELOAD_LIMIT = 2
export const RELOAD_WINDOW_MS = 5 * 60_000

export const BLOCKED_AFTER_MS = 12_000

/**
 * A Twitch player that Regie already asked to play again and that still never started is usually refusing
 * because of the viewer's own ad blocker: Twitch detects blockers and shows an error instead of the
 * stream. The player iframe is cross-origin, so Regie cannot read that error screen — this is a timing
 * heuristic (mounted, retried, still not played, not offline), not a certainty. `retried` means a `play()`
 * was already sent to a player that didn't start on its own.
 */
export function adblockSuspect(
  input: { mountedAt?: number; played?: boolean; retried?: boolean; offline?: boolean },
  now: number,
): boolean {
  if (input.mountedAt === undefined || input.played || !input.retried || input.offline) return false
  return now - input.mountedAt > BLOCKED_AFTER_MS
}

/**
 * Whether to reload a player that just went to an ad. Reloading sometimes skips the ad, but Twitch often
 * serves it again: at most two tries per stream within five minutes, so a stubborn ad never turns into a
 * reload loop. `history` holds the times of the previous reloads.
 */
export function shouldReload(history: number[], now: number): boolean {
  return history.filter((at) => now - at < RELOAD_WINDOW_MS).length < RELOAD_LIMIT
}
