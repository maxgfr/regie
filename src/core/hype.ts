/**
 * Chat activity per stream, as a VU meter. A big channel always chats fast, so the meter compares the
 * current rate with the channel's own recent baseline: 1 means "as usual", 3 means "something happens".
 */

export interface HypeState {
  /** Message timestamps of the last window, in ms. */
  recent: number[]
  /** Slow moving average of messages per second. */
  baseline: number
  updatedAt: number
}

export const WINDOW_MS = 10_000
const BASELINE_HALF_LIFE_MS = 120_000

export function initialHype(now: number): HypeState {
  return { recent: [], baseline: 0, updatedAt: now }
}

export function recordMessage(state: HypeState, at: number): HypeState {
  return { ...state, recent: [...state.recent.filter((t) => at - t < WINDOW_MS), at] }
}

export function rate(state: HypeState, now: number): number {
  return state.recent.filter((t) => now - t < WINDOW_MS).length / (WINDOW_MS / 1000)
}

export function decayHype(state: HypeState, now: number): HypeState {
  const current = rate(state, now)
  const elapsed = now - state.updatedAt
  const weight = 1 - 0.5 ** (elapsed / BASELINE_HALF_LIFE_MS)
  const baseline = state.baseline === 0 ? current : state.baseline + (current - state.baseline) * weight
  return { recent: state.recent.filter((t) => now - t < WINDOW_MS), baseline, updatedAt: now }
}

/** Current rate over the baseline. Below a floor of messages, a quiet channel never reads as hype. */
export function spike(state: HypeState, now: number): number {
  const current = rate(state, now)
  if (current < 0.5) return 0
  return current / Math.max(state.baseline, 0.3)
}

/** Level of the VU meter, 0..1. */
export function meter(state: HypeState, now: number): number {
  return Math.min(1, spike(state, now) / 3)
}

export const TAKEOVER_SPIKE = 2.5
export const TAKEOVER_MS = 20_000
