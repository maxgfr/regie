import type { Source } from '../core/types.ts'
import { isYouTubeChannel } from './embed.ts'

/**
 * The title of a video, through public oEmbed endpoints that need no key and allow cross-origin
 * requests. Only used to label the monitor; failure just keeps the id.
 */
export async function fetchTitle(source: Source, signal?: AbortSignal): Promise<string | null> {
  let endpoint: string | null = null
  const { platform, id } = source
  if (platform === 'youtube' && !isYouTubeChannel(id)) {
    endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`
  } else if (platform === 'vimeo') {
    endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`
  } else if (platform === 'dailymotion') {
    endpoint = `https://api.dailymotion.com/video/${encodeURIComponent(id)}?fields=title`
  }
  if (!endpoint) return null
  try {
    const response = await fetch(endpoint, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok) return null
    const data = (await response.json()) as { title?: unknown }
    return typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 120) : null
  } catch {
    return null
  }
}
