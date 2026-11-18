import type { AudioMode } from './types.ts'

export interface AudioTile {
  id: string
  volume: number
  muted: boolean
  inAd: boolean
  hype: number
}

export interface AudioInput {
  tiles: AudioTile[]
  mode: AudioMode
  /** The tile the user put on air. */
  audioId: string | null
  /** A tile listened to for a moment (key held, hype takeover); wins over `audioId`. */
  listenId: string | null
  duck: number
  master: number
  /** When the tile on air plays an ad, hand the sound to another one. */
  adSwitch: boolean
}

export interface AudioOutput {
  /** The tile that has the sound (tally light), if any. */
  onAir: string | null
  /** True when `onAir` was picked because the chosen tile is in an ad. */
  covering: boolean
  volumes: Record<string, number>
}

/** The tile that takes over while the one on air is in an ad: the hottest chat, else the next one in order. */
export function standIn(tiles: AudioTile[], from: string): string | null {
  const candidates = tiles.filter((tile) => tile.id !== from && !tile.inAd && !tile.muted)
  if (candidates.length === 0) return null
  const hottest = candidates.reduce((best, tile) => (tile.hype > best.hype ? tile : best))
  if (hottest.hype > 0) return hottest.id
  const index = tiles.findIndex((tile) => tile.id === from)
  for (let step = 1; step <= tiles.length; step++) {
    const next = tiles[(index + step) % tiles.length]
    if (next && candidates.includes(next)) return next.id
  }
  return candidates[0]?.id ?? null
}

/** Effective volume of each tile, 0..1, from the mode, the tile on air, ads and the master fader. */
export function mixAudio(input: AudioInput): AudioOutput {
  const { tiles, mode, duck, master, adSwitch } = input
  const chosen = tiles.find((tile) => tile.id === (input.listenId ?? input.audioId)) ?? tiles[0] ?? null
  let onAir = chosen?.id ?? null
  let covering = false
  if (chosen?.inAd && adSwitch) {
    const other = standIn(tiles, chosen.id)
    if (other) {
      onAir = other
      covering = true
    }
  }
  const volumes: Record<string, number> = {}
  for (const tile of tiles) {
    let level: number
    if (tile.muted) level = 0
    else if (mode === 'manual') level = tile.volume
    else if (tile.id === onAir) level = tile.volume
    else if (mode === 'mix') level = tile.volume * duck
    else level = 0
    // An ad is silenced when another tile covers it.
    if (tile.inAd && adSwitch && tile.id !== onAir && covering) level = 0
    volumes[tile.id] = Math.round(level * master * 1000) / 1000
  }
  if (mode === 'manual') {
    const loudest = tiles.filter((tile) => (volumes[tile.id] ?? 0) > 0)
    onAir = loudest.length === 1 ? (loudest[0]?.id ?? null) : onAir
  }
  return { onAir, covering, volumes }
}
