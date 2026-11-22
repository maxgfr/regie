import { afterAll, describe, expect, test } from 'bun:test'
import { TWITCH_MASTER, twitchLive } from './fixtures.ts'
import { createRelayHandler, type RelayHandlerDeps } from './handler.ts'
import { parseMaster } from './playlist.ts'
import { configFromEnv, createHandler } from './server.ts'
import { type Origin, Relay, type SegmentsMode } from './stream.ts'

const WEAVER = 'https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/source.m3u8'
const SEGMENT = 'https://d1m7jfoe9zdc1j.cloudfront.net/v1/segment/live-1000.ts'

const relays: Relay[] = []
afterAll(() => {
  for (const relay of relays) relay.close()
})

function origin(): Origin {
  return {
    master: parseMaster(TWITCH_MASTER, WEAVER),
    upstream: () => ({ load: async () => ({ ok: true, text: twitchLive(1000, 5), url: WEAVER, twitch: true }) }),
    vod: false,
  }
}

function handler(segments: SegmentsMode, extra: Partial<RelayHandlerDeps> = {}) {
  const relay = new Relay(180, { segments })
  relays.push(relay)
  return createRelayHandler({
    relay,
    health: () => ({ ok: true, version: 1, platforms: ['twitch'] }),
    source: (src) => (src === 'https://www.twitch.tv/shroud' ? { key: src, open: async () => origin() } : null),
    ...extra,
  })
}

const get = (h: ReturnType<typeof handler>, path: string) =>
  h.fetch(new Request(`https://regie-extension.invalid${path}`))

/** Opens the source and returns the first variant's media playlist. */
async function firstMedia(h: ReturnType<typeof handler>, key = ''): Promise<string> {
  const query = key ? `&key=${key}` : ''
  const master = await get(h, `/play.m3u8?src=${encodeURIComponent('https://www.twitch.tv/shroud')}${query}`)
  expect(master.status).toBe(200)
  const variant = (await master.text()).split('\n').find((line) => line.startsWith('/v/'))
  if (!variant) throw new Error('no variant')
  const media = await get(h, variant)
  expect(media.status).toBe(200)
  expect(media.headers.get('X-Regie-Ad')).toBe('0')
  return media.text()
}

describe('portable handler', () => {
  test('direct mode: media playlists keep the upstream segment URLs', async () => {
    const body = await firstMedia(handler('direct'))
    const uris = body.split('\n').filter((line) => line && !line.startsWith('#'))
    expect(uris).toHaveLength(5)
    expect(uris[0]).toBe(SEGMENT)
    expect(body).not.toContain('/s/')
  })

  test('direct mode: segment URLs never carry the key, and /s/ is 404 without a segment host', async () => {
    const h = handler('direct', { key: 'secret' })
    const body = await firstMedia(h, 'secret')
    expect(body).not.toContain('key=')
    expect((await get(h, '/s/abc/def.ts?key=secret')).status).toBe(404)
  })

  test('opaque mode is unchanged: only /s/ ids, with the key', async () => {
    const body = await firstMedia(handler('opaque', { key: 'k' }), 'k')
    const uris = body.split('\n').filter((line) => line && !line.startsWith('#'))
    expect(uris).toHaveLength(5)
    expect(uris.every((uri) => /^\/s\/[a-z0-9]+\/[a-z0-9]+\.ts\?key=k$/.test(uri))).toBe(true)
    expect(body).not.toContain('cloudfront')
  })

  test('a source the host refuses is 400; health is the host body', async () => {
    const h = handler('direct')
    expect((await get(h, `/play.m3u8?src=${encodeURIComponent('https://kick.com/xqc')}`)).status).toBe(400)
    const health = await get(h, '/health')
    expect(health.headers.get('Content-Type')).toBe('application/json')
    expect(await health.json()).toEqual({ ok: true, version: 1, platforms: ['twitch'] })
    expect((await get(h, '/nope')).status).toBe(404)
  })

  test('the server reports what it plays: Twitch, Kick and YouTube videos always, YouTube lives with yt-dlp', async () => {
    const server = createHandler(configFromEnv({}))
    relays.push(server.relay)
    const body = await (await server.fetch(new Request('http://127.0.0.1:7878/health'))).json()
    expect(body.platforms).toEqual(['twitch', 'youtube', 'kick'])
    expect(body.youtubeVideos).toBe(true)
    expect(body.youtubeLive).toBe(body.ytdlp !== null)
  })
})
