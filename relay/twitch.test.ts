import { beforeEach, describe, expect, test } from 'bun:test'
import { TWITCH_MASTER, twitchLive } from './fixtures.ts'
import { FAILED_TTL_MS, TWITCH_CLIENT_ID, Twitch, type TwitchLiveVariant } from './twitch.ts'

type Call = { url: string; init?: RequestInit & { proxy?: string } }

/** A fake Twitch: tokens carry their player type, platform and route; weaver URLs say which stream they are. */
function fakeTwitch(hasAd: (stream: string) => boolean) {
  const calls: Call[] = []
  let seq = 1000
  const fetch = async (url: string, init?: RequestInit & { proxy?: string }) => {
    calls.push({ url, init })
    const route = init?.proxy ? 'proxy' : 'direct'
    if (url === 'https://gql.twitch.tv/gql') {
      const { variables } = JSON.parse(String(init?.body))
      const value = JSON.stringify({ stream: `${variables.playerType}.${variables.platform}.${route}` })
      return Response.json({ data: { streamPlaybackAccessToken: { value, signature: 'sig', authorization: {} } } })
    }
    if (url.startsWith('https://usher.ttvnw.net/')) {
      const { stream } = JSON.parse(new URL(url).searchParams.get('token') ?? '{}')
      return new Response(TWITCH_MASTER.replaceAll('video-weaver.fra05.hls.ttvnw.net', `weaver.test/${stream}`))
    }
    const stream = /weaver\.test\/([^/]+)\//.exec(url)?.[1]
    if (stream) {
      seq += 1
      return new Response(twitchLive(seq, 4, { ad: hasAd(stream) ? [seq + 3] : [] }))
    }
    return new Response('not found', { status: 404 })
  }
  const streamOf = (call: Call) => /weaver\.test\/([^/]+)\//.exec(call.url)?.[1]
  const tokens = () =>
    calls.filter((call) => call.url.includes('gql')).map((call) => JSON.parse(String(call.init?.body)))
  return { fetch, calls, streamOf, tokens }
}

async function variant(twitch: Twitch) {
  const origin = await twitch.live('somechannel')
  const entry = origin.master.entries[0]
  if (!entry) throw new Error('no variant')
  return origin.upstream(entry) as TwitchLiveVariant
}

describe('anonymous token and usher', () => {
  test('the token request carries no account: public client id, random device id, no Authorization', async () => {
    const fake = fakeTwitch(() => false)
    const twitch = new Twitch({ fetch: fake.fetch })
    await twitch.live('somechannel')
    const gql = fake.calls[0]
    const headers = new Headers(gql?.init?.headers)
    expect(headers.get('Client-ID')).toBe(TWITCH_CLIENT_ID)
    expect(headers.get('Device-ID')).toMatch(/^[a-z0-9]{32}$/)
    expect(headers.has('Authorization')).toBe(false)
    expect(headers.has('Cookie')).toBe(false)
    expect(fake.tokens()[0].variables).toMatchObject({ login: 'somechannel', playerType: 'popout', platform: 'web' })
    const usher = new URL(fake.calls[1]?.url ?? '')
    expect(usher.pathname).toBe('/api/channel/hls/somechannel.m3u8')
    expect(usher.searchParams.get('play_session_id')).toMatch(/^[a-z0-9]{32}$/)
    expect(Number(usher.searchParams.get('p'))).toBeLessThan(10_000_000)
    expect(usher.searchParams.get('allow_source')).toBe('true')
  })

  test('the main stream player type can be changed; autoplay uses the android platform', async () => {
    for (const [playerType, platform] of [
      ['embed', 'web'],
      ['autoplay', 'android'],
    ]) {
      const fake = fakeTwitch(() => false)
      await new Twitch({ fetch: fake.fetch, playerType }).live('somechannel')
      expect(fake.tokens()[0].variables).toMatchObject({ playerType, platform })
    }
  })

  test('the ad path logs one line per step', async () => {
    let primaryAd = true
    const lines: string[] = []
    const fake = fakeTwitch((stream) => (stream.startsWith('embed') ? primaryAd : stream.startsWith('site')))
    const upstream = await variant(
      new Twitch({ fetch: fake.fetch, playerType: 'embed', log: (line) => lines.push(line) }),
    )
    await upstream.load()
    await upstream.load()
    primaryAd = false
    await upstream.load()
    expect(lines).toEqual([
      'twitch somechannel 1080p60 (source): ad on primary (embed/web)',
      'twitch somechannel 1080p60 (source): probe site/web → ad',
      'twitch somechannel 1080p60 (source): probe popout/web → clean (1080p60 (source))',
      'twitch somechannel 1080p60 (source): serving backup popout/web',
      'twitch somechannel 1080p60 (source): primary clean, back to primary',
    ])
  })

  test('usher 404 means offline', async () => {
    const twitch = new Twitch({
      fetch: async (url) =>
        url.includes('gql')
          ? Response.json({ data: { streamPlaybackAccessToken: { value: '{}', signature: 's' } } })
          : new Response('', { status: 404 }),
    })
    await expect(twitch.live('offline')).rejects.toMatchObject({ status: 404 })
  })

  test('TWITCH_PROXY is used for token, usher and playlists of the primary only; backups go direct', async () => {
    const fake = fakeTwitch((stream) => stream.startsWith('popout.web'))
    const twitch = new Twitch({ fetch: fake.fetch, proxy: 'http://proxy.test:3128' })
    const upstream = await variant(twitch)
    await upstream.load()
    const primary = fake.calls.filter((call) => call.init?.proxy)
    expect(primary.map((call) => new URL(call.url).hostname)).toEqual([
      'gql.twitch.tv',
      'usher.ttvnw.net',
      'weaver.test',
    ])
    expect(primary.every((call) => call.init?.proxy === 'http://proxy.test:3128')).toBe(true)
    // The first backup (site) went direct and won.
    expect(fake.streamOf(fake.calls.at(-1) as Call)).toBe('site.web.direct')
  })

  test('without TWITCH_PROXY nothing is proxied', async () => {
    const fake = fakeTwitch((stream) => stream.startsWith('popout'))
    const upstream = await variant(new Twitch({ fetch: fake.fetch }))
    await upstream.load()
    expect(fake.calls.some((call) => call.init?.proxy)).toBe(false)
  })
})

describe('ad replacement', () => {
  let now = 0
  beforeEach(() => {
    now = 1_000_000
  })

  test('backups are probed in order; the first clean one is served and pinned for the next break', async () => {
    const fake = fakeTwitch((stream) => stream.startsWith('popout') || stream.startsWith('site'))
    const twitch = new Twitch({ fetch: fake.fetch, now: () => now })
    const upstream = await variant(twitch)
    const loaded = await upstream.load()
    expect(loaded).toMatchObject({ ok: true, switched: true })
    if (!loaded.ok) throw new Error('load failed')
    expect(loaded.url).toContain('mobile_web.web.direct')
    expect(fake.tokens().map((token) => token.variables.playerType)).toEqual(['popout', 'site', 'popout', 'mobile_web'])
    expect(twitch.pins.get('somechannel')).toBe('mobile_web')
    expect(upstream.onBackup).toBe(true)

    // Next poll, still in the break: the backup is kept, no new token.
    const tokensBefore = fake.tokens().length
    const again = await upstream.load()
    expect(again).toMatchObject({ ok: true, switched: false })
    expect(fake.tokens()).toHaveLength(tokensBefore)

    // Next break on a new variant: the pinned type goes first.
    now += FAILED_TTL_MS + 1
    const other = await variant(twitch)
    fake.calls.length = 0
    await other.load()
    expect(fake.tokens().map((token) => token.variables.playerType)).toEqual(['mobile_web'])
  })

  test('the primary comes back as soon as it is clean, with a discontinuity', async () => {
    let primaryAd = true
    const fake = fakeTwitch((stream) => (stream.startsWith('popout') ? primaryAd : false))
    const upstream = await variant(new Twitch({ fetch: fake.fetch, now: () => now }))
    expect(await upstream.load()).toMatchObject({ switched: true })
    primaryAd = false
    const back = await upstream.load()
    expect(back).toMatchObject({ ok: true, switched: true })
    if (!back.ok) throw new Error('load failed')
    expect(back.url).toContain('popout.web.direct')
    expect(upstream.onBackup).toBe(false)
  })

  test('android autoplay is the last resort, then stripping; failed types rest 15 s', async () => {
    let autoplayAd = false
    const fake = fakeTwitch((stream) => !stream.startsWith('autoplay') || autoplayAd)
    const twitch = new Twitch({ fetch: fake.fetch, now: () => now })
    const upstream = await variant(twitch)

    const lastResort = await upstream.load()
    expect(fake.tokens().map((token) => [token.variables.playerType, token.variables.platform])).toEqual([
      ['popout', 'web'],
      ['site', 'web'],
      ['popout', 'web'],
      ['mobile_web', 'web'],
      ['embed', 'web'],
      ['autoplay', 'android'],
    ])
    if (!lastResort.ok) throw new Error('load failed')
    expect(lastResort.url).toContain('autoplay.android')
    expect(twitch.pins.has('somechannel')).toBe(false)

    // Autoplay gets ads too: every type is resting, so the primary is served and its ads stripped.
    autoplayAd = true
    const stripped = await upstream.load()
    expect(stripped).toMatchObject({ ok: true, switched: true, twitch: true })
    if (!stripped.ok) throw new Error('load failed')
    expect(stripped.url).toContain('popout.web.direct')
    expect(stripped.text).toContain('Amazon')
    expect(upstream.onBackup).toBe(false)

    // Within 15 s: no new probes, only the primary playlist.
    fake.calls.length = 0
    await upstream.load()
    expect(fake.tokens()).toHaveLength(0)
    expect(fake.calls).toHaveLength(1)

    // After 15 s the backups are tried again.
    now += FAILED_TTL_MS + 1
    fake.calls.length = 0
    await upstream.load()
    expect(fake.tokens().map((token) => token.variables.playerType)).toEqual([
      'site',
      'popout',
      'mobile_web',
      'embed',
      'autoplay',
    ])
  })
})
