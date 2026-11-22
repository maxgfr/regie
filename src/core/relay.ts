import { sourcePage } from '../platforms/parse.ts'
import type { Source } from './types.ts'

/**
 * The optional relay the viewer runs on their own machine (`bun run relay`): it resolves a stream to HLS
 * without the ad segments, and Regie plays it in a `<video>` instead of the official embed. The page stays
 * static and anonymous: without a reachable relay, every tile keeps its official player.
 */

export type RelayStatus = 'off' | 'checking' | 'up' | 'down'

/** The platforms a relay can play. */
export const RELAY_PLATFORMS = ['twitch', 'youtube', 'kick'] as const
export type RelayPlatform = (typeof RELAY_PLATFORMS)[number]

export interface RelayHealth {
  ytdlp: string | null
  /** Without ffmpeg the relay can't remux YouTube videos, so those keep their embed. */
  ffmpeg: string | null
  /** What this relay plays. Null: an older relay that doesn't say, so all of them. */
  platforms: RelayPlatform[] | null
  /** It plays YouTube videos (the server with ffmpeg; the extension, as YouTube's own HLS). Unset: `ffmpeg` says. */
  youtubeVideos?: boolean
  /** It plays YouTube lives (the server through yt-dlp; not the extension). Unset: yes. */
  youtubeLive?: boolean
}

/**
 * Whether the relay plays this source: Twitch live and VODs (not clips), YouTube live and videos, Kick.
 * `remux` says it plays YouTube videos (the server remuxes them with ffmpeg; the extension plays YouTube's own
 * HLS), `youtubeLive` that it plays YouTube lives; `platforms`, when given, is the list the relay reported,
 * and any other platform keeps its embed.
 */
export function relayable(
  source: Source,
  remux = true,
  platforms?: readonly string[] | null,
  youtubeLive = true,
): boolean {
  const { platform, kind, id } = source
  if (platforms && !platforms.includes(platform)) return false
  if (platform === 'twitch') return kind === 'live' || kind === 'vod'
  if (platform === 'kick') return kind === 'live' || kind === 'vod'
  if (platform === 'youtube') return (kind === 'live' && youtubeLive) || (kind === 'vod' && remux && id.length === 11)
  return false
}

/** Which relay plays a tile: the viewer's own server, the Regie browser extension, or none (its embed). */
export type RelayVia = 'server' | 'extension'

/** Platforms the extension plays before its `/health` says otherwise. */
export const EXTENSION_PLATFORMS: readonly RelayPlatform[] = ['twitch']

/**
 * Picks the relay a source plays from. The viewer's server relay wins when it is up and plays the source;
 * otherwise the extension, when it answered and plays the source; otherwise none. `null` health: not up.
 */
export function pickRelay(
  source: Source,
  relays: { server: RelayHealth | null; extension: RelayHealth | null },
): RelayVia | null {
  const { server, extension } = relays
  if (server && relayable(source, server.youtubeVideos ?? server.ffmpeg !== null, server.platforms, server.youtubeLive))
    return 'server'
  // The extension has no yt-dlp: no YouTube lives, and YouTube videos only as YouTube's own HLS, when it says so.
  if (
    extension &&
    relayable(
      source,
      extension.youtubeVideos ?? false,
      extension.platforms ?? EXTENSION_PLATFORMS,
      extension.youtubeLive ?? false,
    )
  )
    return 'extension'
  return null
}

/** Cleans the address the viewer typed: `localhost:7878/` → `http://localhost:7878`. Empty is off, null is invalid. */
export function normalizeRelayBase(input: string): string | null {
  const text = input.trim()
  if (!text) return ''
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const trim = (base: string) => base.replace(/\/+$/, '')
const withKey = (url: string, key: string) =>
  key ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : url

/** The relay's master playlist for a source. */
export function relayUrl(base: string, key: string, source: Source): string {
  return withKey(`${trim(base)}/play.m3u8?src=${encodeURIComponent(sourcePage(source))}`, key)
}

export function healthUrl(base: string, key: string): string {
  return withKey(`${trim(base)}/health`, key)
}

/** Reads the relay's `/health` answer; anything else is not a relay. */
export function parseHealth(body: unknown): RelayHealth | null {
  const data = body as {
    ok?: unknown
    ytdlp?: unknown
    ffmpeg?: unknown
    platforms?: unknown
    youtubeVideos?: unknown
    youtubeLive?: unknown
  } | null
  if (!data || typeof data !== 'object' || data.ok !== true) return null
  const version = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : null)
  const platforms = Array.isArray(data.platforms)
    ? RELAY_PLATFORMS.filter((platform) => (data.platforms as unknown[]).includes(platform))
    : null
  const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined)
  const health: RelayHealth = { ytdlp: version(data.ytdlp), ffmpeg: version(data.ffmpeg), platforms }
  const youtubeVideos = flag(data.youtubeVideos)
  const youtubeLive = flag(data.youtubeLive)
  if (youtubeVideos !== undefined) health.youtubeVideos = youtubeVideos
  if (youtubeLive !== undefined) health.youtubeLive = youtubeLive
  return health
}
