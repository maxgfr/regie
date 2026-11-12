/**
 * Lining up live streams that show the same event with different delays.
 *
 * The user "claps": they mark the moment the same in-game event appears on each tile. The stream that
 * shows it first is the most ahead. Streams Regie can seek (YouTube DVR, every VOD, direct video) are
 * delayed to match the slowest one; the others (Twitch or Kick live) keep a lead that is shown on the tile
 * and used to hold back their chat, so it doesn't spoil what slower streams haven't shown yet.
 */

export interface SyncTile {
  id: string
  /** `performance.now()` in ms of the clap, or undefined if this tile wasn't marked. */
  mark?: number
  canDelay: boolean
  /** Delay Regie already applies to this tile, in seconds. */
  delay: number
}

export interface SyncPlan {
  /** New total delay to apply to each tile, in seconds. */
  delays: Record<string, number>
  /** Lead that remains, in seconds (positive = shows things earlier than the slowest stream). */
  ahead: Record<string, number>
}

const round = (value: number) => Math.round(value * 100) / 100

export function planSync(tiles: SyncTile[]): SyncPlan {
  const marked = tiles.filter((tile): tile is SyncTile & { mark: number } => tile.mark !== undefined)
  const delays: Record<string, number> = {}
  const ahead: Record<string, number> = {}
  for (const tile of tiles) {
    delays[tile.id] = tile.delay
    ahead[tile.id] = 0
  }
  if (marked.length < 2) return { delays, ahead }

  // Where each stream would show the event without any delay from Regie.
  const natural = marked.map((tile) => ({ tile, at: tile.mark / 1000 - tile.delay }))
  // Seekable streams can be delayed but not pushed past their natural position,
  // so the target is the latest natural time among all streams.
  const target = Math.max(...natural.map((entry) => entry.at))
  for (const { tile, at } of natural) {
    if (tile.canDelay) {
      delays[tile.id] = round(Math.max(0, target - at))
      ahead[tile.id] = 0
    } else {
      delays[tile.id] = 0
      ahead[tile.id] = round(target - at)
    }
  }
  return { delays, ahead }
}

/** How long to hold back a channel's chat so it matches what its video shows. */
export function chatHold(latencySeconds: number | undefined, delaySeconds: number, aheadSeconds: number): number {
  // Chat arrives in real time; the video is `latency` behind the broadcaster, plus Regie's delay.
  // A stream that is still ahead of the slowest one is held back by its lead too, so chat never spoils.
  return Math.max(0, (latencySeconds ?? 0) + delaySeconds + aheadSeconds)
}
