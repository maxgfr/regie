import { describe, expect, test } from 'bun:test'
import { capabilities } from '../platforms/parse.ts'
import {
  healthUrl,
  normalizeRelayBase,
  parseHealth,
  pickRelay,
  type RelayHealth,
  relayable,
  relayUrl,
} from './relay.ts'

describe('relay', () => {
  test('only Twitch, YouTube and Kick go through the relay', () => {
    expect(relayable({ platform: 'twitch', kind: 'live', id: 'shroud' })).toBe(true)
    expect(relayable({ platform: 'twitch', kind: 'vod', id: '123' })).toBe(true)
    expect(relayable({ platform: 'twitch', kind: 'clip', id: 'Funny' })).toBe(false)
    expect(relayable({ platform: 'youtube', kind: 'live', id: 'UCxxxxxxxxxxxxxxxxxxxxxx' })).toBe(true)
    expect(relayable({ platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' })).toBe(true)
    expect(relayable({ platform: 'kick', kind: 'live', id: 'xqc' })).toBe(true)
    expect(relayable({ platform: 'vimeo', kind: 'vod', id: '1' })).toBe(false)
    expect(relayable({ platform: 'video', kind: 'live', id: 'https://example.com/a.m3u8' })).toBe(false)
    expect(relayable({ platform: 'tiktok', kind: 'unembeddable', id: 'https://tiktok.com/@a/live' })).toBe(false)
  })

  test('YouTube videos need a relay that can remux them', () => {
    expect(relayable({ platform: 'youtube', kind: 'vod', id: 'dQw4w9WgXcQ' }, false)).toBe(false)
    expect(relayable({ platform: 'youtube', kind: 'live', id: 'dQw4w9WgXcQ' }, false)).toBe(true)
  })

  test('a relay that lists its platforms only gets those', () => {
    const twitch = { platform: 'twitch' as const, kind: 'live' as const, id: 'shroud' }
    const kick = { platform: 'kick' as const, kind: 'live' as const, id: 'xqc' }
    expect(relayable(kick, true, ['twitch'])).toBe(false)
    expect(relayable(twitch, true, ['twitch'])).toBe(true)
    expect(relayable({ platform: 'twitch', kind: 'clip', id: 'Funny' }, true, ['twitch'])).toBe(false)
    expect(relayable(kick, true, null)).toBe(true)
    expect(relayable(kick, true, [])).toBe(false)
  })

  test('the server relay wins when it is up; the extension takes the Twitch tiles otherwise', () => {
    const twitch = { platform: 'twitch' as const, kind: 'live' as const, id: 'shroud' }
    const kick = { platform: 'kick' as const, kind: 'live' as const, id: 'xqc' }
    const clip = { platform: 'twitch' as const, kind: 'clip' as const, id: 'Funny' }
    const server: RelayHealth = { ytdlp: '2026.10.26', ffmpeg: '7.1', platforms: null }
    const extension: RelayHealth = { ytdlp: null, ffmpeg: null, platforms: ['twitch'] }
    expect(pickRelay(twitch, { server, extension })).toBe('server')
    expect(pickRelay(kick, { server, extension })).toBe('server')
    expect(pickRelay(twitch, { server: null, extension })).toBe('extension')
    expect(pickRelay(kick, { server: null, extension })).toBeNull()
    expect(pickRelay(clip, { server: null, extension })).toBeNull()
    expect(pickRelay(twitch, { server: null, extension: null })).toBeNull()
    // A server that doesn't play Twitch leaves it to the extension.
    expect(pickRelay(twitch, { server: { ...server, platforms: ['youtube'] }, extension })).toBe('extension')
    // An extension that doesn't list its platforms is still Twitch only.
    expect(pickRelay(kick, { server: null, extension: { ...extension, platforms: null } })).toBeNull()
    expect(pickRelay(twitch, { server: null, extension: { ...extension, platforms: null } })).toBe('extension')
  })

  test('an extension that plays Kick and YouTube videos takes them; YouTube lives keep their embed', () => {
    const kick = { platform: 'kick' as const, kind: 'live' as const, id: 'westcol' }
    const video = { platform: 'youtube' as const, kind: 'vod' as const, id: 'dQw4w9WgXcQ' }
    const live = { platform: 'youtube' as const, kind: 'live' as const, id: '4xDzrJKXOOY' }
    const extension: RelayHealth = {
      ytdlp: null,
      ffmpeg: null,
      platforms: ['twitch', 'kick', 'youtube'],
      youtubeVideos: true,
      youtubeLive: false,
    }
    expect(pickRelay(kick, { server: null, extension })).toBe('extension')
    expect(pickRelay(video, { server: null, extension })).toBe('extension')
    expect(pickRelay(live, { server: null, extension })).toBeNull()
    // The server, through yt-dlp, plays YouTube lives; videos only with ffmpeg, as before.
    const server: RelayHealth = { ytdlp: '2026.10.26', ffmpeg: null, platforms: null }
    expect(pickRelay(live, { server, extension })).toBe('server')
    expect(pickRelay(video, { server, extension })).toBe('extension')
    expect(parseHealth({ ok: true, platforms: ['kick'], youtubeVideos: true, youtubeLive: false })).toEqual({
      ytdlp: null,
      ffmpeg: null,
      platforms: ['kick'],
      youtubeVideos: true,
      youtubeLive: false,
    })
  })

  test('the typed address is cleaned', () => {
    expect(normalizeRelayBase('')).toBe('')
    expect(normalizeRelayBase('  ')).toBe('')
    expect(normalizeRelayBase('localhost:7878')).toBe('http://localhost:7878')
    expect(normalizeRelayBase('http://localhost:7878/')).toBe('http://localhost:7878')
    expect(normalizeRelayBase('https://relay.example.com/regie/?x=1#y')).toBe('https://relay.example.com/regie')
    expect(normalizeRelayBase('ftp://example.com')).toBeNull()
    expect(normalizeRelayBase('http://user:pw@example.com')).toBeNull()
    expect(normalizeRelayBase('http://exa mple.com')).toBeNull()
  })

  test('playlist and health addresses carry the source and the key', () => {
    const source = { platform: 'twitch' as const, kind: 'live' as const, id: 'shroud' }
    expect(relayUrl('http://localhost:7878/', '', source)).toBe(
      'http://localhost:7878/play.m3u8?src=https%3A%2F%2Fwww.twitch.tv%2Fshroud',
    )
    expect(relayUrl('http://localhost:7878', 'a b&c', source)).toBe(
      'http://localhost:7878/play.m3u8?src=https%3A%2F%2Fwww.twitch.tv%2Fshroud&key=a%20b%26c',
    )
    expect(healthUrl('http://localhost:7878/', '')).toBe('http://localhost:7878/health')
    expect(healthUrl('http://localhost:7878', 'k')).toBe('http://localhost:7878/health?key=k')
  })

  test('a health answer is read defensively', () => {
    expect(parseHealth({ ok: true, version: 1, ytdlp: '2026.10.26', ffmpeg: '7.1' })).toEqual({
      ytdlp: '2026.10.26',
      ffmpeg: '7.1',
      platforms: null,
    })
    expect(parseHealth({ ok: true, ytdlp: null })).toEqual({ ytdlp: null, ffmpeg: null, platforms: null })
    expect(parseHealth({ ok: true, platforms: ['twitch', 'vimeo', 3, 'kick'] })?.platforms).toEqual(['twitch', 'kick'])
    expect(parseHealth({ ok: true, platforms: 'twitch' })?.platforms).toBeNull()
    expect(parseHealth({ ok: true, platforms: [] })?.platforms).toEqual([])
    expect(parseHealth({ ok: false })).toBeNull()
    expect(parseHealth('ok')).toBeNull()
    expect(parseHealth(null)).toBeNull()
  })

  test('a relayed stream gets full sound and seek, and keeps its chat', () => {
    const live = { platform: 'kick' as const, kind: 'live' as const, id: 'xqc' }
    expect(capabilities(live)).toMatchObject({ volume: false, seek: false, latency: false, chat: true })
    expect(capabilities(live, true)).toMatchObject({ volume: true, mute: true, seek: true, latency: true, chat: true })
    const twitch = { platform: 'twitch' as const, kind: 'live' as const, id: 'shroud' }
    expect(capabilities(twitch, true)).toMatchObject({ seek: true, liveChat: true })
    expect(capabilities({ platform: 'twitch', kind: 'vod', id: '1' }, true).latency).toBe(false)
  })
})
