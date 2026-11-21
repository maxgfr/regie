/**
 * Which links the relay accepts, and how a Twitch source becomes an origin. Portable: no Node or Bun API,
 * so the browser extension shares it with the server (yt-dlp and ffmpeg stay in `resolve.ts`).
 */
import { parseSource, sourcePage } from '../src/platforms/parse.ts'
import type { Origin } from './stream.ts'
import type { Twitch } from './twitch.ts'

export interface RelaySource {
  platform: 'twitch' | 'youtube' | 'kick'
  kind: 'live' | 'vod'
  id: string
  /** The canonical page URL: the cache key, and the only URL ever handed to yt-dlp. */
  page: string
}

const KICK_VOD =
  /^https?:\/\/(?:www\.)?kick\.com\/(?:[a-zA-Z0-9_-]{2,30}\/videos|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i

/** Accepts Twitch live/VOD, YouTube videos and channel lives, Kick live/VOD; anything else is null. */
export function canonicalize(input: string): RelaySource | null {
  const text = input.trim()
  const kickVod = KICK_VOD.exec(text)
  if (kickVod?.[1]) {
    const id = kickVod[1].toLowerCase()
    const channel = /kick\.com\/([^/]+)\/videos\//i.exec(text)?.[1]?.toLowerCase()
    const page = channel ? `https://kick.com/${channel}/videos/${id}` : `https://kick.com/video/${id}`
    return { platform: 'kick', kind: 'vod', id, page }
  }
  const source = parseSource(text)
  if (!source) return null
  const { platform, kind, id } = source
  const page = sourcePage({ platform, kind, id })
  if (platform === 'twitch' && (kind === 'live' || kind === 'vod')) return { platform, kind, id, page }
  if (platform === 'kick' && kind === 'live') return { platform, kind, id, page }
  // The client sends `sourcePage()`, which writes every video id as watch?v=: live or not is yt-dlp's call.
  if (platform === 'youtube' && (kind === 'live' || kind === 'vod')) return { platform, kind, id, page }
  return null
}

/** A Twitch source through Twitch's own anonymous API. Throws `UpstreamError` (404 offline, 502 failure). */
export function openTwitch(source: RelaySource, twitch: Twitch): Promise<Origin> {
  return source.kind === 'vod' ? twitch.vod(source.id) : twitch.live(source.id)
}
