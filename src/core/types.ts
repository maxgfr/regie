export type PlatformId = 'twitch' | 'youtube' | 'kick' | 'tiktok' | 'vimeo' | 'dailymotion' | 'video' | 'iframe'

/** What a source is, which drives what the player can do (seek, delay, chat). */
export type SourceKind = 'live' | 'vod' | 'clip' | 'post' | 'unembeddable'

export interface Source {
  platform: PlatformId
  kind: SourceKind
  /** Channel name, video id, or full URL for `video` / `iframe`. */
  id: string
  /** Start offset in seconds for VODs. */
  start?: number
}

export type LayoutMode = 'grid' | 'focus' | 'theater'
export type AudioMode = 'solo' | 'mix' | 'manual'

export interface Tile {
  id: string
  source: Source
  /** User volume, 0..1. */
  volume: number
  muted: boolean
  /** Delay applied by Regie through the player API, in seconds. */
  delay: number
  /** Measured lead over the slowest stream that Regie could not remove, in seconds. */
  ahead: number
}

export interface Session {
  tiles: Tile[]
  layout: LayoutMode
  focusId: string | null
  audioId: string | null
  audioMode: AudioMode
  /** Volume multiplier of the tiles that are not on air in `mix` mode. */
  duck: number
  master: number
  chatOpen: boolean
  liveChat: boolean
  /** Hold the merged chat back by each stream's latency and lead. */
  antiSpoiler: boolean
  /** `cut` switches the sound at once, `mix` crossfades it. */
  transition: 'cut' | 'mix'
  keywords: string[]
  autoDirector: boolean
  adSwitch: boolean
  /** Favourites that go live are added to the wall on their own. */
  autoAdd: boolean
  /** Reload a Twitch player that goes to an ad, which sometimes skips it (limited tries). */
  adReload: boolean
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Capabilities {
  volume: boolean
  mute: boolean
  /** Can seek, so Regie can delay it to line it up with slower streams. */
  seek: boolean
  chat: boolean
  /** Anonymous merged chat (Twitch IRC). */
  liveChat: boolean
  /** Reports the live latency to the broadcaster. */
  latency: boolean
  aspect: number
}
