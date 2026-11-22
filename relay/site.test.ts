import { describe, expect, test } from 'bun:test'
import { TWITCH_MASTER, twitchLive } from './fixtures.ts'
import { parseMedia } from './playlist.ts'
import { TwitchSite, usherLogin } from './site.ts'
import { Twitch } from './twitch.ts'

const SITE_MASTER_URL = 'https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8?acmb=x&sig=s&token=t'
const SOURCE = 'https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/source.m3u8'

/**
 * Twitch as the site's player sees it: its own weaver playlists (`primary`), and the backup streams the engine
 * finds with anonymous tokens, whose weaver URLs say their player type. `ads(stream)` says which have an ad.
 */
function fakeTwitch(ads: (stream: string) => boolean) {
  let seq = 1000
  const requests: string[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push(url)
    if (url === 'https://gql.twitch.tv/gql') {
      const { variables } = JSON.parse(String(init?.body))
      const value = JSON.stringify({ stream: `${variables.playerType}.${variables.platform}` })
      return Response.json({ data: { streamPlaybackAccessToken: { value, signature: 'sig', authorization: {} } } })
    }
    if (url.startsWith('https://usher.ttvnw.net/')) {
      const { stream } = JSON.parse(new URL(url).searchParams.get('token') ?? '{}')
      return new Response(TWITCH_MASTER.replaceAll('video-weaver.fra05.hls.ttvnw.net', `weaver.test/${stream}`))
    }
    const stream = url.startsWith('https://video-weaver.fra05') ? 'primary' : /weaver\.test\/([^/]+)\//.exec(url)?.[1]
    if (stream) {
      seq += 1
      const ad = ads(stream) ? [seq + 2, seq + 3] : []
      return new Response(twitchLive(seq, 4, { ad, prefetch: true }))
    }
    return new Response('not found', { status: 404 })
  }
  return { fetch, requests }
}

function site(ads: (stream: string) => boolean) {
  const fake = fakeTwitch(ads)
  const twitch = new Twitch({ fetch: fake.fetch })
  const result = new TwitchSite(twitch)
  result.master(SITE_MASTER_URL, TWITCH_MASTER)
  return { site: result, fake }
}

describe('usher masters of the site player', () => {
  test('live masters, old and v2 paths, name their channel; VODs and the rest do not', () => {
    expect(usherLogin(SITE_MASTER_URL)).toBe('somechannel')
    expect(usherLogin('https://usher.ttvnw.net/api/channel/hls/Some_Channel.m3u8?sig=a')).toBe('some_channel')
    expect(usherLogin('https://usher.ttvnw.net/vod/123456.m3u8?sig=a')).toBeNull()
    expect(usherLogin('https://gql.twitch.tv/gql')).toBeNull()
    expect(usherLogin(SOURCE)).toBeNull()
  })

  test('the variants of a master seen are known, with or without a query; nothing else is', () => {
    const { site: s } = site(() => false)
    expect(s.knows(SOURCE)).toBe(true)
    expect(s.knows(`${SOURCE}?x=1`)).toBe(true)
    expect(s.knows('https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/other.m3u8')).toBe(false)
  })

  test('a master from anything but usher live registers nothing', () => {
    const fake = fakeTwitch(() => false)
    const s = new TwitchSite(new Twitch({ fetch: fake.fetch }))
    s.master('https://usher.ttvnw.net/vod/1.m3u8', TWITCH_MASTER)
    expect(s.knows(SOURCE)).toBe(false)
  })
})

describe('media playlists of the site player', () => {
  test('without an ad: the same segments and sequence, and the prefetch kept for low latency', async () => {
    const { site: s, fake } = site(() => false)
    const answer = await s.media(SOURCE)
    expect(answer?.status).toBe(200)
    const media = parseMedia(answer?.body ?? '', SOURCE)
    expect(media.mediaSequence).toBe(1001)
    expect(media.segments.map((segment) => segment.url.split('/').at(-1))).toEqual([
      'live-1001.ts',
      'live-1002.ts',
      'live-1003.ts',
      'live-1004.ts',
    ])
    expect(answer?.body).toContain(
      '#EXT-X-TWITCH-PREFETCH:https://d1m7jfoe9zdc1j.cloudfront.net/v1/segment/live-1005.ts',
    )
    // No token asked: nothing but the player's own playlist was fetched.
    expect(fake.requests).toEqual([SOURCE])
  })

  test('in an ad break: an ad-free backup of the same quality, without ad segments', async () => {
    const { site: s } = site((stream) => stream === 'primary')
    const answer = await s.media(SOURCE)
    expect(answer?.status).toBe(200)
    const body = answer?.body ?? ''
    expect(body).not.toContain('Amazon')
    expect(body).not.toContain('stitched-ad')
    const media = parseMedia(body, SOURCE, { twitch: true })
    expect(media.segments.length).toBeGreaterThan(0)
    expect(media.segments.every((segment) => !segment.ad)).toBe(true)
  })

  test('back from the break, the sequence keeps counting up', async () => {
    let inBreak = false
    const { site: s } = site((stream) => inBreak && stream === 'primary')
    const before = parseMedia((await s.media(SOURCE))?.body ?? '', SOURCE)
    inBreak = true
    const during = parseMedia((await s.media(SOURCE))?.body ?? '', SOURCE)
    inBreak = false
    const after = parseMedia((await s.media(SOURCE))?.body ?? '', SOURCE)
    const last = (media: typeof before) => media.mediaSequence + media.segments.length - 1
    expect(last(during)).toBeGreaterThan(last(before))
    expect(last(after)).toBeGreaterThan(last(during))
    expect(after.mediaSequence).toBeGreaterThanOrEqual(before.mediaSequence)
  })

  test('when every stream has the ad, its segments are cut', async () => {
    const { site: s } = site(() => true)
    const answer = await s.media(SOURCE)
    const media = parseMedia(answer?.body ?? '', SOURCE, { twitch: true })
    expect(media.segments.map((segment) => segment.url.split('/').at(-1))).toEqual(['live-1001.ts', 'live-1002.ts'])
  })

  test('a playlist that is only an ad, with nothing ad-free anywhere, is left to the player', async () => {
    const fake = fakeTwitch(() => true)
    // Every playlist is an ad from its first segment.
    const allAds = async (url: string, init?: RequestInit) => {
      const response = await fake.fetch(url, init)
      if (!url.includes('/v1/playlist/')) return response
      return new Response((await response.text()).replaceAll('#EXTINF:2.000,live', '#EXTINF:2.000,Amazon'))
    }
    const s = new TwitchSite(new Twitch({ fetch: allAds }))
    s.master(SITE_MASTER_URL, TWITCH_MASTER)
    expect(await s.media(SOURCE)).toBeNull()
  })

  test('an HEVC player never gets an H.264 backup: its decoder would fail, the ad is cut instead', async () => {
    const fake = fakeTwitch((stream) => stream === 'primary')
    const s = new TwitchSite(new Twitch({ fetch: fake.fetch }))
    // twitch.tv's player asked for HEVC and got it; the backups (the fixture master) are H.264 only.
    s.master(
      `${SITE_MASTER_URL}&supported_codecs=av1,h265,h264`,
      TWITCH_MASTER.replaceAll('avc1.64002A', 'hev1.1.6.L150.90').replaceAll('avc1.4D401F', 'hev1.1.6.L120.90'),
    )
    const media = parseMedia((await s.media(SOURCE))?.body ?? '', SOURCE, { twitch: true })
    expect(media.segments.map((segment) => segment.url.split('/').at(-1))).toEqual(['live-1001.ts', 'live-1002.ts'])
    const ushers = fake.requests.filter((url) => url.startsWith('https://usher.ttvnw.net/'))
    expect(ushers.length).toBeGreaterThan(0)
    expect(ushers.every((url) => new URL(url).searchParams.get('supported_codecs') === 'av1,h265,h264')).toBe(true)
  })

  test('a playlist that is not one of ours is not answered', async () => {
    const { site: s } = site(() => false)
    expect(await s.media('https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/other.m3u8')).toBeNull()
  })
})
