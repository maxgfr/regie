/** The keys of YouTube's player data that schedule ads. */
const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'] as const

/**
 * Removes the ad keys from a YouTube player answer (`/youtubei/v1/player`, `ytInitialPlayerResponse`), at its
 * top level or under `playerResponse`. Anything else comes back untouched; it never throws.
 */
export function pruneAds<T>(value: T): T {
  try {
    if (!value || typeof value !== 'object') return value
    const targets = [value as Record<string, unknown>]
    const nested = (value as { playerResponse?: unknown }).playerResponse
    if (nested && typeof nested === 'object') targets.push(nested as Record<string, unknown>)
    for (const target of targets) for (const key of AD_KEYS) if (key in target) delete target[key]
  } catch {
    // A frozen or exotic object: left as it is.
  }
  return value
}
