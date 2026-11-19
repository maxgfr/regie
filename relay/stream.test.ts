import { afterEach, describe, expect, test } from 'bun:test'
import { TWITCH_MASTER, TWITCH_VOD, twitchLive } from './fixtures.ts'
import { parseMaster } from './playlist.ts'
import { type Loaded, type Origin, Relay } from './stream.ts'

const WEAVER = 'https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/source.m3u8'

function origin(load: () => Loaded, vod = false): Origin & { closed: boolean } {
  const result = {
    master: parseMaster(TWITCH_MASTER, WEAVER),
    upstream: () => ({ load: async () => load() }),
    vod,
    closed: false,
    close: () => {
      result.closed = true
    },
  }
  return result
}

const relays: Relay[] = []
const relay = () => {
  const created = new Relay(180)
  relays.push(created)
  return created
}
afterEach(() => {
  for (const created of relays.splice(0)) created.close()
})

const ids = (master: string) => master.split('\n').filter((line) => line.startsWith('/v/'))

describe('relay streams', () => {
  test('master and media only expose opaque relay ids', async () => {
    const r = relay()
    const stream = await r.open('page', async () =>
      origin(() => ({ ok: true, text: twitchLive(1000, 5, { ad: [1004] }), url: WEAVER, twitch: true })),
    )
    const master = stream.master('?key=k')
    expect(master).not.toContain('ttvnw')
    const [variant] = ids(master)
    const [, , streamId, file] = variant?.split('/') ?? []
    const result = await r.media(streamId ?? '', file?.replace(/\.m3u8.*/, '') ?? '', '?key=k')
    if (result.status !== 200) throw new Error(`status ${result.status}`)
    expect(result.ad).toBe(true)
    const segments = result.body.split('\n').filter((line) => line.startsWith('/s/'))
    expect(segments).toHaveLength(4)
    expect(segments.every((line) => /^\/s\/[a-z0-9]+\/[a-z0-9]+\.ts\?key=k$/.test(line))).toBe(true)
    const segmentId = segments[0]?.split('/')[3]?.replace('?key=k', '') ?? ''
    expect(r.segment(streamId ?? '', segmentId)).toBe('https://d1m7jfoe9zdc1j.cloudfront.net/v1/segment/live-1000.ts')
    expect(r.segment(streamId ?? '', 'nope.ts')).toBeUndefined()
  })

  test('one open per source, shared by concurrent requests', async () => {
    const r = relay()
    let opens = 0
    const open = async () => {
      opens++
      await Bun.sleep(5)
      return origin(() => ({ ok: true, text: twitchLive(1000, 3), url: WEAVER }))
    }
    const [a, b] = await Promise.all([r.open('page', open), r.open('page', open)])
    expect(a).toBe(b)
    expect(opens).toBe(1)
  })

  test('VODs are served whole', async () => {
    const r = relay()
    const stream = await r.open('vod', async () => origin(() => ({ ok: true, text: TWITCH_VOD, url: WEAVER }), true))
    const variant = [...stream.variants.keys()][0] ?? ''
    const result = await r.media(stream.id, variant, '')
    if (result.status !== 200) throw new Error(`status ${result.status}`)
    expect(result.body).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(result.body).toContain('#EXT-X-ENDLIST')
    expect(result.body.split('\n').filter((line) => line.startsWith('/s/'))).toHaveLength(3)
  })

  test('an offline upstream is a 404; unknown ids too', async () => {
    const r = relay()
    const stream = await r.open('off', async () => origin(() => ({ ok: false, status: 404 })))
    const variant = [...stream.variants.keys()][0] ?? ''
    expect((await r.media(stream.id, variant, '')).status).toBe(404)
    expect((await r.media(stream.id, 'unknown', '')).status).toBe(404)
    expect((await r.media('unknown', variant, '')).status).toBe(404)
  })

  test('a stream nobody asks for is dropped after 60 s, and closed', async () => {
    const r = relay()
    const live = origin(() => ({ ok: true, text: twitchLive(1000, 3), url: WEAVER }))
    const stream = await r.open('page', async () => live)
    r.sweep(Date.now() + 30_000)
    expect(r.size).toBe(1)
    r.sweep(Date.now() + 61_000)
    expect(r.size).toBe(0)
    expect(live.closed).toBe(true)
    expect((await r.media(stream.id, [...stream.variants.keys()][0] ?? '', '')).status).toBe(404)
  })
})
