/**
 * Picking a stream quality for the size a monitor is shown at. A small monitor doesn't need 1080p: with five
 * streams on a wall, matching each one to its size saves most of the bandwidth and decoding work.
 */

export interface Quality {
  /** Value to pass back to the player (Twitch: `group`, e.g. `720p60`, `chunked` for source, `auto`). */
  id: string
  /** Picture height in pixels, 0 when unknown (auto). */
  height: number
}

/** Twitch quality groups look like `160p30`, `480p30`, `720p60`, `chunked` (source). */
export function parseTwitchQuality(group: string): Quality | null {
  if (!group || group === 'auto') return null
  if (group === 'chunked') return { id: group, height: 100_000 }
  const match = /^(\d{3,4})p/.exec(group)
  return match ? { id: group, height: Number(match[1]) } : null
}

/**
 * The lowest quality whose picture is at least as tall as the monitor (in device pixels), or `auto` for a
 * main monitor or when nothing fits. Prefers the higher frame rate at the same height.
 */
export function pickQuality(available: Quality[], displayHeight: number, main: boolean): string {
  if (main || displayHeight <= 0) return 'auto'
  const sorted = available
    .filter((quality) => quality.height > 0)
    .sort((a, b) => a.height - b.height || (b.id > a.id ? 1 : -1))
  const enough = sorted.find((quality) => quality.height >= displayHeight)
  return enough?.id ?? 'auto'
}
