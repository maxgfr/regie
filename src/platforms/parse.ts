import type { Capabilities, PlatformId, Source, SourceKind } from '../core/types.ts'

const TWITCH_NAME = /^[a-zA-Z0-9_]{2,25}$/
const YT_ID = /^[a-zA-Z0-9_-]{11}$/

/** Parses a pasted link or a bare channel name into a source. Bare names default to Twitch. */
export function parseSource(input: string): Source | null {
  const text = input.trim()
  if (!text) return null
  if (TWITCH_NAME.test(text)) return { platform: 'twitch', kind: 'live', id: text.toLowerCase() }
  const prefixed = /^(twitch|tw|youtube|yt|kick|kk):(.+)$/i.exec(text)
  if (prefixed?.[1] && prefixed[2]) {
    const key = prefixed[1].toLowerCase()
    const rest = prefixed[2].trim()
    if (key === 'kick' || key === 'kk') return { platform: 'kick', kind: 'live', id: rest.toLowerCase() }
    if (key === 'youtube' || key === 'yt')
      return YT_ID.test(rest) ? { platform: 'youtube', kind: 'vod', id: rest } : null
    return TWITCH_NAME.test(rest) ? { platform: 'twitch', kind: 'live', id: rest.toLowerCase() } : null
  }
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.replace(/^(www|m|go|player|mobile)\./, '')
  const parts = url.pathname.split('/').filter(Boolean)
  const start = parseStart(url.searchParams.get('t') ?? url.searchParams.get('time') ?? url.searchParams.get('start'))

  if (host === 'twitch.tv' || host === 'clips.twitch.tv') return parseTwitch(host, parts, url, start)
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    return parseYouTube(host, parts, url, start)
  }
  if (host === 'kick.com') {
    const name = parts[0]
    return name && /^[a-zA-Z0-9_-]{2,30}$/.test(name)
      ? { platform: 'kick', kind: 'live', id: name.toLowerCase() }
      : null
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return parseTikTok(parts, url)
  if (host === 'vimeo.com') {
    const id = parts.find((p) => /^\d+$/.test(p))
    return id ? { platform: 'vimeo', kind: parts[0] === 'event' ? 'live' : 'vod', id } : null
  }
  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const id = host === 'dai.ly' ? parts[0] : parts[0] === 'video' || parts[0] === 'embed' ? parts.at(-1) : undefined
    return id && /^[a-zA-Z0-9]+$/.test(id) ? { platform: 'dailymotion', kind: 'vod', id } : null
  }
  if (/\.(m3u8|mp4|webm|ogv|mov)$/i.test(url.pathname)) {
    return { platform: 'video', kind: /\.m3u8$/i.test(url.pathname) ? 'live' : 'vod', id: url.href }
  }
  if (url.protocol === 'https:') return { platform: 'iframe', kind: 'live', id: url.href }
  return null
}

function parseTwitch(host: string, parts: string[], url: URL, start?: number): Source | null {
  if (host === 'clips.twitch.tv') {
    const slug = parts[0] === 'embed' ? url.searchParams.get('clip') : parts[0]
    return slug ? { platform: 'twitch', kind: 'clip', id: slug } : null
  }
  if (parts[0] === 'videos' && parts[1] && /^\d+$/.test(parts[1])) {
    return withStart({ platform: 'twitch', kind: 'vod', id: parts[1] }, start)
  }
  if (parts[1] === 'clip' && parts[2]) return { platform: 'twitch', kind: 'clip', id: parts[2] }
  const player = url.searchParams.get('channel')
  const video = url.searchParams.get('video')
  if (video) return withStart({ platform: 'twitch', kind: 'vod', id: video.replace(/^v/, '') }, start)
  const name = player ?? (parts[0] === 'popout' || parts[0] === 'embed' ? parts[1] : parts[0])
  return name && TWITCH_NAME.test(name) ? { platform: 'twitch', kind: 'live', id: name.toLowerCase() } : null
}

function parseYouTube(host: string, parts: string[], url: URL, start?: number): Source | null {
  let id: string | null | undefined
  if (host === 'youtu.be') id = parts[0]
  else if (parts[0] === 'watch') id = url.searchParams.get('v')
  else if (['live', 'shorts', 'embed', 'v'].includes(parts[0] ?? '')) id = parts[1]
  else if (parts[0] === 'live_chat') id = url.searchParams.get('v')
  if (id === 'live_stream') {
    const channel = url.searchParams.get('channel')
    return channel ? { platform: 'youtube', kind: 'live', id: channel } : null
  }
  if (parts[0] === 'channel' && parts[1]?.startsWith('UC')) return { platform: 'youtube', kind: 'live', id: parts[1] }
  if (!id || !YT_ID.test(id)) return null
  return withStart({ platform: 'youtube', kind: parts[0] === 'live' ? 'live' : 'vod', id }, start)
}

function parseTikTok(parts: string[], url: URL): Source | null {
  const video = parts.indexOf('video')
  const id =
    video >= 0 ? parts[video + 1] : parts[0] === 'player' ? parts[2] : parts[0] === 'embed' ? parts.at(-1) : null
  if (id && /^\d{8,25}$/.test(id)) return { platform: 'tiktok', kind: 'post', id }
  if (parts.includes('live')) return { platform: 'tiktok', kind: 'unembeddable', id: url.href }
  return null
}

function withStart(source: Source, start?: number): Source {
  return start ? { ...source, start } : source
}

/** Parses `90`, `1m30s`, `1h2m3s` into seconds. */
export function parseStart(value: string | null): number | undefined {
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value) || undefined
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)
  if (!match) return undefined
  const total = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  return total || undefined
}

const SEEKABLE: Record<PlatformId, (kind: SourceKind) => boolean> = {
  twitch: (kind) => kind === 'vod',
  youtube: () => true,
  kick: () => false,
  tiktok: () => true,
  vimeo: () => false,
  dailymotion: () => false,
  video: () => true,
  iframe: () => false,
}

export function capabilities(source: Source): Capabilities {
  const { platform, kind } = source
  const controllable = platform === 'twitch' || platform === 'youtube' || platform === 'video' || platform === 'tiktok'
  return {
    volume: platform === 'twitch' || platform === 'youtube' || platform === 'video' || platform === 'vimeo',
    mute: controllable || platform === 'kick' || platform === 'vimeo' || platform === 'dailymotion',
    seek: kind !== 'unembeddable' && kind !== 'clip' && SEEKABLE[platform](kind),
    chat:
      (platform === 'twitch' && kind === 'live') ||
      (platform === 'youtube' && source.id.length === 11) ||
      platform === 'kick',
    liveChat: platform === 'twitch' && kind === 'live',
    latency: platform === 'twitch' && kind === 'live',
    aspect: platform === 'tiktok' ? 9 / 16 : 16 / 9,
  }
}

const LABELS: Record<PlatformId, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
  tiktok: 'TikTok',
  vimeo: 'Vimeo',
  dailymotion: 'Dailymotion',
  video: 'Video',
  iframe: 'Web',
}

export function platformLabel(platform: PlatformId): string {
  return LABELS[platform]
}

/** A short human name for a source: the channel name or a shortened id. */
export function sourceName(source: Source): string {
  if (source.platform === 'video' || source.platform === 'iframe' || source.kind === 'unembeddable') {
    try {
      const url = new URL(source.id)
      return url.hostname.replace(/^www\./, '') + (url.pathname.length > 1 ? url.pathname : '')
    } catch {
      return source.id
    }
  }
  return source.id
}

/** The page of the source on its own platform, for "open on Twitch" links. */
export function sourcePage(source: Source): string {
  const { platform, kind, id } = source
  switch (platform) {
    case 'twitch':
      return kind === 'vod'
        ? `https://www.twitch.tv/videos/${id}`
        : kind === 'clip'
          ? `https://clips.twitch.tv/${id}`
          : `https://www.twitch.tv/${id}`
    case 'youtube':
      return id.startsWith('UC') && id.length === 24
        ? `https://www.youtube.com/channel/${id}/live`
        : `https://www.youtube.com/watch?v=${id}`
    case 'kick':
      return `https://kick.com/${id}`
    case 'tiktok':
      return kind === 'unembeddable' ? id : `https://www.tiktok.com/@/video/${id}`
    case 'vimeo':
      return `https://vimeo.com/${id}`
    case 'dailymotion':
      return `https://www.dailymotion.com/video/${id}`
    default:
      return id
  }
}
