import { expect, test } from 'bun:test'
import { type Fetch, openKick, openYouTubeVideo } from './hls-origin.ts'
import { UpstreamError } from './twitch.ts'

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60
https://cdn.test/1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,FRAME-RATE=30
https://cdn.test/480p/index.m3u8
`
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2.0,\nhttps://cdn.test/s7.ts\n'

function fake(routes: Record<string, () => Response>) {
  const requests: { url: string; init?: RequestInit }[] = []
  const fetch: Fetch = async (url, init) => {
    requests.push({ url, init })
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    return route ? route[1]() : new Response('not found', { status: 404 })
  }
  return { fetch, requests }
}

test('a Kick live plays its own HLS master, each variant polled as it is', async () => {
  const { fetch } = fake({
    'https://kick.com/api/v2/channels/westcol': () =>
      Response.json({ livestream: { id: 1 }, playback_url: 'https://kick.live-video.test/master.m3u8' }),
    'https://kick.live-video.test/master.m3u8': () => new Response(MASTER),
    'https://cdn.test/480p/index.m3u8': () => new Response(MEDIA),
  })
  const origin = await openKick({ kind: 'live', id: 'westcol' }, fetch)
  expect(origin.vod).toBe(false)
  expect(origin.master.entries.map((entry) => entry.attrs.RESOLUTION)).toEqual(['1920x1080', '852x480'])
  const entry = origin.master.entries[1]
  if (!entry) throw new Error('no variant')
  expect(await origin.upstream(entry).load()).toEqual({
    ok: true,
    text: MEDIA,
    url: 'https://cdn.test/480p/index.m3u8',
  })
})

test('an offline Kick channel, or one that does not exist, is a 404', async () => {
  const offline = fake({
    'https://kick.com/api/v2/channels/': () => Response.json({ livestream: null, playback_url: 'x' }),
  })
  await expect(openKick({ kind: 'live', id: 'someone' }, offline.fetch)).rejects.toMatchObject({ status: 404 })
  const missing = fake({})
  await expect(openKick({ kind: 'live', id: 'nobody' }, missing.fetch)).rejects.toBeInstanceOf(UpstreamError)
})

test('a Kick video plays from its source playlist', async () => {
  const { fetch } = fake({
    'https://kick.com/api/v1/video/': () => Response.json({ source: 'https://kick.vod.test/master.m3u8' }),
    'https://kick.vod.test/master.m3u8': () => new Response(MASTER),
  })
  const origin = await openKick({ kind: 'vod', id: '0f2d2c4e-1111-2222-3333-444455556666' }, fetch)
  expect(origin.vod).toBe(true)
  expect(origin.master.entries).toHaveLength(2)
})

test("a YouTube video plays the HLS master YouTube's player gives its iOS client", async () => {
  const { fetch, requests } = fake({
    'https://www.youtube.com/youtubei/v1/player': () =>
      Response.json({
        playabilityStatus: { status: 'OK' },
        streamingData: { hlsManifestUrl: 'https://manifest.googlevideo.test/hls.m3u8' },
      }),
    'https://manifest.googlevideo.test/hls.m3u8': () => new Response(MASTER),
  })
  const origin = await openYouTubeVideo('dQw4w9WgXcQ', fetch)
  expect(origin.vod).toBe(true)
  expect(origin.master.entries).toHaveLength(2)
  const body = JSON.parse(String(requests[0]?.init?.body))
  expect(body.videoId).toBe('dQw4w9WgXcQ')
  expect(body.context.client.clientName).toBe('IOS')
})

test('a YouTube video that is not playable, or without HLS, fails so its embed takes over', async () => {
  const blocked = fake({
    'https://www.youtube.com/youtubei/v1/player': () =>
      Response.json({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } }),
  })
  await expect(openYouTubeVideo('x'.repeat(11), blocked.fetch)).rejects.toMatchObject({ status: 404 })
  const noHls = fake({
    'https://www.youtube.com/youtubei/v1/player': () => Response.json({ playabilityStatus: { status: 'OK' } }),
  })
  await expect(openYouTubeVideo('x'.repeat(11), noHls.fetch)).rejects.toMatchObject({ status: 502 })
})
