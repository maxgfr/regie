/**
 * Official Twitch embeds that don't play as they should: one that never starts, one Twitch stopped while the
 * page was hidden. The player iframe is cross-origin, so these are timing heuristics on what its API reports.
 */

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
 * Back on a page that was hidden, after this long (Twitch resumes some players on its own, and the layout
 * settles), players Twitch stopped in the background get one `play()`.
 */
export const WAKE_AFTER_MS = 1500

/**
 * Twitch stops a player it can't see, and doesn't always start it again when the page comes back. A player
 * that has played and isn't playing gets a `play()`. Not one the viewer paused themselves, nor one with
 * nothing to play.
 */
export function shouldWake(input: { played?: boolean; state: string; pausedByViewer?: boolean }): boolean {
  if (!input.played || input.pausedByViewer) return false
  if (input.state === 'offline' || input.state === 'ended') return false
  return input.state !== 'playing'
}
