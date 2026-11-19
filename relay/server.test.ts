import { afterAll, describe, expect, test } from 'bun:test'
import { canonicalize } from './resolve.ts'
import { configFromEnv, createHandler, publicHttp, twitchPlayerType } from './server.ts'

const keyed = createHandler(configFromEnv({ RELAY_KEY: 'secret' }))
const open = createHandler(configFromEnv({}))
afterAll(() => {
  keyed.relay.close()
  open.relay.close()
})

const get = (handler: typeof open, path: string, headers: Record<string, string> = {}) =>
  handler.fetch(new Request(`http://127.0.0.1:7878${path}`, { headers }))

describe('sources', () => {
  test.each([
    ['https://www.twitch.tv/Zackrawrr', 'https://www.twitch.tv/zackrawrr'],
    ['https://www.twitch.tv/videos/2345678901', 'https://www.twitch.tv/videos/2345678901'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    [
      'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live',
      'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live',
    ],
    ['https://kick.com/Eray', 'https://kick.com/eray'],
    [
      'https://kick.com/eray/videos/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7',
      'https://kick.com/eray/videos/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7',
    ],
  ])('%s is relayed as %s', (input, page) => {
    expect(canonicalize(input)?.page).toBe(page)
  })

  test.each([
    'https://example.com/x',
    'https://example.com/live.m3u8',
    'http://127.0.0.1:22/',
    'file:///etc/passwd',
    'https://clips.twitch.tv/SomeClipSlug',
    'https://www.tiktok.com/@a/video/1234567890123',
    'https://vimeo.com/123456',
    '',
  ])('%s is refused', (input) => {
    expect(canonicalize(input)).toBeNull()
  })
})

describe('HTTP contract', () => {
  test('health', async () => {
    const response = await get(open, '/health', { Origin: 'https://maxgfr.github.io' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://maxgfr.github.io')
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Regie-Ad')
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, version: 1 })
    expect('ytdlp' in body && 'ffmpeg' in body).toBe(true)
  })

  test('CORS only for listed origins', async () => {
    const response = await get(open, '/health', { Origin: 'https://evil.example' })
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('preflight answers private network access without a key', async () => {
    const response = await keyed.fetch(
      new Request('http://127.0.0.1:7878/play.m3u8', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Private-Network': 'true' },
      }),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Private-Network')).toBe('true')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET')
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Range')
  })

  test('RELAY_KEY: every route needs ?key=, errors keep CORS', async () => {
    const missing = await get(keyed, '/health', { Origin: 'https://maxgfr.github.io' })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('Access-Control-Allow-Origin')).toBe('https://maxgfr.github.io')
    expect((await get(keyed, '/health?key=wrong')).status).toBe(401)
    expect((await get(keyed, '/s/abc/def')).status).toBe(401)
    expect((await get(keyed, '/health?key=secret')).status).toBe(200)
  })

  test('unsupported sources are 400, unknown ids 404', async () => {
    expect((await get(open, `/play.m3u8?src=${encodeURIComponent('https://example.com/x')}`)).status).toBe(400)
    expect((await get(open, '/play.m3u8')).status).toBe(400)
    expect((await get(open, '/v/abc/def.m3u8')).status).toBe(404)
    expect((await get(open, '/s/abc/def.ts')).status).toBe(404)
    expect((await get(open, '/s/abc/..%2F..%2Fetc%2Fpasswd')).status).toBe(404)
  })
})

describe('segment targets', () => {
  test.each([
    ['https://d1m7jfoe9zdc1j.cloudfront.net/v1/segment/x.ts', true],
    ['https://rr2---sn-i5heen7z.googlevideo.com/videoplayback/x', true],
    ['http://127.0.0.1:7878/health', false],
    ['http://192.168.1.1/', false],
    ['http://10.0.0.8/x.ts', false],
    ['http://[::1]/x.ts', false],
    ['http://localhost/x.ts', false],
    ['file:///etc/passwd', false],
  ])('%s → %p', (url, allowed) => {
    expect(publicHttp(url)).toBe(allowed)
  })
})

describe('TWITCH_PLAYER_TYPE', () => {
  test('defaults to popout, accepts the known types, warns on anything else', () => {
    const warnings: string[] = []
    const warn = (message: string) => warnings.push(message)
    expect(twitchPlayerType(undefined, warn)).toBe('popout')
    expect(twitchPlayerType('embed', warn)).toBe('embed')
    expect(twitchPlayerType(' site ', warn)).toBe('site')
    expect(warnings).toHaveLength(0)
    expect(twitchPlayerType('frontpage', warn)).toBe('popout')
    expect(warnings).toHaveLength(1)
    expect(configFromEnv({ TWITCH_PLAYER_TYPE: 'mobile_web' }).twitchPlayerType).toBe('mobile_web')
  })
})
