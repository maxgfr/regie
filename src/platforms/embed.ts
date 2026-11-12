import type { Source } from '../core/types.ts'

export interface EmbedOptions {
  /** Hostname of the page, required by Twitch (`parent`) and YouTube chat (`embed_domain`). */
  host: string
  muted: boolean
  autoplay?: boolean
  /** Exact origin of the page (scheme, host and port), required by the YouTube IFrame API to talk back. */
  origin?: string
}

/** URL of the player iframe for platforms driven by URL only (no JS API, or an API over postMessage). */
export function embedUrl(source: Source, options: EmbedOptions): string | null {
  const { id, kind } = source
  const autoplay = options.autoplay ?? true
  switch (source.platform) {
    case 'twitch': {
      const params = new URLSearchParams({
        parent: options.host,
        autoplay: String(autoplay),
        muted: String(options.muted),
      })
      if (kind === 'clip') return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(id)}&${params}`
      if (kind === 'vod') params.set('video', `v${id}`)
      else params.set('channel', id)
      if (source.start) params.set('time', `${Math.floor(source.start)}s`)
      return `https://player.twitch.tv/?${params}`
    }
    case 'youtube': {
      const params = new URLSearchParams({
        autoplay: autoplay ? '1' : '0',
        mute: options.muted ? '1' : '0',
        enablejsapi: '1',
        playsinline: '1',
        rel: '0',
        origin: options.origin ?? `https://${options.host}`,
      })
      if (source.start) params.set('start', String(Math.floor(source.start)))
      if (isYouTubeChannel(id)) {
        params.set('channel', id)
        return `https://www.youtube-nocookie.com/embed/live_stream?${params}`
      }
      return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params}`
    }
    case 'kick':
      return `https://player.kick.com/${encodeURIComponent(id)}?autoplay=${autoplay}&muted=${options.muted}`
    case 'tiktok':
      if (kind === 'unembeddable') return null
      return `https://www.tiktok.com/player/v1/${encodeURIComponent(id)}?autoplay=${autoplay ? 1 : 0}&loop=1&rel=0&music_info=0&description=0`
    case 'vimeo':
      return kind === 'live'
        ? `https://vimeo.com/event/${encodeURIComponent(id)}/embed?autoplay=${autoplay ? 1 : 0}&muted=${options.muted ? 1 : 0}`
        : `https://player.vimeo.com/video/${encodeURIComponent(id)}?autoplay=${autoplay ? 1 : 0}&muted=${options.muted ? 1 : 0}&dnt=1`
    case 'dailymotion':
      return `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(id)}&mute=${options.muted}`
    case 'iframe':
      return id
    case 'video':
      return null
  }
}

/** URL of the official chat iframe, when the platform has an embeddable one. */
export function chatUrl(source: Source, host: string, dark = true): string | null {
  switch (source.platform) {
    case 'twitch':
      if (source.kind !== 'live') return null
      return `https://www.twitch.tv/embed/${encodeURIComponent(source.id)}/chat?parent=${encodeURIComponent(host)}${dark ? '&darkpopout' : ''}`
    case 'youtube':
      if (isYouTubeChannel(source.id)) return null
      return `https://www.youtube.com/live_chat?v=${encodeURIComponent(source.id)}&embed_domain=${encodeURIComponent(host)}${dark ? '&dark_theme=1' : ''}`
    case 'kick':
      return `https://kick.com/popout/${encodeURIComponent(source.id)}/chat`
    default:
      return null
  }
}

export function isYouTubeChannel(id: string): boolean {
  return id.length === 24 && id.startsWith('UC')
}
