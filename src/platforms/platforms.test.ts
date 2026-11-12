import { describe, expect, test } from 'bun:test'
import { chatUrl, embedUrl } from './embed.ts'
import { capabilities, parseSource, parseStart } from './parse.ts'

describe('parseSource', () => {
  const cases: [string, unknown][] = [
    ['shroud', { platform: 'twitch', kind: 'live', id: 'shroud' }],
    ['https://www.twitch.tv/Kamet0', { platform: 'twitch', kind: 'live', id: 'kamet0' }],
    ['twitch.tv/videos/2245?t=1h2m3s', { platform: 'twitch', kind: 'vod', id: '2245', start: 3723 }],
    ['https://clips.twitch.tv/FunnyClipSlug', { platform: 'twitch', kind: 'clip', id: 'FunnyClipSlug' }],
    ['https://www.twitch.tv/x/clip/Slug-abc', { platform: 'twitch', kind: 'clip', id: 'Slug-abc' }],
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42',
      { platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ', start: 42 },
    ],
    ['https://youtu.be/dQw4w9WgXcQ', { platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/live/jfKfPfyJRdk', { platform: 'youtube', kind: 'live', id: 'jfKfPfyJRdk' }],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', { platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' }],
    [
      'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow',
      { platform: 'youtube', kind: 'live', id: 'UCSJ4gkVC6NrvII8umztf0Ow' },
    ],
    ['https://kick.com/xQc', { platform: 'kick', kind: 'live', id: 'xqc' }],
    ['kick:trainwreckstv', { platform: 'kick', kind: 'live', id: 'trainwreckstv' }],
    [
      'https://www.tiktok.com/@scout2015/video/6718335390845095173',
      { platform: 'tiktok', kind: 'post', id: '6718335390845095173' },
    ],
    [
      'https://www.tiktok.com/@someone/live',
      { platform: 'tiktok', kind: 'unembeddable', id: 'https://www.tiktok.com/@someone/live' },
    ],
    ['https://vimeo.com/76979871', { platform: 'vimeo', kind: 'vod', id: '76979871' }],
    ['https://www.dailymotion.com/video/x8abcd', { platform: 'dailymotion', kind: 'vod', id: 'x8abcd' }],
    [
      'https://cdn.example.com/live/index.m3u8',
      { platform: 'video', kind: 'live', id: 'https://cdn.example.com/live/index.m3u8' },
    ],
    ['https://example.com/embed/thing', { platform: 'iframe', kind: 'live', id: 'https://example.com/embed/thing' }],
  ]
  for (const [input, expected] of cases) test(input, () => expect(parseSource(input)).toEqual(expected as never))

  test('rejects what it cannot play', () => {
    expect(parseSource('')).toBeNull()
    expect(parseSource('javascript:alert(1)')).toBeNull()
    expect(parseSource('http://example.com/page')).toBeNull()
    expect(parseSource('https://www.youtube.com/watch?v=short')).toBeNull()
  })

  test('parseStart', () => {
    expect(parseStart('90')).toBe(90)
    expect(parseStart('1m30s')).toBe(90)
    expect(parseStart('nope')).toBeUndefined()
  })
})

describe('embedUrl', () => {
  const options = { host: 'maxgfr.github.io', muted: true }

  test('Twitch needs the parent domain', () => {
    const url = new URL(embedUrl({ platform: 'twitch', kind: 'live', id: 'shroud' }, options) ?? '')
    expect(url.origin).toBe('https://player.twitch.tv')
    expect(url.searchParams.get('parent')).toBe('maxgfr.github.io')
    expect(url.searchParams.get('channel')).toBe('shroud')
    expect(url.searchParams.get('muted')).toBe('true')
  })

  test('Twitch VODs start where asked', () => {
    const url = new URL(embedUrl({ platform: 'twitch', kind: 'vod', id: '123', start: 60 }, options) ?? '')
    expect(url.searchParams.get('video')).toBe('v123')
    expect(url.searchParams.get('time')).toBe('60s')
  })

  test('YouTube uses the privacy-enhanced domain with the JS API on', () => {
    const url = new URL(embedUrl({ platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' }, options) ?? '')
    expect(url.hostname).toBe('www.youtube-nocookie.com')
    expect(url.searchParams.get('enablejsapi')).toBe('1')
    const live = embedUrl({ platform: 'youtube', kind: 'live', id: 'UCSJ4gkVC6NrvII8umztf0Ow' }, options)
    expect(live).toContain('/embed/live_stream?')
    expect(live).toContain('channel=UCSJ4gkVC6NrvII8umztf0Ow')
  })

  test('TikTok LIVE and direct video have no iframe', () => {
    expect(
      embedUrl({ platform: 'tiktok', kind: 'unembeddable', id: 'https://www.tiktok.com/@a/live' }, options),
    ).toBeNull()
    expect(embedUrl({ platform: 'video', kind: 'vod', id: 'https://a.b/c.mp4' }, options)).toBeNull()
  })

  test('chat iframes carry the embedding domain', () => {
    expect(chatUrl({ platform: 'twitch', kind: 'live', id: 'shroud' }, 'maxgfr.github.io')).toBe(
      'https://www.twitch.tv/embed/shroud/chat?parent=maxgfr.github.io&darkpopout',
    )
    expect(chatUrl({ platform: 'youtube', kind: 'live', id: 'jfKfPfyJRdk' }, 'maxgfr.github.io')).toContain(
      'embed_domain=maxgfr.github.io',
    )
    expect(chatUrl({ platform: 'twitch', kind: 'vod', id: '1' }, 'h')).toBeNull()
  })
})

describe('capabilities', () => {
  test('only seekable streams can be delayed', () => {
    expect(capabilities({ platform: 'twitch', kind: 'live', id: 'a' }).seek).toBe(false)
    expect(capabilities({ platform: 'twitch', kind: 'vod', id: '1' }).seek).toBe(true)
    expect(capabilities({ platform: 'youtube', kind: 'live', id: 'jfKfPfyJRdk' }).seek).toBe(true)
    expect(capabilities({ platform: 'kick', kind: 'live', id: 'a' }).volume).toBe(false)
  })
})
