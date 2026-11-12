/**
 * Picking a stream quality for the size a monitor is shown at. A small monitor doesn't need 1080p: with five
 * streams on a wall, matching each one to its size saves most of the bandwidth and decoding work.
 */

export interface Quality {
  /** Value to pass back to the player (Twitch: `group`, e.g. `720p60`, `chunked` for source, `auto`). */
  id: string
  /** Picture height in pixels, 0 when unknown (auto). */
  height: number
  /** Frames per second, 0 when unknown. */
  fps: number
}

/** Twitch quality groups look like `160p30`, `480p30`, `720p60`, `chunked` (source). */
export function parseTwitchQuality(group: string): Quality | null {
  if (!group || group === 'auto') return null
  if (group === 'chunked') return { id: group, height: 100_000, fps: 0 }
  const match = /^(\d{3,4})p(\d+)?/.exec(group)
  return match ? { id: group, height: Number(match[1]), fps: Number(match[2] ?? 0) } : null
}

/**
 * The lowest quality whose picture is at least as tall as the monitor (in device pixels), or `auto` for a
 * main monitor or when nothing fits. At the same height a small monitor takes the lower frame rate: 30 fps
 * costs half the decoding of 60 and looks the same in a preview. `penalty` steps down that many levels,
 * for a player that keeps stalling at the quality it was given.
 */
export function pickQuality(available: Quality[], displayHeight: number, main: boolean, penalty = 0): string {
  if (main || displayHeight <= 0) return 'auto'
  const sorted = available
    .filter((quality) => quality.height > 0)
    .sort((a, b) => a.height - b.height || (a.fps || 1000) - (b.fps || 1000))
  // One entry per height: the lowest frame rate.
  const levels = sorted.filter((quality, index) => sorted[index - 1]?.height !== quality.height)
  const enough = levels.findIndex((quality) => quality.height >= displayHeight)
  if (enough < 0) return 'auto'
  return levels[Math.max(0, enough - penalty)]?.id ?? 'auto'
}

/**
 * A forced quality turns off the player's own adaptation, so a connection that can't keep up stalls instead
 * of stepping down. Two stalls within 30 s take one level off; each clean three minutes give one back.
 */
export interface StallState {
  penalty: number
  stalls: number[]
  /** Last stall or last change of penalty. */
  at: number
}

export const STALL_WINDOW_MS = 30_000
export const STALLS_PER_STEP = 2
export const PENALTY_DECAY_MS = 180_000
export const MAX_PENALTY = 3

export function initialStalls(now: number): StallState {
  return { penalty: 0, stalls: [], at: now }
}

export function recordStall(state: StallState, now: number): StallState {
  const stalls = [...state.stalls.filter((at) => now - at < STALL_WINDOW_MS), now]
  if (stalls.length < STALLS_PER_STEP) return { ...state, stalls, at: now }
  return { penalty: Math.min(MAX_PENALTY, state.penalty + 1), stalls: [], at: now }
}

export function decayStalls(state: StallState, now: number): StallState {
  if (state.penalty === 0 || now - state.at < PENALTY_DECAY_MS) return state
  return { ...state, penalty: state.penalty - 1, at: now }
}
