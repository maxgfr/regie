/**
 * Kick and YouTube for the extension, which has no yt-dlp: each platform's own anonymous API gives an HLS
 * master, played as it is (Kick lives and videos; YouTube videos as the HLS YouTube gives its iOS app; no
 * YouTube lives, which need tokens only a real player gets). Portable: fetch only, no Node or Bun API.
 */
import { isMasterPlaylist, parseMaster, singleVariantMaster } from './playlist.ts'
import type { Loaded, Origin, Upstream } from './stream.ts'
import { UpstreamError } from './twitch.ts'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** A playlist URL, polled as it is: a variant of the master. */
function plain(url: string, fetch: Fetch): Upstream {
  return {
    load: async (): Promise<Loaded> => {
      const response = await fetch(url)
      if (response.status === 403 || response.status === 404 || response.status === 410)
        return { ok: false, status: 404 }
      if (!response.ok) return { ok: false, status: 502 }
      return { ok: true, text: await response.text(), url }
    },
  }
}

/** The master at `url` as an origin: its variants are polled as they are. */
export async function hlsOrigin(url: string, vod: boolean, fetch: Fetch): Promise<Origin> {
  const response = await fetch(url)
  if (response.status === 403 || response.status === 404) throw new UpstreamError(404, 'Stream not available')
  if (!response.ok) throw new UpstreamError(502, `Master playlist ${response.status}`)
  const text = await response.text()
  const master = isMasterPlaylist(text) ? parseMaster(text, url) : singleVariantMaster(url)
  return { master, upstream: (entry) => plain(entry.url, fetch), vod }
}

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  if (response.status === 404) throw new UpstreamError(404, `${what}: not found`)
  if (!response.ok) throw new UpstreamError(502, `${what} ${response.status}`)
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    throw new UpstreamError(502, `${what}: not JSON`)
  }
}

/** A Kick live (`id`: the channel slug) or video (`id`: its uuid), through Kick's public API. */
export async function openKick(source: { kind: string; id: string }, fetch: Fetch): Promise<Origin> {
  const headers = { Accept: 'application/json' }
  if (source.kind === 'vod') {
    const video = await json(await fetch(`https://kick.com/api/v1/video/${source.id}`, { headers }), 'Kick video')
    const url = typeof video.source === 'string' ? video.source : null
    if (!url) throw new UpstreamError(404, 'Kick video without a stream')
    return hlsOrigin(url, true, fetch)
  }
  const channel = await json(await fetch(`https://kick.com/api/v2/channels/${source.id}`, { headers }), 'Kick channel')
  const url = typeof channel.playback_url === 'string' ? channel.playback_url : null
  if (!channel.livestream || !url) throw new UpstreamError(404, 'Offline')
  return hlsOrigin(url, false, fetch)
}

/** The client YouTube's iOS app sends: its player answers with an HLS master for videos, without ads. */
export const YOUTUBE_IOS_CLIENT = {
  clientName: 'IOS',
  clientVersion: '20.10.4',
  deviceMake: 'Apple',
  deviceModel: 'iPhone16,2',
  osName: 'iPhone',
  osVersion: '18.3.2.22D82',
  hl: 'en',
  gl: 'US',
} as const

/** A YouTube video (`id`: its 11-character id), as the HLS YouTube's player API gives its iOS app. */
export async function openYouTubeVideo(id: string, fetch: Fetch): Promise<Origin> {
  const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': YOUTUBE_IOS_CLIENT.clientVersion,
    },
    body: JSON.stringify({
      context: { client: YOUTUBE_IOS_CLIENT },
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  })
  const answer = await json(response, 'YouTube player')
  const playability = answer.playabilityStatus as { status?: string; reason?: string } | undefined
  if (playability?.status && playability.status !== 'OK')
    throw new UpstreamError(404, `YouTube: ${playability.reason ?? playability.status}`)
  const url = (answer.streamingData as { hlsManifestUrl?: unknown } | undefined)?.hlsManifestUrl
  if (typeof url !== 'string') throw new UpstreamError(502, 'YouTube gave no HLS for this video')
  return hlsOrigin(url, true, fetch)
}
