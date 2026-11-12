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
      if (signal.type === 'paused' && signal.byUser) return { ...state, inAd: false, source: null }
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
